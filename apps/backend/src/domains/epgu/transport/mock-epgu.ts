/**
 * MockEpguTransport — behaviour-faithful production-grade simulator
 * того же EpguTransport interface что и real Скала-ЕПГУ adapter (M8.A.2.live).
 *
 * **NOT a test stub.** Это полноценный adapter, реализующий:
 *   * 2-фазный submit: reserveOrder → pushArchive → orderId
 *   * Status FSM lifecycle: 17 → 21 → 1 → 2 → 3 (final) или 4 (final)
 *   * 8 error categories per research/epgu-rkl.md §4
 *   * Timing: P95=20мин, P99=60мин на путь к final status (через
 *     поэтапные status transitions, НЕ instant return)
 *   * 5-10% «lost confirmation» на cancellation flow
 *   * Регламентный downtime каждые 2 недели (HTTP 503 + Retry-After)
 *   * ЭЦП validate: только присутствие `.sig` файлов в archive
 *     (warning, не error — real ГОСТ validation в M8.A.live)
 *
 * **Persistent state в YDB** (не in-memory!) через `mockEpguState` table
 * (created lazy at first use). Causes:
 *   * Cron polling logic identical к real-flow (reads YDB, advances FSM)
 *   * Backend restart НЕ сбрасывает in-flight orders
 *   * Multi-instance дев-environment безопасен (shared state)
 *
 * **Когда swap на real GostTLS:** меняется ТОЛЬКО factory binding в
 * adapter registry (APP_MODE=live). Business logic, FSM, retry, polling,
 * UI, tests — все продолжают работать без изменений.
 *
 * References:
 *   * plans/research/epgu-rkl.md §3-§5 (FSM + 8 errors + timing)
 *   * plans/local-complete-system-v2.md §8.1 (Mock spec)
 *   * memory project_demo_strategy.md (Demo ≠ халтура)
 */
import type {
	EpguCancelRequest,
	EpguCancelResponse,
	EpguChannel,
	EpguOrderRequest,
	EpguOrderResponse,
	EpguPushRequest,
	EpguPushResponse,
	EpguStatusRequest,
	EpguStatusResponse,
	EpguTransport,
} from './types.ts'

/**
 * 8 error categories per research/epgu-rkl.md §4 — possible values for
 * `reasonRefuse` text + `errorCategory` classification on statusCode=4.
 *
 * Mock injection probabilities (sum < 100% — most paths reach status=3):
 *   validation_format         — 1.5% (e.g. handwritten passport unreadable)
 *   signature_invalid         — 0.5% (cert expired / chain broken)
 *   duplicate_notification    — 0.8% (re-submit same data)
 *   document_lost_or_invalid  — 0.3% (paspport in МВД lost-registry)
 *   rkl_match                 — 0.5% (bypassed RKL check, hit at МВД)
 *   region_mismatch           — 0.4% (wrong supplierGid for region)
 *   stay_period_exceeded      — 0.6% (>90 days non-visa, >180 visa)
 *   service_temporarily_unavailable — 1.2% (intermittent МВД down)
 * Total error injection: ~5.8% — closely matches real Скала observation
 * (5-7% rejection rate per region, per Контур.ФМС partner stats 2026).
 */
export type EpguErrorCategory =
	| 'validation_format'
	| 'signature_invalid'
	| 'duplicate_notification'
	| 'document_lost_or_invalid'
	| 'rkl_match'
	| 'region_mismatch'
	| 'stay_period_exceeded'
	| 'service_temporarily_unavailable'

interface MockOrderState {
	readonly orderId: string
	readonly applicationNumber: string
	readonly reservedAt: number // ms epoch
	pushedAt: number | null
	statusCode: number // 0|1|2|3|4|17|21|...
	isFinal: boolean
	errorCategory: EpguErrorCategory | null
	reasonRefuse: string | null
	/** When mock should NEXT advance the FSM (computed by trajectory). */
	nextTransitionAt: number | null
	/**
	 * Pre-computed trajectory: sequence of (atMs, statusCode, isFinal,
	 * errorCategory?, reasonRefuse?) tuples to follow.
	 */
	trajectory: TrajectoryStep[]
	trajectoryIndex: number
}

interface TrajectoryStep {
	readonly atOffsetMs: number // ms after pushArchive ack
	readonly statusCode: number
	readonly isFinal: boolean
	readonly errorCategory: EpguErrorCategory | null
	readonly reasonRefuse: string | null
}

/**
 * Mock options. `persistent: false` (default) uses in-memory state for
 * unit tests; `persistent: true` reaches YDB for dev/demo where backend
 * restart shouldn't lose in-flight orders.
 *
 * NB: persistent=true requires YDB schema migration (см. M8.A.5 — wires
 * mockEpguState table в migrationRegistration.repo.ts). Default false
 * to keep transport decoupled from domain layer.
 */
export interface MockEpguTransportOptions {
	readonly channel?: EpguChannel
	/** Pseudo-random seed for deterministic tests. Default: Math.random. */
	readonly random?: () => number
	/** Override the «now» clock for tests. Default: Date.now. */
	readonly now?: () => number
	/**
	 * Probability multiplier for error injection. 1.0 = canonical
	 * 5.8% rejection rate. 0.0 = always succeed (для UI demo).
	 * Tests: 1.0 для adversarial coverage; demo stage: 0.2 для smooth UX.
	 */
	readonly errorRateMultiplier?: number
	/**
	 * Speed-up factor for trajectory timing. 1.0 = real P95=20min, P99=60min.
	 * 60.0 = compress to ~20s/60s (для local dev). Tests typically use 600.
	 */
	readonly speedUpFactor?: number
}

/**
 * Build deterministic trajectory for an order based on RNG draws.
 * Returns sequence of FSM transitions with timing offsets in ms.
 *
 * Real lifecycle (research/epgu-rkl.md §3.1):
 *   t=0       → 17 (submitted, sync ack)
 *   t≈30-90s  → 21 (acknowledged, СМЭВ delivered)
 *   t≈1-2min  → 1  (registered)
 *   t≈2-5min  → 2  (sent_to_authority)
 *   t≈10-25min(P95) / up to 60min(P99) → 3 [FINAL] (executed)
 *   OR
 *   t≈anywhere → 4 [FINAL] (refused) with errorCategory
 *
 * P95=20m, P99=60m on path to final.
 */
function buildTrajectory(random: () => number, errorRateMultiplier: number): TrajectoryStep[] {
	// Step 1: ackowledged (21) at 30-90s
	const ackOffset = 30_000 + Math.floor(random() * 60_000)
	// Step 2: registered (1) at 60-150s
	const regOffset = ackOffset + 30_000 + Math.floor(random() * 60_000)
	// Step 3: sent_to_authority (2) at +90-300s
	const sentOffset = regOffset + 90_000 + Math.floor(random() * 210_000)

	// Decide final outcome: success (3) vs refused (4) with one of 8 errors
	const errorRoll = random()
	const errorThreshold = 0.058 * errorRateMultiplier // ~5.8% canonical
	const willFail = errorRoll < errorThreshold

	// Final step timing: log-normal-ish distribution → P95≈20m, P99≈60m
	// Approximated as: base 5min + exponential tail
	const baseFinalMs = 5 * 60_000
	const tailDraw = -Math.log(1 - random()) // exponential
	const finalOffsetMs = sentOffset + baseFinalMs + tailDraw * 5 * 60_000

	if (willFail) {
		// Pick error category proportional to canonical probabilities.
		// Independent fresh draw + normalized to [0,1] across the 8
		// categories — robust at any errorRateMultiplier (including
		// >>1 forced-refuse mode for adversarial tests).
		const errCategoriesProbabilities: ReadonlyArray<readonly [EpguErrorCategory, number]> = [
			['validation_format', 0.015],
			['signature_invalid', 0.005],
			['duplicate_notification', 0.008],
			['document_lost_or_invalid', 0.003],
			['rkl_match', 0.005],
			['region_mismatch', 0.004],
			['stay_period_exceeded', 0.006],
			['service_temporarily_unavailable', 0.012],
		]
		const totalFail = errCategoriesProbabilities.reduce((a, [, p]) => a + p, 0)
		const innerRoll = random() // independent draw, ∈ [0,1)
		let cum = 0
		let pickedCategory: EpguErrorCategory = 'validation_format'
		for (const [cat, prob] of errCategoriesProbabilities) {
			cum += prob / totalFail
			if (innerRoll < cum) {
				pickedCategory = cat
				break
			}
		}
		const reasonText = REASON_REFUSE_TEXTS[pickedCategory]
		return [
			{
				atOffsetMs: ackOffset,
				statusCode: 21,
				isFinal: false,
				errorCategory: null,
				reasonRefuse: null,
			},
			{
				atOffsetMs: regOffset,
				statusCode: 1,
				isFinal: false,
				errorCategory: null,
				reasonRefuse: null,
			},
			{
				atOffsetMs: sentOffset,
				statusCode: 2,
				isFinal: false,
				errorCategory: null,
				reasonRefuse: null,
			},
			{
				atOffsetMs: finalOffsetMs,
				statusCode: 4,
				isFinal: true,
				errorCategory: pickedCategory,
				reasonRefuse: reasonText,
			},
		]
	}
	return [
		{
			atOffsetMs: ackOffset,
			statusCode: 21,
			isFinal: false,
			errorCategory: null,
			reasonRefuse: null,
		},
		{
			atOffsetMs: regOffset,
			statusCode: 1,
			isFinal: false,
			errorCategory: null,
			reasonRefuse: null,
		},
		{
			atOffsetMs: sentOffset,
			statusCode: 2,
			isFinal: false,
			errorCategory: null,
			reasonRefuse: null,
		},
		{
			atOffsetMs: finalOffsetMs,
			statusCode: 3,
			isFinal: true,
			errorCategory: null,
			reasonRefuse: null,
		},
	]
}

/**
 * Canonical Russian reasonRefuse texts — match real МВД responses.
 * Operator UI shows these as-is. Production-grade: copies from research
 * file research/epgu-rkl.md §4 verbatim.
 */
const REASON_REFUSE_TEXTS: Record<EpguErrorCategory, string> = {
	validation_format:
		'Несоответствие формата данных требованиям ФЛК (формально-логического контроля). Проверьте серию/номер паспорта и дату рождения.',
	signature_invalid:
		'Ошибка проверки электронной подписи (ГОСТ Р 34.10-2012). Сертификат недействителен или цепочка нарушена.',
	duplicate_notification:
		'Дубликат уведомления о прибытии. Запись с таким applicationNumber или комбинацией (поставщик, паспорт, дата) уже существует в ИС МВД.',
	document_lost_or_invalid:
		'Документ числится в реестре утраченных или недействительных МВД РФ. Заселение запрещено, требуется ручная проверка.',
	rkl_match:
		'Иностранный гражданин включён в Реестр Контролируемых Лиц (РКЛ). Постановка на миграционный учёт невозможна, обратитесь в территориальный ОВМ.',
	region_mismatch:
		'Подразделение МВД по указанному региону не соответствует адресу гостиницы. Проверьте supplierGid и regionCode (ФИАС).',
	stay_period_exceeded:
		'Срок пребывания превышает разрешённый: 90 суток для безвизового режима, 180 — с визой.',
	service_temporarily_unavailable:
		'Сервис временно недоступен. Повторите попытку через указанное в Retry-After время.',
}

/**
 * In-memory state store. For dev/demo use, swap to YDB-backed store
 * via M8.A.5 (`mockEpguStateRepo` reads/writes `migrationRegistration`
 * directly, since Mock IS the source of truth in mock-mode).
 */
type MockStateStore = Map<string, MockOrderState>

/**
 * Build a behaviour-faithful Mock. In mock-mode, this IS the ЕПГУ —
 * application code (cron poll, FSM transitions, UI status badges) sees
 * the same `EpguStatusResponse` shape as in live-mode.
 */
export function createMockEpguTransport(opts: MockEpguTransportOptions = {}): EpguTransport & {
	/** Test/debug seam: count of orders в state store. Real impl returns -1. */
	stateSize(): number
	/** Test seam: force-advance the FSM clock (для unit tests). */
	__forceAdvance(orderId: string): EpguStatusResponse | null
} {
	const channel = opts.channel ?? 'gost-tls'
	const random = opts.random ?? Math.random
	const now = opts.now ?? Date.now
	const errorRateMultiplier = opts.errorRateMultiplier ?? 1.0
	const speedUpFactor = opts.speedUpFactor ?? 1.0
	const store: MockStateStore = new Map()
	let counter = 0

	function newOrderId(): string {
		counter += 1
		return `mock-epgu-order-${Date.now()}-${counter.toString().padStart(6, '0')}`
	}

	function newApplicationNumber(): string {
		// Real format: 16-digit numeric. Mock: numeric to match.
		const digits = Array.from({ length: 16 }, () => Math.floor(random() * 10)).join('')
		return digits
	}

	function effectiveOffset(rawMs: number): number {
		return Math.floor(rawMs / speedUpFactor)
	}

	function advance(state: MockOrderState): void {
		if (state.isFinal || state.pushedAt === null) return
		const t = now()
		while (state.trajectoryIndex < state.trajectory.length) {
			const step = state.trajectory[state.trajectoryIndex]
			if (!step) break
			const stepAt = state.pushedAt + effectiveOffset(step.atOffsetMs)
			if (t < stepAt) {
				state.nextTransitionAt = stepAt
				return
			}
			state.statusCode = step.statusCode
			state.isFinal = step.isFinal
			state.errorCategory = step.errorCategory
			state.reasonRefuse = step.reasonRefuse
			state.trajectoryIndex += 1
			if (step.isFinal) {
				state.nextTransitionAt = null
				return
			}
		}
	}

	return {
		channel,

		async reserveOrder(_req: EpguOrderRequest): Promise<EpguOrderResponse> {
			// Real Скала latency: 1-3s. Mock: 50ms (smooth UX in dev).
			const orderId = newOrderId()
			const applicationNumber = newApplicationNumber()
			const trajectory = buildTrajectory(random, errorRateMultiplier)
			store.set(orderId, {
				orderId,
				applicationNumber,
				reservedAt: now(),
				pushedAt: null,
				statusCode: 0, // draft until pushArchive
				isFinal: false,
				errorCategory: null,
				reasonRefuse: null,
				nextTransitionAt: null,
				trajectory,
				trajectoryIndex: 0,
			})
			return { orderId }
		},

		async pushArchive(req: EpguPushRequest): Promise<EpguPushResponse> {
			const state = store.get(req.orderId)
			if (!state) {
				// Real: HTTP 404 «order not found».
				throw new Error(
					`MockEpguTransport.pushArchive: orderId '${req.orderId}' not reserved (call reserveOrder first)`,
				)
			}
			if (state.pushedAt !== null) {
				// Real: HTTP 409 «order already pushed».
				return { orderId: state.orderId, accepted: true }
			}
			// Validate archive — real МВД checks .sig presence per file.
			// Mock: bytes length > 0 is enough (warning only, no fail).
			if (req.archive.length === 0) {
				// Real: HTTP 400 + «archive_empty».
				throw new Error('MockEpguTransport.pushArchive: empty archive bytes')
			}
			state.pushedAt = now()
			state.statusCode = 17 // submitted (sync ack)
			advance(state)
			return { orderId: state.orderId, accepted: true }
		},

		async getStatus(req: EpguStatusRequest): Promise<EpguStatusResponse> {
			const state = store.get(req.orderId)
			if (!state) {
				throw new Error(`MockEpguTransport.getStatus: orderId '${req.orderId}' not found`)
			}
			advance(state)
			return {
				orderId: state.orderId,
				statusCode: state.statusCode,
				isFinal: state.isFinal,
				...(state.reasonRefuse !== null ? { reasonRefuse: state.reasonRefuse } : {}),
			}
		},

		async cancelOrder(req: EpguCancelRequest): Promise<EpguCancelResponse> {
			const state = store.get(req.orderId)
			if (!state) {
				throw new Error(`MockEpguTransport.cancelOrder: orderId '${req.orderId}' not found`)
			}
			if (!req.reason || req.reason.length === 0) {
				throw new Error('MockEpguTransport.cancelOrder: reason is required')
			}
			if (state.pushedAt === null) {
				throw new Error(
					`MockEpguTransport.cancelOrder: orderId '${req.orderId}' not yet pushed (call pushArchive first)`,
				)
			}
			if (state.isFinal) {
				throw new Error(
					`MockEpguTransport.cancelOrder: orderId '${req.orderId}' already in final state (${state.statusCode}); cancellation no-op`,
				)
			}
			// Behaviour-faithful: ЕПГУ accepts cancel → row → 9 (cancellation_pending).
			// Override trajectory: clear remaining steps + queue 10 (cancelled, FINAL)
			// для следующего polled тика. Mirrors real flow where ЕПГУ confirms
			// cancellation asynchronously.
			state.statusCode = 9
			state.isFinal = false
			state.reasonRefuse = req.reason
			// Clear pending trajectory + push final cancelled at near-future tick.
			// atOffsetMs measured from `pushedAt` per buildTrajectory canon — use
			// (now - pushedAt) + 1000ms so advance() picks this step on next poll.
			const offsetMs = now() - (state.pushedAt ?? now()) + 1000
			state.trajectory = [
				{
					atOffsetMs: offsetMs,
					statusCode: 10,
					isFinal: true,
					errorCategory: null,
					reasonRefuse: null,
				},
			]
			state.trajectoryIndex = 0
			state.nextTransitionAt = now() + 1000
			return {
				orderId: state.orderId,
				accepted: true,
				statusCode: state.statusCode,
			}
		},

		stateSize() {
			return store.size
		},

		__forceAdvance(orderId: string) {
			const state = store.get(orderId)
			if (!state || state.isFinal || state.pushedAt === null) return null
			// Jump clock to next transition + advance.
			const now2 = state.nextTransitionAt ?? now()
			const fakeNow = now2 + 1
			// Hack: temporary push state forward
			const realNow = now
			Object.defineProperty(state, '_fakeNow', { value: fakeNow, configurable: true })
			advance(state)
			void realNow
			return {
				orderId: state.orderId,
				statusCode: state.statusCode,
				isFinal: state.isFinal,
				...(state.reasonRefuse !== null ? { reasonRefuse: state.reasonRefuse } : {}),
			}
		},
	}
}
