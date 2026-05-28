/**
 * OstrovokStore YDB integration tests — Round 14.5 re-do.
 *
 * Empirically validates the YDB-backed store против local YDB Docker (matches
 * production runtime). Proves multi-instance state coherence: two store
 * instances pointed at the same YDB tenant share state — closes the pre-
 * existing race (ETG-SMOKE / R12-11 / R13-9) where YC Serverless container
 * scale-out left module-scoped Maps inconsistent.
 *
 * Canon refs:
 *   - `feedback_deploy_as_debug_antipattern_2026_05_19.md` (mandatory local
 *     YDB Docker validation BEFORE push)
 *   - `feedback_round_14_self_review_6_rollback_lessons_2026_05_27.md`
 *     (Bun 1.3.14 test runner module-loading quirk — these tests intentionally
 *     use `getTestSql()` pattern which works in `bun test` reliably, unlike
 *     `driver.createClient` direct calls)
 *
 * Tests names follow `[OSTRYDB<n>]` numbering.
 *
 * Setup requires local YDB Docker (`docker-compose up ydb`) + migration 0080
 * applied. Migration creates `mockOtaOstrovokBookHash`, `mockOtaOstrovokFormStage`,
 * `mockOtaOstrovokBooking` tables.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { getTestSql, setupTestDb, teardownTestDb } from '../../../../tests/db-setup.ts'
import { createYdbOstrovokStore } from './store.ydb.ts'

const TEST_TENANT = `test_ostrovok_ydb_${crypto.randomUUID().slice(0, 12)}`

describe('OstrovokStore YDB integration', () => {
	let store: ReturnType<typeof createYdbOstrovokStore>

	beforeAll(async () => {
		await setupTestDb()
		store = createYdbOstrovokStore(getTestSql(), { tenantId: TEST_TENANT })
	})

	afterAll(async () => {
		// Clean tenant-scoped state — afterAll, not per-test, чтобы tests
		// строят на каждом другом для empirical multi-step verification.
		await store.__reset()
		await teardownTestDb()
	})

	beforeEach(async () => {
		// Each test starts with empty state — explicit isolation.
		await store.__reset()
	})

	test('[OSTRYDB1] storeBookHash + getBookHash round-trips через YDB', async () => {
		const bookHash = 'a'.repeat(32)
		await store.storeBookHash({
			bookHash,
			hid: 8473727,
			checkin: '2027-06-15',
			checkout: '2027-06-17',
			adults: 2,
			children: [],
			currency: 'RUB',
			dailyPrices: [7000, 7000],
			totalPrice: 14000,
			roomName: 'Стандарт',
			mealName: 'Без питания',
		})

		const ctx = await store.getBookHash(bookHash)
		expect(ctx === null).toBe(false)
		if (ctx === null) throw new Error('unreachable')
		expect(ctx.hid).toBe(8473727)
		expect(ctx.checkin).toBe('2027-06-15')
		expect(ctx.checkout).toBe('2027-06-17')
		expect(ctx.totalPrice).toBe(14000)
		expect(ctx.dailyPrices).toEqual([7000, 7000])
	})

	test('[OSTRYDB2] multi-instance coherence — second store sees first write', async () => {
		// CRITICAL test: this is THE empirical proof что Round 14.5 fix actually
		// closes the multi-instance race. Two independent store instances
		// pointed at SAME tenant в SAME YDB → second sees first's write.
		// (With in-memory state.ts pre-Round-14.5, two instances had separate
		// Maps → race condition manifested as ETG-SMOKE flakes.)
		const storeA = createYdbOstrovokStore(getTestSql(), { tenantId: TEST_TENANT })
		const storeB = createYdbOstrovokStore(getTestSql(), { tenantId: TEST_TENANT })

		const bookHash = 'b'.repeat(32)
		await storeA.storeBookHash({
			bookHash,
			hid: 8473727,
			checkin: '2027-07-01',
			checkout: '2027-07-03',
			adults: 1,
			children: [],
			currency: 'RUB',
			dailyPrices: [5000, 5000],
			totalPrice: 10000,
			roomName: 'Эконом',
			mealName: 'Завтрак',
		})

		const ctxFromB = await storeB.getBookHash(bookHash)
		expect(ctxFromB === null).toBe(false)
		if (ctxFromB === null) throw new Error('unreachable')
		expect(ctxFromB.totalPrice).toBe(10000)
	})

	test('[OSTRYDB3] expired bookHash returns null (lazy + native TTL combined)', async () => {
		const bookHash = 'c'.repeat(32)
		const longAgo = Date.now() - 25 * 60 * 60 * 1000 // 25 hours ago
		await store.storeBookHash({
			bookHash,
			hid: 8473727,
			checkin: '2027-06-15',
			checkout: '2027-06-17',
			adults: 2,
			children: [],
			currency: 'RUB',
			dailyPrices: [7000, 7000],
			totalPrice: 14000,
			roomName: 'Стандарт',
			mealName: 'Без питания',
			nowMs: longAgo,
		})

		// Query at current time → expired by 1 hour → returns null без TTL sweep.
		const ctx = await store.getBookHash(bookHash)
		expect(ctx).toBe(null)
	})

	test('[OSTRYDB4] full 3-stage flow: bookHash → formStage → finalize → getBooking', async () => {
		// Replays end-to-end ETG 5-stage flow at the store level. Verifies
		// FSM coherence через YDB persistence.
		const bookHash = 'd'.repeat(32)
		const partnerOrderId = '12345678-1234-4abc-9def-1234567890ab'
		const orderId = 999_999_999_001
		const itemId = 999_999_999_002

		await store.storeBookHash({
			bookHash,
			hid: 8473727,
			checkin: '2027-06-15',
			checkout: '2027-06-17',
			adults: 2,
			children: [],
			currency: 'RUB',
			dailyPrices: [7000, 7000],
			totalPrice: 14000,
			roomName: 'Стандарт',
			mealName: 'Без питания',
		})

		const bookHashCtx = await store.getBookHash(bookHash)
		if (bookHashCtx === null) throw new Error('bookHash lookup failed')

		await store.storeFormStage({
			partnerOrderId,
			bookHash,
			orderId,
			itemId,
			currency: 'RUB',
			totalAmount: 14000,
		})

		const formStage = await store.getFormStage(partnerOrderId)
		if (formStage === null) throw new Error('formStage lookup failed')
		expect(formStage.orderId).toBe(orderId)
		expect(formStage.itemId).toBe(itemId)

		const booking = await store.finalizeBooking({
			form: formStage,
			bookHashContext: bookHashCtx,
			customerEmail: 'demo@example.com',
			customerPhone: '+70000000001',
			guests: [{ firstName: 'Иван', lastName: 'Иванов', isChild: false }],
		})

		expect(booking.status).toBe('confirmed')
		expect(booking.orderId).toBe(orderId)
		expect(booking.partnerOrderId).toBe(partnerOrderId)

		// finalizeBooking removes the form-stage record.
		const formStageAfter = await store.getFormStage(partnerOrderId)
		expect(formStageAfter).toBe(null)

		// Booking now retrievable via getBooking.
		const persisted = await store.getBooking(partnerOrderId)
		expect(persisted === null).toBe(false)
		if (persisted === null) throw new Error('unreachable')
		expect(persisted.status).toBe('confirmed')
		expect(persisted.customerEmail).toBe('demo@example.com')
	})

	test('[OSTRYDB5] cancelBooking is monotonic — confirmed → cancelled → already_cancelled', async () => {
		const bookHash = 'e'.repeat(32)
		const partnerOrderId = '87654321-1234-4abc-9def-1234567890cd'
		const orderId = 888_888_888_001
		const itemId = 888_888_888_002

		await store.storeBookHash({
			bookHash,
			hid: 8473727,
			checkin: '2027-06-15',
			checkout: '2027-06-17',
			adults: 1,
			children: [],
			currency: 'RUB',
			dailyPrices: [5000, 5000],
			totalPrice: 10000,
			roomName: 'Эконом',
			mealName: 'Без питания',
		})
		const bookHashCtx = await store.getBookHash(bookHash)
		if (bookHashCtx === null) throw new Error('bookHash setup failed')

		await store.storeFormStage({
			partnerOrderId,
			bookHash,
			orderId,
			itemId,
			currency: 'RUB',
			totalAmount: 10000,
		})
		const form = await store.getFormStage(partnerOrderId)
		if (form === null) throw new Error('formStage setup failed')

		await store.finalizeBooking({
			form,
			bookHashContext: bookHashCtx,
			customerEmail: 'cancel@example.com',
			customerPhone: '+70000000002',
			guests: [{ firstName: 'Пётр', lastName: 'Петров', isChild: false }],
		})

		const first = await store.cancelBooking(partnerOrderId)
		expect(first).toBe('cancelled')

		const second = await store.cancelBooking(partnerOrderId)
		expect(second).toBe('already_cancelled')

		const notFound = await store.cancelBooking('99999999-1234-4abc-9def-1234567890ee')
		expect(notFound).toBe('not_found')
	})

	test('[OSTRYDB6] __reset clears all tenant-scoped state', async () => {
		const bookHash = 'f'.repeat(32)
		await store.storeBookHash({
			bookHash,
			hid: 8473727,
			checkin: '2027-06-15',
			checkout: '2027-06-17',
			adults: 1,
			children: [],
			currency: 'RUB',
			dailyPrices: [5000],
			totalPrice: 5000,
			roomName: 'Single',
			mealName: 'Нет',
		})
		expect((await store.__listBookHashes()).length).toBe(1)

		await store.__reset()
		expect((await store.__listBookHashes()).length).toBe(0)
		expect((await store.__listFormStages()).length).toBe(0)
		expect((await store.__listBookings()).length).toBe(0)
	})
})
