/**
 * YandexStore YDB integration tests — Round 14.5 re-do.
 *
 * Mirrors `ostrovok/store.ydb.db.test.ts` pattern для Yandex shapes
 * (booking_token + order только, no 5-stage prebook FSM).
 *
 * Empirically validates YDB persistence + multi-instance coherence.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { getTestSql, setupTestDb, teardownTestDb } from '../../../../tests/db-setup.ts'
import { createYdbYandexStore } from './store.ydb.ts'

const TEST_TENANT = `test_yandex_ydb_${crypto.randomUUID().slice(0, 12)}`

describe('YandexStore YDB integration', () => {
	let store: ReturnType<typeof createYdbYandexStore>

	beforeAll(async () => {
		await setupTestDb()
		store = createYdbYandexStore(getTestSql(), { tenantId: TEST_TENANT })
	})

	afterAll(async () => {
		await store.__reset()
		await teardownTestDb()
	})

	beforeEach(async () => {
		await store.__reset()
	})

	test('[YTRYDB1] storeBookingToken + getBookingToken round-trips через YDB', async () => {
		const token = 'AbCdEfGhIjKl'
		await store.storeBookingToken({
			token,
			hotelId: 'hotel_42',
			checkinDate: '2027-06-15',
			checkoutDate: '2027-06-17',
			adults: 2,
			children: 0,
			totalPriceMicros: 12_000_000_000n, // 12000 RUB
		})

		const ctx = await store.getBookingToken(token)
		expect(ctx === null).toBe(false)
		if (ctx === null) throw new Error('unreachable')
		expect(ctx.hotelId).toBe('hotel_42')
		expect(ctx.adults).toBe(2)
		expect(ctx.totalPriceMicros).toBe(12_000_000_000n)
	})

	test('[YTRYDB2] multi-instance coherence — second store sees first write', async () => {
		const storeA = createYdbYandexStore(getTestSql(), { tenantId: TEST_TENANT })
		const storeB = createYdbYandexStore(getTestSql(), { tenantId: TEST_TENANT })

		const token = 'MnOpQrStUvWx'
		await storeA.storeBookingToken({
			token,
			hotelId: 'hotel_99',
			checkinDate: '2027-07-01',
			checkoutDate: '2027-07-02',
			adults: 1,
			children: 0,
			totalPriceMicros: 5_000_000_000n,
		})

		const ctxFromB = await storeB.getBookingToken(token)
		expect(ctxFromB === null).toBe(false)
		if (ctxFromB === null) throw new Error('unreachable')
		expect(ctxFromB.hotelId).toBe('hotel_99')
		expect(ctxFromB.totalPriceMicros).toBe(5_000_000_000n)
	})

	test('[YTRYDB3] consumeBookingToken: single-use semantics', async () => {
		const token = 'CoNsUmEtOkEn'
		await store.storeBookingToken({
			token,
			hotelId: 'hotel_x',
			checkinDate: '2027-08-01',
			checkoutDate: '2027-08-03',
			adults: 2,
			children: 1,
			totalPriceMicros: 18_000_000_000n,
		})

		const first = await store.consumeBookingToken(token)
		expect(first === null).toBe(false)
		if (first === null) throw new Error('unreachable')
		expect(first.hotelId).toBe('hotel_x')

		// Second consume must return null — single-use semantics preserved.
		const second = await store.consumeBookingToken(token)
		expect(second).toBe(null)
	})

	test('[YTRYDB4] storeOrder + getOrder round-trip', async () => {
		const orderId = 'yt-order-test1234567'
		await store.storeOrder({
			orderId,
			bookingToken: 'consumed-tok',
			customerEmail: 'guest@example.com',
			customerPhone: '+70000000001',
			status: 'CONFIRMED',
			externalReservationId: 'ext_demo_1',
			createdAtMs: Date.now(),
			guests: [{ firstName: 'Иван', lastName: 'Иванов', isChild: false }],
		})

		const fetched = await store.getOrder(orderId)
		expect(fetched === null).toBe(false)
		if (fetched === null) throw new Error('unreachable')
		expect(fetched.status).toBe('CONFIRMED')
		expect(fetched.customerEmail).toBe('guest@example.com')
		expect(fetched.guests.length).toBe(1)
	})

	test('[YTRYDB5] cancelOrder is monotonic — CONFIRMED → CANCELLED → already_cancelled', async () => {
		const orderId = 'yt-order-cancel001'
		await store.storeOrder({
			orderId,
			bookingToken: 'cancel-tok',
			customerEmail: 'cancel@example.com',
			customerPhone: '+70000000002',
			status: 'CONFIRMED',
			externalReservationId: 'ext_demo_cancel',
			createdAtMs: Date.now(),
			guests: [{ firstName: 'Пётр', lastName: 'Петров', isChild: false }],
		})

		const first = await store.cancelOrder(orderId)
		expect(first).toBe('cancelled')

		const second = await store.cancelOrder(orderId)
		expect(second).toBe('already_cancelled')

		const notFound = await store.cancelOrder('yt-order-nonexistent')
		expect(notFound).toBe('not_found')

		const afterCancel = await store.getOrder(orderId)
		if (afterCancel === null) throw new Error('order disappeared after cancel')
		expect(afterCancel.status).toBe('CANCELLED')
	})

	test('[YTRYDB6] __reset clears all tenant state', async () => {
		await store.storeBookingToken({
			token: 'TokToBeWiped',
			hotelId: 'hotel_w',
			checkinDate: '2027-09-01',
			checkoutDate: '2027-09-03',
			adults: 1,
			children: 0,
			totalPriceMicros: 8_000_000_000n,
		})
		expect((await store.__listBookingTokens()).length).toBe(1)

		await store.__reset()
		expect((await store.__listBookingTokens()).length).toBe(0)
		expect((await store.__listOrders()).length).toBe(0)
	})
})
