/**
 * Migration registration service — orchestrates ЕПГУ submission lifecycle.
 *
 * Responsibilities:
 *   1. enqueue: на CDC `booking_confirmed` создать row в migrationRegistration
 *      со status=0 (draft). RKL-проверка пройдена (или manual override).
 *   2. submit: cron picks status=0 → reserveOrder → pushArchive → status=17
 *   3. poll: cron picks non-final, nextPollAt ≤ now → getStatus → advance FSM
 *   4. retry: на error transient → schedule retry через computeNextPollAtMs
 *   5. finalize: на статус 3/4/10 → emit notification (CDC)
 *
 * Boundaries:
 *   * EpguTransport (mock or real) — invocation
 *   * RklCheckAdapter — pre-submit gate (block если match)
 *   * VisionOcrAdapter — passport scan endpoint (вызывается отдельно UI)
 *   * Hono routes — operator API (list/get/retry/cancel)
 *   * CDC consumer — auto-enqueue на booking confirmed (M8.A.5.fix.1)
 *
 * Mock vs Live behaviour identical — service использует ТОЛЬКО interface
 * `EpguTransport` / `RklCheckAdapter`. Swap = factory binding в registry.
 *
 * References:
 *   * plans/research/epgu-rkl.md
 *   * apps/backend/src/db/migrations/0035_migration_registration.sql
 *   * packages/shared/src/migration-registration.ts (FSM helpers)
 */
import {
	EPGU_STATUS_CODES,
	type EpguChannel,
	type EpguErrorCategory,
	isEpguFinalStatus,
} from '@horeca/shared'
import type { ArchiveBuilder } from '../archive/types.ts'
import type { RklCheckAdapter, RklCheckRequest } from '../rkl/types.ts'
import type { EpguTransport } from '../transport/types.ts'

export interface EnqueueRegistrationInput {
	readonly tenantId: string
	readonly bookingId: string
	readonly guestId: string
	readonly documentId: string
	readonly arrivalDate: string // YYYY-MM-DD
	readonly departureDate: string // YYYY-MM-DD
	readonly epguChannel: EpguChannel
	readonly serviceCode: string
	readonly targetCode: string
	readonly supplierGid: string
	readonly regionCode: string
	readonly actorId: string
}

export interface RegistrationServiceDeps {
	readonly transport: EpguTransport
	readonly rkl: RklCheckAdapter
	/** Persistence layer — wired в M8.A.5.repo. */
	readonly repo: RegistrationRepoOps
	/**
	 * Archive builder — wired в M8.A.5.archive. Behaviour-faithful Mock
	 * (`createMockArchiveBuilder`) для demo тенантов навсегда; real КриптоПро
	 * impl в M8.B при МВД ОВМ onboarding completion. Service exposes
	 * the dependency unmodified so callers (tests, future M8.A.6 UI flow)
	 * can build archives explicitly when needed.
	 */
	readonly archive: ArchiveBuilder
	readonly now?: () => Date
}

/**
 * Subset of repo methods the service depends on. Real impl backed by YDB
 * via apps/backend/src/domains/epgu/registration/registration.repo.ts;
 * test impl: in-memory Map<id, row>.
 *
 * NB: real repo is wired in a follow-up sub-phase (M8.A.5.repo). Service
 * is interface-only consumer — test против Map keeps service unit-testable.
 */
export interface RegistrationRepoOps {
	create(input: {
		readonly tenantId: string
		readonly id: string
		readonly bookingId: string
		readonly guestId: string
		readonly documentId: string
		readonly epguChannel: EpguChannel
		readonly serviceCode: string
		readonly targetCode: string
		readonly supplierGid: string
		readonly regionCode: string
		readonly arrivalDate: string
		readonly departureDate: string
		readonly statusCode: number
		readonly actorId: string
	}): Promise<{ readonly id: string }>

	getById(tenantId: string, id: string): Promise<RegistrationRowMinimal | null>

	updateAfterReserve(
		tenantId: string,
		id: string,
		patch: {
			readonly epguOrderId: string
			readonly statusCode: number
			readonly submittedAt: Date
		},
	): Promise<void>

	updateAfterPoll(
		tenantId: string,
		id: string,
		patch: {
			readonly statusCode: number
			readonly isFinal: boolean
			readonly reasonRefuse: string | null
			readonly errorCategory: EpguErrorCategory | null
			readonly retryCount: number
			readonly lastPolledAt: Date
			readonly nextPollAt: Date | null
			readonly finalizedAt: Date | null
		},
	): Promise<void>

	listPendingPoll(now: Date, limit: number): Promise<readonly RegistrationRowMinimal[]>
}

export interface RegistrationRowMinimal {
	readonly tenantId: string
	readonly id: string
	readonly bookingId: string
	readonly guestId: string
	readonly documentId: string
	readonly epguChannel: EpguChannel
	readonly epguOrderId: string | null
	readonly serviceCode: string
	readonly targetCode: string
	readonly supplierGid: string
	readonly regionCode: string
	readonly arrivalDate: string
	readonly departureDate: string
	readonly statusCode: number
	readonly isFinal: boolean
	readonly retryCount: number
}

export class RklBlockedError extends Error {
	override readonly name = 'RklBlockedError'
	readonly registryRevision: string
	constructor(registryRevision: string) {
		super(`RKL match — заселение заблокировано (revision ${registryRevision})`)
		this.registryRevision = registryRevision
	}
}

/**
 * Map ЕПГУ reasonRefuse text → 8-category classification. Used by repo
 * patch на финализации. Mirrors REASON_REFUSE_TEXTS keys в Mock.
 */
export function classifyReasonRefuse(
	reasonRefuse: string | null | undefined,
): EpguErrorCategory | null {
	if (!reasonRefuse) return null
	const r = reasonRefuse
	if (/Несоответствие формата/i.test(r)) return 'validation_format'
	if (/Ошибка проверки электронной подписи/i.test(r)) return 'signature_invalid'
	if (/Дубликат уведомления/i.test(r)) return 'duplicate_notification'
	if (/реестре утраченных или недействительных/i.test(r)) return 'document_lost_or_invalid'
	if (/Реестр Контролируемых Лиц|РКЛ/i.test(r)) return 'rkl_match'
	if (/Подразделение МВД/i.test(r) && /регион/i.test(r)) return 'region_mismatch'
	if (/Срок пребывания/i.test(r)) return 'stay_period_exceeded'
	if (/Сервис временно недоступен/i.test(r)) return 'service_temporarily_unavailable'
	return null
}

/**
 * Build new ID for migration registration row.
 *
 * NOTE: kept as a function for test seam — production wiring uses
 * `newId('migrationRegistration')` from @horeca/shared. We accept it
 * via deps to keep service deterministic in tests.
 */
export type RegistrationIdGen = () => string

/**
 * Build a registration service. Bind transport, rkl, repo at construction;
 * enqueue/submit/poll methods orchestrate the FSM via the persisted store.
 */
export function createRegistrationService(deps: RegistrationServiceDeps, idGen: RegistrationIdGen) {
	const now = deps.now ?? (() => new Date())

	async function enqueue(input: EnqueueRegistrationInput): Promise<{ id: string }> {
		// 1. RKL pre-check (blocks submission). research §6: РКЛ обязательна
		// перед заселением, не throw'ится в registration row если match.
		const rklReq: RklCheckRequest = {
			documentType: 'passport_ru',
			series: null,
			number: 'placeholder', // TODO M8.A.5.fix wire from documentId lookup
			birthdate: input.arrivalDate, // placeholder for testing
		}
		const rklResult = await deps.rkl.check(rklReq)
		if (rklResult.status === 'match') {
			throw new RklBlockedError(rklResult.registryRevision)
		}
		// inconclusive → warn but proceed. Operator UI shows badge.
		const id = idGen()
		await deps.repo.create({
			tenantId: input.tenantId,
			id,
			bookingId: input.bookingId,
			guestId: input.guestId,
			documentId: input.documentId,
			epguChannel: input.epguChannel,
			serviceCode: input.serviceCode,
			targetCode: input.targetCode,
			supplierGid: input.supplierGid,
			regionCode: input.regionCode,
			arrivalDate: input.arrivalDate,
			departureDate: input.departureDate,
			statusCode: EPGU_STATUS_CODES.draft,
			actorId: input.actorId,
		})
		return { id }
	}

	/**
	 * submit() — phase-1+2 of ЕПГУ flow:
	 * reserveOrder → pushArchive → row.statusCode=17.
	 * NB: archive bytes generated externally (M8.A.5.fix — XML+SIG builder).
	 * Stub here passes empty placeholder; real impl wires through.
	 */
	async function submit(
		tenantId: string,
		id: string,
		archive: Uint8Array,
	): Promise<{ epguOrderId: string }> {
		const row = await deps.repo.getById(tenantId, id)
		if (!row) throw new Error(`registration ${id} not found in tenant ${tenantId}`)
		if (row.statusCode !== EPGU_STATUS_CODES.draft) {
			throw new Error(`registration ${id} not in draft (status=${row.statusCode})`)
		}
		const reserved = await deps.transport.reserveOrder({
			serviceCode: row.serviceCode,
			targetCode: row.targetCode,
			regionCode: row.regionCode,
		})
		await deps.transport.pushArchive({
			orderId: reserved.orderId,
			archive,
			archiveFilename: `arch_${row.serviceCode}.zip`,
			meta: {
				region: row.regionCode,
				serviceCode: row.serviceCode,
				targetCode: row.targetCode,
			},
		})
		await deps.repo.updateAfterReserve(tenantId, id, {
			epguOrderId: reserved.orderId,
			statusCode: EPGU_STATUS_CODES.submitted,
			submittedAt: now(),
		})
		return { epguOrderId: reserved.orderId }
	}

	/**
	 * cancel() — operator-initiated withdrawal of a submitted notification.
	 *
	 * Per ЕПГУ FSM: row → statusCode=9 (cancellation_pending), polled
	 * cycle eventually advances to 10 (cancelled, FINAL). Operator может
	 * вызвать только если row уже submitted (17/14/15) и НЕ finalized.
	 *
	 * Reason text required (operator audit trail). На canonical use case'и:
	 *   - «Booking cancelled by guest before arrival»
	 *   - «РКЛ false-positive resolved manually»
	 *   - «Wrong guest data — re-submit pending»
	 *
	 * Updates immediately:
	 *   - statusCode → 9 (intermediate)
	 *   - reasonRefuse → reason (operator note)
	 *   - errorCategory → null (cancel != error)
	 *   - lastPolledAt → now (cancel сам по себе = poll-like event)
	 *   - nextPollAt → now + 1s (force quick re-poll to catch final 10)
	 *
	 * Status 10 (cancelled FINAL) lands via pollOne на следующий cron tick.
	 */
	async function cancel(
		tenantId: string,
		id: string,
		reason: string,
	): Promise<{ statusCode: number }> {
		if (!reason || reason.trim().length === 0) {
			throw new Error('cancel reason is required')
		}
		const row = await deps.repo.getById(tenantId, id)
		if (!row) throw new Error(`registration ${id} not found in tenant ${tenantId}`)
		if (!row.epguOrderId) {
			throw new Error(`registration ${id} not yet submitted (no orderId) — nothing to cancel`)
		}
		if (row.isFinal) {
			throw new Error(
				`registration ${id} already in final state (statusCode=${row.statusCode}); cancellation rejected`,
			)
		}
		const cancelResp = await deps.transport.cancelOrder({
			orderId: row.epguOrderId,
			reason,
		})
		const t = now()
		await deps.repo.updateAfterPoll(tenantId, id, {
			statusCode: cancelResp.statusCode,
			isFinal: false, // 9 is intermediate; 10 lands via pollOne
			reasonRefuse: reason,
			errorCategory: null, // cancel is operator action, not ЕПГУ error
			retryCount: row.retryCount,
			lastPolledAt: t,
			nextPollAt: new Date(t.getTime() + 1000), // force quick re-poll for 10
			finalizedAt: null,
		})
		return { statusCode: cancelResp.statusCode }
	}

	/**
	 * pollOne() — fetch latest status from transport, advance FSM, schedule
	 * next poll если не final. Idempotent: safe to call repeatedly.
	 */
	async function pollOne(tenantId: string, id: string): Promise<{ isFinal: boolean }> {
		const row = await deps.repo.getById(tenantId, id)
		if (!row) throw new Error(`registration ${id} not found`)
		if (!row.epguOrderId) throw new Error(`registration ${id} has no orderId — not yet submitted`)
		if (row.isFinal) return { isFinal: true }

		const status = await deps.transport.getStatus({ orderId: row.epguOrderId })
		const isFinal = isEpguFinalStatus(status.statusCode)
		const errorCategory = classifyReasonRefuse(status.reasonRefuse ?? null)
		const t = now()
		const newRetryCount = row.retryCount + 1
		const nextPollAt = isFinal
			? null
			: new Date(computeNextPollAtMsLocal(t.getTime(), newRetryCount))

		await deps.repo.updateAfterPoll(tenantId, id, {
			statusCode: status.statusCode,
			isFinal,
			reasonRefuse: status.reasonRefuse ?? null,
			errorCategory,
			retryCount: newRetryCount,
			lastPolledAt: t,
			nextPollAt,
			finalizedAt: isFinal ? t : null,
		})
		return { isFinal }
	}

	/**
	 * runPollCycle() — invoked by cron each minute. Picks a batch of
	 * non-final rows where nextPollAt ≤ now and polls each.
	 */
	async function runPollCycle(batchSize = 50): Promise<{ scanned: number; finalized: number }> {
		const t = now()
		const rows = await deps.repo.listPendingPoll(t, batchSize)
		let finalized = 0
		for (const row of rows) {
			try {
				const { isFinal } = await pollOne(row.tenantId, row.id)
				if (isFinal) finalized += 1
			} catch (_err) {
				// Log via deps.log later (M8.A.5.fix — wire pino)
				// row stays at current status; cron retries next cycle.
			}
		}
		return { scanned: rows.length, finalized }
	}

	return { enqueue, submit, cancel, pollOne, runPollCycle }
}

/**
 * Local copy of canonical computeNextPollAtMs to avoid circular import
 * between service.ts (this file) and shared (which imports nothing from
 * apps/backend). Source-of-truth lives в @horeca/shared.
 */
function computeNextPollAtMsLocal(lastPolledAtMs: number, retryCount: number): number {
	const ONE_MIN = 60_000
	if (retryCount < 10) return lastPolledAtMs + ONE_MIN
	if (retryCount < 20) return lastPolledAtMs + 5 * ONE_MIN
	const expSteps = retryCount - 20
	const intervalMin = Math.min(10 * 2 ** expSteps, 24 * 60)
	return lastPolledAtMs + intervalMin * ONE_MIN
}
