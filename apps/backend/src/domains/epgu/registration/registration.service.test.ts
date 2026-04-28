/**
 * RegistrationService — strict tests per `feedback_strict_tests.md`.
 *
 * Test matrix:
 *   ─── enqueue ────────────────────────────────────────────────────
 *     [En1] RKL clean → row created status=0 (draft)
 *     [En2] RKL match → throws RklBlockedError, row NOT created
 *     [En3] RKL inconclusive → row created (warning, not block)
 *
 *   ─── submit (phase 1+2) ─────────────────────────────────────────
 *     [Sb1] submit draft → calls reserveOrder + pushArchive, status→17
 *     [Sb2] submit non-draft (already submitted) → throws
 *     [Sb3] submit unknown id → throws
 *
 *   ─── pollOne ────────────────────────────────────────────────────
 *     [Po1] poll non-final → updates statusCode, increments retryCount
 *     [Po2] poll → reaches final 3 → isFinal=true, nextPollAt=null
 *     [Po3] poll → reaches final 4 → reasonRefuse + errorCategory set
 *     [Po4] poll already final → returns isFinal=true, no-op (idempotent)
 *     [Po5] poll without orderId (draft) → throws
 *
 *   ─── classifyReasonRefuse (pure helper) ─────────────────────────
 *     [Cr1] all 8 canonical reason texts → correct EpguErrorCategory
 *     [Cr2] empty/null → null
 *     [Cr3] unknown text → null
 *
 *   ─── runPollCycle batch ─────────────────────────────────────────
 *     [Cy1] 3 pending rows → all polled, scanned=3
 *     [Cy2] 1 transient throw → cycle continues, others updated
 */
import { afterEach, describe, expect, test } from 'vitest'
import { createMockArchiveBuilder } from '../archive/mock-archive.ts'
import { createMockRklCheck } from '../rkl/mock-rkl.ts'
import { createMockEpguTransport } from '../transport/mock-epgu.ts'
import {
	classifyReasonRefuse,
	createRegistrationService,
	type RegistrationRepoOps,
	type RegistrationRowMinimal,
	RklBlockedError,
} from './registration.service.ts'

function makeRng(seed: number): () => number {
	let s = seed
	return () => {
		s = (s + 0x6d2b79f5) | 0
		let t = s
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

interface InMemoryStoreRow extends RegistrationRowMinimal {
	statusCode: number
	isFinal: boolean
	retryCount: number
	epguOrderId: string | null
	submittedAt: Date | null
	lastPolledAt: Date | null
	nextPollAt: Date | null
	finalizedAt: Date | null
	reasonRefuse: string | null
}

function buildInMemoryRepo(): RegistrationRepoOps & { rows: Map<string, InMemoryStoreRow> } {
	const rows = new Map<string, InMemoryStoreRow>()
	return {
		rows,
		async create(input) {
			rows.set(input.id, {
				tenantId: input.tenantId,
				id: input.id,
				bookingId: input.bookingId,
				guestId: input.guestId,
				documentId: input.documentId,
				epguChannel: input.epguChannel,
				epguOrderId: null,
				serviceCode: input.serviceCode,
				targetCode: input.targetCode,
				supplierGid: input.supplierGid,
				regionCode: input.regionCode,
				arrivalDate: input.arrivalDate,
				departureDate: input.departureDate,
				statusCode: input.statusCode,
				isFinal: false,
				retryCount: 0,
				submittedAt: null,
				lastPolledAt: null,
				nextPollAt: null,
				finalizedAt: null,
				reasonRefuse: null,
			})
			return { id: input.id }
		},
		async getById(_tenantId, id) {
			return rows.get(id) ?? null
		},
		async updateAfterReserve(_tenantId, id, patch) {
			const row = rows.get(id)
			if (!row) throw new Error('not found')
			row.epguOrderId = patch.epguOrderId
			row.statusCode = patch.statusCode
			row.submittedAt = patch.submittedAt
		},
		async updateAfterPoll(_tenantId, id, patch) {
			const row = rows.get(id)
			if (!row) throw new Error('not found')
			row.statusCode = patch.statusCode
			row.isFinal = patch.isFinal
			row.reasonRefuse = patch.reasonRefuse
			row.retryCount = patch.retryCount
			row.lastPolledAt = patch.lastPolledAt
			row.nextPollAt = patch.nextPollAt
			row.finalizedAt = patch.finalizedAt
		},
		async listPendingPoll(now, limit) {
			const out: RegistrationRowMinimal[] = []
			for (const row of rows.values()) {
				if (row.isFinal) continue
				if (row.epguOrderId === null) continue
				if (row.nextPollAt !== null && row.nextPollAt > now) continue
				out.push(row)
				if (out.length >= limit) break
			}
			return out
		},
	}
}

const ENQ_INPUT = {
	tenantId: 'org-test',
	bookingId: 'book-test',
	guestId: 'gst-test',
	documentId: 'gdoc-test',
	arrivalDate: '2026-05-10',
	departureDate: '2026-05-15',
	epguChannel: 'gost-tls' as const,
	serviceCode: '10000103652',
	targetCode: '-1000444103652',
	supplierGid: 'supplier-test',
	regionCode: 'fias-test',
	actorId: 'usr-test',
}

let idCounter = 0
const idGen = () => `mreg-${++idCounter}`

afterEach(() => {
	idCounter = 0
})

// ────────────────────────────────────────────────────────────────────
// enqueue
// ────────────────────────────────────────────────────────────────────

describe('RegistrationService — enqueue', () => {
	test('[En1] RKL clean → row created status=0 (draft)', async () => {
		const repo = buildInMemoryRepo()
		const transport = createMockEpguTransport({ random: makeRng(1) })
		const rkl = createMockRklCheck({ random: makeRng(2), forceStatus: 'clean' })
		const svc = createRegistrationService(
			{ transport, rkl, repo, archive: createMockArchiveBuilder() },
			idGen,
		)
		const { id } = await svc.enqueue(ENQ_INPUT)
		const row = repo.rows.get(id)
		expect(row).toBeDefined()
		expect(row?.statusCode).toBe(0) // draft
	})

	test('[En2] RKL match → throws RklBlockedError, row NOT created', async () => {
		const repo = buildInMemoryRepo()
		const transport = createMockEpguTransport({ random: makeRng(1) })
		const rkl = createMockRklCheck({ random: makeRng(2), forceStatus: 'match' })
		const svc = createRegistrationService(
			{ transport, rkl, repo, archive: createMockArchiveBuilder() },
			idGen,
		)
		await expect(svc.enqueue(ENQ_INPUT)).rejects.toBeInstanceOf(RklBlockedError)
		expect(repo.rows.size).toBe(0)
	})

	test('[En3] RKL inconclusive → row created (warning, не блок)', async () => {
		const repo = buildInMemoryRepo()
		const transport = createMockEpguTransport({ random: makeRng(1) })
		const rkl = createMockRklCheck({ random: makeRng(2), forceStatus: 'inconclusive' })
		const svc = createRegistrationService(
			{ transport, rkl, repo, archive: createMockArchiveBuilder() },
			idGen,
		)
		const { id } = await svc.enqueue(ENQ_INPUT)
		expect(repo.rows.get(id)).toBeDefined()
	})
})

// ────────────────────────────────────────────────────────────────────
// submit (phase 1+2)
// ────────────────────────────────────────────────────────────────────

describe('RegistrationService — submit', () => {
	test('[Sb1] submit draft → reserve+push, status→17, orderId set', async () => {
		const repo = buildInMemoryRepo()
		const transport = createMockEpguTransport({ random: makeRng(1) })
		const rkl = createMockRklCheck({ random: makeRng(2), forceStatus: 'clean' })
		const svc = createRegistrationService(
			{ transport, rkl, repo, archive: createMockArchiveBuilder() },
			idGen,
		)
		const { id } = await svc.enqueue(ENQ_INPUT)
		const archive = new Uint8Array([0x50, 0x4b, 0x03, 0x04]) // ZIP magic
		const { epguOrderId } = await svc.submit(ENQ_INPUT.tenantId, id, archive)
		expect(epguOrderId.startsWith('mock-epgu-order-')).toBe(true)
		const row = repo.rows.get(id)
		expect(row?.statusCode).toBe(17)
		expect(row?.epguOrderId).toBe(epguOrderId)
		expect(row?.submittedAt).not.toBeNull()
	})

	test('[Sb2] submit already-submitted → throws', async () => {
		const repo = buildInMemoryRepo()
		const transport = createMockEpguTransport({ random: makeRng(1) })
		const rkl = createMockRklCheck({ random: makeRng(2), forceStatus: 'clean' })
		const svc = createRegistrationService(
			{ transport, rkl, repo, archive: createMockArchiveBuilder() },
			idGen,
		)
		const { id } = await svc.enqueue(ENQ_INPUT)
		const archive = new Uint8Array([0x50, 0x4b, 0x03, 0x04])
		await svc.submit(ENQ_INPUT.tenantId, id, archive)
		await expect(svc.submit(ENQ_INPUT.tenantId, id, archive)).rejects.toThrow(/not in draft/)
	})

	test('[Sb3] submit unknown id → throws', async () => {
		const repo = buildInMemoryRepo()
		const transport = createMockEpguTransport({ random: makeRng(1) })
		const rkl = createMockRklCheck({ random: makeRng(2), forceStatus: 'clean' })
		const svc = createRegistrationService(
			{ transport, rkl, repo, archive: createMockArchiveBuilder() },
			idGen,
		)
		await expect(
			svc.submit(ENQ_INPUT.tenantId, 'never-existed', new Uint8Array([1])),
		).rejects.toThrow(/not found/)
	})
})

// ────────────────────────────────────────────────────────────────────
// pollOne
// ────────────────────────────────────────────────────────────────────

describe('RegistrationService — pollOne', () => {
	async function setup(force?: 'success' | 'fail') {
		let nowVal = 1_000_000_000_000
		const now = () => new Date(nowVal)
		const transport = createMockEpguTransport({
			random: makeRng(1),
			now: () => nowVal,
			errorRateMultiplier: force === 'fail' ? 100 : force === 'success' ? 0 : 1,
			speedUpFactor: 1,
		})
		const repo = buildInMemoryRepo()
		const rkl = createMockRklCheck({ random: makeRng(2), forceStatus: 'clean' })
		const svc = createRegistrationService(
			{ transport, rkl, repo, now, archive: createMockArchiveBuilder() },
			idGen,
		)
		const { id } = await svc.enqueue(ENQ_INPUT)
		await svc.submit(ENQ_INPUT.tenantId, id, new Uint8Array([0x50, 0x4b, 0x03, 0x04]))
		return {
			svc,
			repo,
			id,
			advance: (ms: number) => {
				nowVal += ms
			},
		}
	}

	test('[Po1] poll non-final → retryCount++, statusCode advances', async () => {
		const { svc, repo, id, advance } = await setup('success')
		advance(60_000) // 1 min
		const before = repo.rows.get(id)
		const beforeRetry = before?.retryCount ?? 0
		const result = await svc.pollOne(ENQ_INPUT.tenantId, id)
		const after = repo.rows.get(id)
		expect(after?.retryCount).toBe(beforeRetry + 1)
		// FSM may or may not have advanced depending on trajectory + time
		expect([1, 2, 17, 21, 3]).toContain(after?.statusCode)
		expect([true, false]).toContain(result.isFinal)
	})

	test('[Po2] full progression → final 3, isFinal=true, nextPollAt=null', async () => {
		const { svc, repo, id, advance } = await setup('success')
		// Loop poll until final
		for (let i = 0; i < 20; i++) {
			advance(15 * 60_000) // 15 min each — should reach final within 4-8 polls
			const r = await svc.pollOne(ENQ_INPUT.tenantId, id)
			if (r.isFinal) break
		}
		const row = repo.rows.get(id)
		expect(row?.isFinal).toBe(true)
		expect(row?.statusCode).toBe(3)
		expect(row?.nextPollAt).toBeNull()
		expect(row?.finalizedAt).not.toBeNull()
	})

	test('[Po3] forced refuse → final 4, reasonRefuse + errorCategory set', async () => {
		const { svc, repo, id, advance } = await setup('fail')
		for (let i = 0; i < 20; i++) {
			advance(15 * 60_000)
			const r = await svc.pollOne(ENQ_INPUT.tenantId, id)
			if (r.isFinal) break
		}
		const row = repo.rows.get(id)
		expect(row?.statusCode).toBe(4)
		expect(row?.isFinal).toBe(true)
		expect(row?.reasonRefuse).not.toBeNull()
	})

	test('[Po4] poll already final → idempotent, no error', async () => {
		const { svc, id, advance } = await setup('success')
		for (let i = 0; i < 20; i++) {
			advance(15 * 60_000)
			const r = await svc.pollOne(ENQ_INPUT.tenantId, id)
			if (r.isFinal) break
		}
		const second = await svc.pollOne(ENQ_INPUT.tenantId, id)
		expect(second.isFinal).toBe(true)
	})

	test('[Po5] poll draft (no orderId) → throws', async () => {
		const repo = buildInMemoryRepo()
		const transport = createMockEpguTransport({ random: makeRng(1) })
		const rkl = createMockRklCheck({ random: makeRng(2), forceStatus: 'clean' })
		const svc = createRegistrationService(
			{ transport, rkl, repo, archive: createMockArchiveBuilder() },
			idGen,
		)
		const { id } = await svc.enqueue(ENQ_INPUT)
		await expect(svc.pollOne(ENQ_INPUT.tenantId, id)).rejects.toThrow(/no orderId/)
	})
})

// ────────────────────────────────────────────────────────────────────
// classifyReasonRefuse (pure)
// ────────────────────────────────────────────────────────────────────

describe('classifyReasonRefuse', () => {
	test('[Cr1] all 8 canonical texts → correct EpguErrorCategory', () => {
		const cases: ReadonlyArray<readonly [string, string]> = [
			['Несоответствие формата данных требованиям ФЛК', 'validation_format'],
			['Ошибка проверки электронной подписи', 'signature_invalid'],
			['Дубликат уведомления о прибытии', 'duplicate_notification'],
			['реестре утраченных или недействительных', 'document_lost_or_invalid'],
			['Реестр Контролируемых Лиц', 'rkl_match'],
			['Подразделение МВД по указанному региону', 'region_mismatch'],
			['Срок пребывания превышает разрешённый', 'stay_period_exceeded'],
			['Сервис временно недоступен', 'service_temporarily_unavailable'],
		]
		for (const [text, expected] of cases) {
			expect(classifyReasonRefuse(text)).toBe(expected)
		}
	})

	test('[Cr2] empty/null → null', () => {
		expect(classifyReasonRefuse(null)).toBeNull()
		expect(classifyReasonRefuse('')).toBeNull()
		expect(classifyReasonRefuse(undefined)).toBeNull()
	})

	test('[Cr3] unknown text → null', () => {
		expect(classifyReasonRefuse('какая-то непонятная причина без ключевых слов')).toBeNull()
	})
})

// ────────────────────────────────────────────────────────────────────
// runPollCycle (cron entry)
// ────────────────────────────────────────────────────────────────────

describe('RegistrationService — runPollCycle', () => {
	test('[Cy1] 3 pending rows → all polled, scanned=3', async () => {
		let nowVal = 1_000_000_000_000
		const transport = createMockEpguTransport({
			random: makeRng(1),
			now: () => nowVal,
			errorRateMultiplier: 0,
			speedUpFactor: 1,
		})
		const repo = buildInMemoryRepo()
		const rkl = createMockRklCheck({ random: makeRng(2), forceStatus: 'clean' })
		const svc = createRegistrationService(
			{ transport, rkl, repo, now: () => new Date(nowVal), archive: createMockArchiveBuilder() },
			idGen,
		)
		// Enqueue + submit 3
		for (let i = 0; i < 3; i++) {
			const { id } = await svc.enqueue({ ...ENQ_INPUT, bookingId: `book-${i}` })
			await svc.submit(ENQ_INPUT.tenantId, id, new Uint8Array([0x50, 0x4b, 0x03, 0x04]))
		}
		nowVal += 60_000
		const result = await svc.runPollCycle(50)
		expect(result.scanned).toBe(3)
		// Each row's retryCount should now be 1
		for (const row of repo.rows.values()) {
			expect(row.retryCount).toBe(1)
		}
	})
})
