/**
 * YandexStore YDB integration tests — Round 14.6 multi-tenant rewrite.
 *
 * Mirrors `ostrovok/store.ydb.db.test.ts` pattern для Yandex shapes
 * (booking_token + order только, no 5-stage prebook FSM).
 *
 * Round 14.6 — store is tenant-agnostic; tenantId passed per call.
 * Empirically validates YDB persistence + multi-instance coherence
 * + cross-tenant isolation (no leak between tenantA + tenantB).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { getTestSql, setupTestDb, teardownTestDb } from '../../../../tests/db-setup.ts'
import { createYdbYandexStore } from './store.ydb.ts'

const TEST_TENANT = `test_yandex_ydb_${crypto.randomUUID().slice(0, 12)}`
const TEST_TENANT_B = `test_yandex_ydb_b_${crypto.randomUUID().slice(0, 12)}`

describe('YandexStore YDB integration', () => {
	let store: ReturnType<typeof createYdbYandexStore>

	beforeAll(async () => {
		await setupTestDb()
		store = createYdbYandexStore(getTestSql())
	})

	afterAll(async () => {
		await store.__reset(TEST_TENANT)
		await store.__reset(TEST_TENANT_B)
		await teardownTestDb()
	})

	beforeEach(async () => {
		await store.__reset(TEST_TENANT)
		await store.__reset(TEST_TENANT_B)
	})

	test('[YTRYDB1] storeBookingToken + getBookingToken round-trips через YDB', async () => {
		const token = 'AbCdEfGhIjKl'
		await store.storeBookingToken(TEST_TENANT, {
			token,
			hotelId: 'hotel_42',
			checkinDate: '2027-06-15',
			checkoutDate: '2027-06-17',
			adults: 2,
			children: 0,
			totalPriceMicros: 12_000_000_000n, // 12000 RUB
		})

		const ctx = await store.getBookingToken(TEST_TENANT, token)
		expect(ctx === null).toBe(false)
		if (ctx === null) throw new Error('unreachable')
		expect(ctx.hotelId).toBe('hotel_42')
		expect(ctx.adults).toBe(2)
		expect(ctx.totalPriceMicros).toBe(12_000_000_000n)
	})

	test('[YTRYDB2] multi-instance coherence — second store sees first write', async () => {
		const storeA = createYdbYandexStore(getTestSql())
		const storeB = createYdbYandexStore(getTestSql())

		const token = 'MnOpQrStUvWx'
		await storeA.storeBookingToken(TEST_TENANT, {
			token,
			hotelId: 'hotel_99',
			checkinDate: '2027-07-01',
			checkoutDate: '2027-07-02',
			adults: 1,
			children: 0,
			totalPriceMicros: 5_000_000_000n,
		})

		const ctxFromB = await storeB.getBookingToken(TEST_TENANT, token)
		expect(ctxFromB === null).toBe(false)
		if (ctxFromB === null) throw new Error('unreachable')
		expect(ctxFromB.hotelId).toBe('hotel_99')
		expect(ctxFromB.totalPriceMicros).toBe(5_000_000_000n)
	})

	test('[YTRYDB3] consumeBookingToken: single-use semantics', async () => {
		const token = 'CoNsUmEtOkEn'
		await store.storeBookingToken(TEST_TENANT, {
			token,
			hotelId: 'hotel_x',
			checkinDate: '2027-08-01',
			checkoutDate: '2027-08-03',
			adults: 2,
			children: 1,
			totalPriceMicros: 18_000_000_000n,
		})

		const first = await store.consumeBookingToken(TEST_TENANT, token)
		expect(first === null).toBe(false)
		if (first === null) throw new Error('unreachable')
		expect(first.hotelId).toBe('hotel_x')

		// Second consume must return null — single-use semantics preserved.
		const second = await store.consumeBookingToken(TEST_TENANT, token)
		expect(second).toBe(null)
	})

	test('[YTRYDB4] storeOrder + getOrder round-trip', async () => {
		const orderId = 'yt-order-test1234567'
		await store.storeOrder(TEST_TENANT, {
			orderId,
			bookingToken: 'consumed-tok',
			customerEmail: 'guest@example.com',
			customerPhone: '+70000000001',
			status: 'CONFIRMED',
			externalReservationId: 'ext_demo_1',
			createdAtMs: Date.now(),
			guests: [{ firstName: 'Иван', lastName: 'Иванов', isChild: false }],
		})

		const fetched = await store.getOrder(TEST_TENANT, orderId)
		expect(fetched === null).toBe(false)
		if (fetched === null) throw new Error('unreachable')
		expect(fetched.status).toBe('CONFIRMED')
		expect(fetched.customerEmail).toBe('guest@example.com')
		expect(fetched.guests.length).toBe(1)
	})

	test('[YTRYDB5] cancelOrder is monotonic — CONFIRMED → CANCELLED → already_cancelled', async () => {
		const orderId = 'yt-order-cancel001'
		await store.storeOrder(TEST_TENANT, {
			orderId,
			bookingToken: 'cancel-tok',
			customerEmail: 'cancel@example.com',
			customerPhone: '+70000000002',
			status: 'CONFIRMED',
			externalReservationId: 'ext_demo_cancel',
			createdAtMs: Date.now(),
			guests: [{ firstName: 'Пётр', lastName: 'Петров', isChild: false }],
		})

		const first = await store.cancelOrder(TEST_TENANT, orderId)
		expect(first).toBe('cancelled')

		const second = await store.cancelOrder(TEST_TENANT, orderId)
		expect(second).toBe('already_cancelled')

		const notFound = await store.cancelOrder(TEST_TENANT, 'yt-order-nonexistent')
		expect(notFound).toBe('not_found')

		const afterCancel = await store.getOrder(TEST_TENANT, orderId)
		if (afterCancel === null) throw new Error('order disappeared after cancel')
		expect(afterCancel.status).toBe('CANCELLED')
	})

	test('[YTRYDB6] __reset clears all tenant state', async () => {
		await store.storeBookingToken(TEST_TENANT, {
			token: 'TokToBeWiped',
			hotelId: 'hotel_w',
			checkinDate: '2027-09-01',
			checkoutDate: '2027-09-03',
			adults: 1,
			children: 0,
			totalPriceMicros: 8_000_000_000n,
		})
		expect((await store.__listBookingTokens(TEST_TENANT)).length).toBe(1)

		await store.__reset(TEST_TENANT)
		expect((await store.__listBookingTokens(TEST_TENANT)).length).toBe(0)
		expect((await store.__listOrders(TEST_TENANT)).length).toBe(0)
	})

	test('[YTRYDB7] cross-tenant isolation — tenantA write invisible к tenantB', async () => {
		const sharedToken = 'XtNanT1S0lAt10n'
		await store.storeBookingToken(TEST_TENANT, {
			token: sharedToken,
			hotelId: 'hotel_isolation_a',
			checkinDate: '2027-10-01',
			checkoutDate: '2027-10-02',
			adults: 2,
			children: 0,
			totalPriceMicros: 9_000_000_000n,
		})

		const ctxFromB = await store.getBookingToken(TEST_TENANT_B, sharedToken)
		expect(ctxFromB).toBe(null)

		const ctxFromA = await store.getBookingToken(TEST_TENANT, sharedToken)
		expect(ctxFromA === null).toBe(false)
		if (ctxFromA === null) throw new Error('unreachable')
		expect(ctxFromA.hotelId).toBe('hotel_isolation_a')
	})
})
