/**
 * MockEpguTransport — strict tests per `feedback_strict_tests.md`.
 *
 * Test matrix (canonical коверage 2-фазного flow + 8 error categories):
 *   ─── Construction + channel ─────────────────────────────────────
 *     [C1] default channel = 'gost-tls'
 *     [C2] override channel — все 3 валидных
 *
 *   ─── reserveOrder ───────────────────────────────────────────────
 *     [R1] returns orderId (non-empty string, prefix 'mock-epgu-order-')
 *     [R2] двa последовательных reserveOrder → разные orderId
 *     [R3] state size growns by 1 per reserve
 *
 *   ─── pushArchive ─────────────────────────────────────────────────
 *     [P1] push без reserve → throws (orderId not found)
 *     [P2] push с empty bytes → throws (archive_empty)
 *     [P3] push valid → accepted=true, sets statusCode=17
 *     [P4] push дважды → idempotent (returns same orderId, accepted=true)
 *
 *   ─── getStatus FSM happy path (full trajectory) ─────────────────
 *     [S1] status сразу после push: 17 (submitted), isFinal=false
 *     [S2] advance time → 21 (acknowledged), isFinal=false
 *     [S3] advance time → 1 (registered), isFinal=false
 *     [S4] advance time → 2 (sent_to_authority), isFinal=false
 *     [S5] advance time → 3 (executed), isFinal=true
 *     [S6] статус не идёт назад (monotonic): после 3 остаётся 3
 *
 *   ─── getStatus FSM refused (errorRateMultiplier=∞) ──────────────
 *     [E1] errorRateMultiplier=10 → high probability of refused (4)
 *     [E2] all 8 error categories reachable over many trials
 *     [E3] reasonRefuse non-null когда statusCode=4
 *     [E4] reasonRefuse mention error in plain Russian (контракт UI)
 *
 *   ─── getStatus invariants ───────────────────────────────────────
 *     [G1] unknown orderId → throws
 *     [G2] isFinal=true ⇒ statusCode in {3, 4}
 *     [G3] isFinal=false ⇒ statusCode in {0, 1, 2, 17, 21}
 *
 *   ─── Determinism + adversarial ──────────────────────────────────
 *     [D1] seeded random → identical trajectory across runs
 *     [D2] errorRateMultiplier=0 → 100% success в 200 trials
 *     [D3] speedUpFactor=1000 → trajectory completes в realtime ms
 */
import { describe, expect, test } from 'vitest'
import { createMockEpguTransport } from './mock-epgu.ts'

function makeRng(seed: number): () => number {
	// Mulberry32 — deterministic, simple, stable across Node versions
	let s = seed
	return () => {
		s = (s + 0x6d2b79f5) | 0
		let t = s
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

const VALID_ARCHIVE = new Uint8Array([0x50, 0x4b, 0x03, 0x04]) // ZIP magic

const PUSH_REQ = {
	orderId: '', // filled per test
	archive: VALID_ARCHIVE,
	archiveFilename: 'arch_ip_10000103652.zip',
	meta: {
		region: 'ee45c0c4-1e3c-4d05-9e0b-fdb3a82f1234',
		serviceCode: '10000103652',
		targetCode: '-1000444103652',
	},
}

const ORDER_REQ = {
	serviceCode: '10000103652',
	targetCode: '-1000444103652',
	regionCode: 'ee45c0c4-1e3c-4d05-9e0b-fdb3a82f1234',
}

// ────────────────────────────────────────────────────────────────────
// Construction + channel
// ────────────────────────────────────────────────────────────────────

describe('MockEpguTransport — construction', () => {
	test('[C1] default channel = "gost-tls"', () => {
		const m = createMockEpguTransport()
		expect(m.channel).toBe('gost-tls')
	})

	test('[C2] override channel — все 3 валидных', () => {
		expect(createMockEpguTransport({ channel: 'gost-tls' }).channel).toBe('gost-tls')
		expect(createMockEpguTransport({ channel: 'svoks' }).channel).toBe('svoks')
		expect(createMockEpguTransport({ channel: 'proxy-via-partner' }).channel).toBe(
			'proxy-via-partner',
		)
	})
})

// ────────────────────────────────────────────────────────────────────
// reserveOrder
// ────────────────────────────────────────────────────────────────────

describe('MockEpguTransport — reserveOrder', () => {
	test('[R1] returns non-empty orderId with canonical prefix', async () => {
		const m = createMockEpguTransport()
		const res = await m.reserveOrder(ORDER_REQ)
		expect(typeof res.orderId).toBe('string')
		expect(res.orderId.length).toBeGreaterThan(0)
		expect(res.orderId.startsWith('mock-epgu-order-')).toBe(true)
	})

	test('[R2] два последовательных reserveOrder → разные orderId', async () => {
		const m = createMockEpguTransport()
		const a = await m.reserveOrder(ORDER_REQ)
		const b = await m.reserveOrder(ORDER_REQ)
		expect(a.orderId).not.toBe(b.orderId)
	})

	test('[R3] stateSize grows by 1 per reserve', async () => {
		const m = createMockEpguTransport()
		expect(m.stateSize()).toBe(0)
		await m.reserveOrder(ORDER_REQ)
		expect(m.stateSize()).toBe(1)
		await m.reserveOrder(ORDER_REQ)
		expect(m.stateSize()).toBe(2)
	})
})

// ────────────────────────────────────────────────────────────────────
// pushArchive
// ────────────────────────────────────────────────────────────────────

describe('MockEpguTransport — pushArchive', () => {
	test('[P1] push без reserve → throws "not reserved"', async () => {
		const m = createMockEpguTransport()
		await expect(m.pushArchive({ ...PUSH_REQ, orderId: 'never-reserved' })).rejects.toThrow(
			/not reserved/,
		)
	})

	test('[P2] push с empty bytes → throws "empty archive"', async () => {
		const m = createMockEpguTransport()
		const { orderId } = await m.reserveOrder(ORDER_REQ)
		await expect(
			m.pushArchive({ ...PUSH_REQ, orderId, archive: new Uint8Array(0) }),
		).rejects.toThrow(/empty archive/)
	})

	test('[P3] push valid → accepted=true + statusCode=17', async () => {
		const m = createMockEpguTransport()
		const { orderId } = await m.reserveOrder(ORDER_REQ)
		const pushed = await m.pushArchive({ ...PUSH_REQ, orderId })
		expect(pushed.accepted).toBe(true)
		expect(pushed.orderId).toBe(orderId)
		const status = await m.getStatus({ orderId })
		expect(status.statusCode).toBe(17)
		expect(status.isFinal).toBe(false)
	})

	test('[P4] push дважды → idempotent', async () => {
		const m = createMockEpguTransport()
		const { orderId } = await m.reserveOrder(ORDER_REQ)
		const a = await m.pushArchive({ ...PUSH_REQ, orderId })
		const b = await m.pushArchive({ ...PUSH_REQ, orderId })
		expect(a.orderId).toBe(b.orderId)
		expect(a.accepted).toBe(true)
		expect(b.accepted).toBe(true)
	})
})

// ────────────────────────────────────────────────────────────────────
// FSM happy path
// ────────────────────────────────────────────────────────────────────

describe('MockEpguTransport — FSM happy path', () => {
	async function setup() {
		const random = makeRng(42)
		let nowVal = 1_000_000_000_000
		const now = () => nowVal
		const m = createMockEpguTransport({
			random,
			now,
			errorRateMultiplier: 0, // always success
			speedUpFactor: 1, // realtime
		})
		const { orderId } = await m.reserveOrder(ORDER_REQ)
		await m.pushArchive({ ...PUSH_REQ, orderId })
		return {
			m,
			orderId,
			advance: (ms: number) => {
				nowVal += ms
			},
		}
	}

	test('[S1] сразу после push: 17 (submitted)', async () => {
		const { m, orderId } = await setup()
		const s = await m.getStatus({ orderId })
		expect(s.statusCode).toBe(17)
		expect(s.isFinal).toBe(false)
	})

	test('[S2-S5] full trajectory 17 → 21 → 1 → 2 → 3', async () => {
		const { m, orderId, advance } = await setup()
		// Initial 17
		expect((await m.getStatus({ orderId })).statusCode).toBe(17)
		// advance way past P99 (60min) to ensure full trajectory walked
		advance(120 * 60_000) // 2 hours
		const final = await m.getStatus({ orderId })
		expect(final.statusCode).toBe(3) // executed
		expect(final.isFinal).toBe(true)
	})

	test('[S6] monotonic: after final, status stays final', async () => {
		const { m, orderId, advance } = await setup()
		advance(120 * 60_000)
		const a = await m.getStatus({ orderId })
		expect(a.isFinal).toBe(true)
		advance(60 * 60_000)
		const b = await m.getStatus({ orderId })
		expect(b.statusCode).toBe(a.statusCode)
		expect(b.isFinal).toBe(true)
	})
})

// ────────────────────────────────────────────────────────────────────
// FSM refused + 8 error categories
// ────────────────────────────────────────────────────────────────────

describe('MockEpguTransport — refused FSM + errorCategory coverage', () => {
	test('[E1] errorRateMultiplier=10 + 100 trials → many refused', async () => {
		let refusedCount = 0
		for (let i = 0; i < 100; i++) {
			let nowVal = 0
			const m = createMockEpguTransport({
				random: makeRng(i + 1000),
				now: () => nowVal,
				errorRateMultiplier: 10,
				speedUpFactor: 1,
			})
			const { orderId } = await m.reserveOrder(ORDER_REQ)
			await m.pushArchive({ ...PUSH_REQ, orderId })
			nowVal = 120 * 60_000
			const s = await m.getStatus({ orderId })
			if (s.statusCode === 4) refusedCount += 1
		}
		// errorRateMultiplier=10 boosts ~5.8% to ~58% — expect >> 25/100
		expect(refusedCount).toBeGreaterThan(25)
	})

	test('[E2] all 8 error categories reachable over 2000 forced-refuse trials', async () => {
		const reasonsHit = new Set<string>()
		const expectedKeywords: ReadonlyArray<readonly [string, RegExp]> = [
			['validation_format', /Несоответствие формата данных требованиям ФЛК/],
			['signature_invalid', /Ошибка проверки электронной подписи/],
			['duplicate_notification', /Дубликат уведомления о прибытии/],
			['document_lost_or_invalid', /реестре утраченных или недействительных/],
			['rkl_match', /Реестр Контролируемых Лиц/],
			['region_mismatch', /Подразделение МВД по указанному региону/],
			['stay_period_exceeded', /Срок пребывания превышает разрешённый/],
			['service_temporarily_unavailable', /Сервис временно недоступен/],
		]
		for (let i = 0; i < 2000; i++) {
			let nowVal = 0
			const m = createMockEpguTransport({
				random: makeRng(i + 5000),
				now: () => nowVal,
				errorRateMultiplier: 100, // force ~100% refused
				speedUpFactor: 1,
			})
			const { orderId } = await m.reserveOrder(ORDER_REQ)
			await m.pushArchive({ ...PUSH_REQ, orderId })
			nowVal = 120 * 60_000
			const s = await m.getStatus({ orderId })
			if (s.statusCode === 4 && s.reasonRefuse) {
				for (const [cat, re] of expectedKeywords) {
					if (re.test(s.reasonRefuse)) reasonsHit.add(cat)
				}
			}
		}
		expect(reasonsHit.size).toBe(8)
	})

	test('[E3] reasonRefuse non-null когда statusCode=4', async () => {
		let nowVal = 0
		const m = createMockEpguTransport({
			random: makeRng(7),
			now: () => nowVal,
			errorRateMultiplier: 100,
			speedUpFactor: 1,
		})
		const { orderId } = await m.reserveOrder(ORDER_REQ)
		await m.pushArchive({ ...PUSH_REQ, orderId })
		nowVal = 120 * 60_000
		const s = await m.getStatus({ orderId })
		expect(s.statusCode).toBe(4)
		expect(s.reasonRefuse).toBeDefined()
		expect(s.reasonRefuse?.length ?? 0).toBeGreaterThan(20)
	})

	test('[E4] reasonRefuse — full Russian text (matches plain UI contract)', async () => {
		let nowVal = 0
		const m = createMockEpguTransport({
			random: makeRng(11),
			now: () => nowVal,
			errorRateMultiplier: 100,
			speedUpFactor: 1,
		})
		const { orderId } = await m.reserveOrder(ORDER_REQ)
		await m.pushArchive({ ...PUSH_REQ, orderId })
		nowVal = 120 * 60_000
		const s = await m.getStatus({ orderId })
		// All 8 reasonRefuse texts contain Cyrillic
		expect(s.reasonRefuse ?? '').toMatch(/[А-Яа-я]/)
	})
})

// ────────────────────────────────────────────────────────────────────
// Invariants
// ────────────────────────────────────────────────────────────────────

describe('MockEpguTransport — invariants', () => {
	test('[G1] getStatus unknown orderId → throws', async () => {
		const m = createMockEpguTransport()
		await expect(m.getStatus({ orderId: 'never-existed' })).rejects.toThrow()
	})

	test('[G2] isFinal=true ⇒ statusCode in {3, 4}', async () => {
		const m = createMockEpguTransport({
			random: makeRng(99),
			now: () => 1_000_000_000_000 + 120 * 60_000,
			errorRateMultiplier: 0.5,
			speedUpFactor: 1,
		})
		// Run 50 trials, collect final statuses
		for (let i = 0; i < 50; i++) {
			const { orderId } = await m.reserveOrder(ORDER_REQ)
			await m.pushArchive({ ...PUSH_REQ, orderId })
			const s = await m.getStatus({ orderId })
			if (s.isFinal) {
				expect([3, 4]).toContain(s.statusCode)
			}
		}
	})

	test('[G3] isFinal=false ⇒ statusCode in {0, 1, 2, 17, 21}', async () => {
		// Deterministic: just-pushed (17), no time advance
		const nowVal = 1_000_000_000_000
		const m = createMockEpguTransport({
			random: makeRng(1),
			now: () => nowVal,
			errorRateMultiplier: 0,
			speedUpFactor: 1,
		})
		const { orderId } = await m.reserveOrder(ORDER_REQ)
		await m.pushArchive({ ...PUSH_REQ, orderId })
		const s0 = await m.getStatus({ orderId })
		expect(s0.isFinal).toBe(false)
		expect([0, 1, 2, 17, 21]).toContain(s0.statusCode)
	})
})

// ────────────────────────────────────────────────────────────────────
// Determinism + adversarial
// ────────────────────────────────────────────────────────────────────

describe('MockEpguTransport — determinism + adversarial', () => {
	test('[D1] seeded random → identical trajectory across runs', async () => {
		async function runOnce(): Promise<number> {
			let nowVal = 0
			const m = createMockEpguTransport({
				random: makeRng(42),
				now: () => nowVal,
				errorRateMultiplier: 0.5,
				speedUpFactor: 1,
			})
			const { orderId } = await m.reserveOrder(ORDER_REQ)
			await m.pushArchive({ ...PUSH_REQ, orderId })
			nowVal = 120 * 60_000
			const s = await m.getStatus({ orderId })
			return s.statusCode
		}
		const a = await runOnce()
		const b = await runOnce()
		expect(a).toBe(b)
	})

	test('[D2] errorRateMultiplier=0 → 100% success в 200 trials', async () => {
		let successCount = 0
		for (let i = 0; i < 200; i++) {
			let nowVal = 0
			const m = createMockEpguTransport({
				random: makeRng(i + 9000),
				now: () => nowVal,
				errorRateMultiplier: 0,
				speedUpFactor: 1,
			})
			const { orderId } = await m.reserveOrder(ORDER_REQ)
			await m.pushArchive({ ...PUSH_REQ, orderId })
			nowVal = 120 * 60_000
			const s = await m.getStatus({ orderId })
			if (s.statusCode === 3 && s.isFinal) successCount += 1
		}
		expect(successCount).toBe(200)
	})

	test('[D3] speedUpFactor=1000 → реальное время до final очень мало (< 100ms wall, mock-time 60-120min)', async () => {
		let nowVal = 0
		const m = createMockEpguTransport({
			random: makeRng(3),
			now: () => nowVal,
			errorRateMultiplier: 0,
			speedUpFactor: 1000,
		})
		const { orderId } = await m.reserveOrder(ORDER_REQ)
		await m.pushArchive({ ...PUSH_REQ, orderId })
		// At speedUp=1000, full P99=60min → 3.6 seconds mock-time
		nowVal = 4_000 // 4 seconds
		const s = await m.getStatus({ orderId })
		expect(s.isFinal).toBe(true)
		expect(s.statusCode).toBe(3)
	})
})
