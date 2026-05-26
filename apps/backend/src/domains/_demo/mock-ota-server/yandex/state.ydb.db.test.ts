/**
 * Round 14 self-review #6 — Yandex YDB store integration tests (real YDB).
 *
 * Companion к `state.ydb.db.test.ts` для the Ostrovok store. Validates the
 * Yandex.Путешествия demo state YDB-backed implementation.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { sql } from '../../../../db/index.ts'
import {
	createYdbYandexStore,
	generateBookingToken,
	generateOrderId,
	type YandexStore,
} from './state.ts'

describe('Yandex YDB store — integration (real YDB)', () => {
	let store: YandexStore

	beforeEach(() => {
		store = createYdbYandexStore(sql)
	})

	afterEach(async () => {
		await store.__reset()
	})

	test('[YTYDB1] storeBookingToken + getBookingToken round-trip', async () => {
		const token = generateBookingToken()
		await store.storeBookingToken({
			token,
			hotelId: 'demo-hotel-sochi',
			checkinDate: '2027-08-15',
			checkoutDate: '2027-08-17',
			adults: 2,
			children: 0,
			totalPriceMicros: 12_000_000_000n,
		})
		const ctx = await store.getBookingToken(token)
		expect(ctx).not.toBe(null)
		if (ctx === null) throw new Error('unreachable')
		expect(ctx.hotelId).toBe('demo-hotel-sochi')
		expect(ctx.checkinDate).toBe('2027-08-15')
		expect(ctx.checkoutDate).toBe('2027-08-17')
		expect(ctx.adults).toBe(2)
		expect(ctx.children).toBe(0)
		expect(ctx.totalPriceMicros).toBe(12_000_000_000n)
	})

	test('[YTYDB2] consumeBookingToken deletes the token (single-use semantic)', async () => {
		const token = generateBookingToken()
		await store.storeBookingToken({
			token,
			hotelId: 'demo-hotel-sochi',
			checkinDate: '2027-08-15',
			checkoutDate: '2027-08-17',
			adults: 2,
			children: 0,
			totalPriceMicros: 12_000_000_000n,
		})
		const first = await store.consumeBookingToken(token)
		expect(first).not.toBe(null)
		const second = await store.consumeBookingToken(token)
		expect(second).toBe(null)
	})

	test('[YTYDB3] storeOrder + getOrder + cancelOrder lifecycle', async () => {
		const token = generateBookingToken()
		const orderId = generateOrderId()
		await store.storeOrder({
			orderId,
			bookingToken: token,
			customerEmail: 'ivan@example.com',
			customerPhone: '+70000000001',
			status: 'CONFIRMED',
			externalReservationId: 'ext-12345',
			createdAtMs: Date.now(),
			guests: [{ firstName: 'Иван', lastName: 'Иванов', isChild: false }],
		})
		const order = await store.getOrder(orderId)
		expect(order).not.toBe(null)
		if (order === null) throw new Error('unreachable')
		expect(order.status).toBe('CONFIRMED')
		expect(order.customerEmail).toBe('ivan@example.com')
		expect(order.guests.length).toBe(1)

		const r1 = await store.cancelOrder(orderId)
		expect(r1).toBe('cancelled')
		const r2 = await store.cancelOrder(orderId)
		expect(r2).toBe('already_cancelled')
		const r3 = await store.cancelOrder('nonexistent')
		expect(r3).toBe('not_found')
	})

	test('[YTYDB4] cross-instance state coherence — store B reads store A writes', async () => {
		const storeA = createYdbYandexStore(sql)
		const storeB = createYdbYandexStore(sql)

		const token = generateBookingToken()
		await storeA.storeBookingToken({
			token,
			hotelId: 'demo-hotel-sochi',
			checkinDate: '2027-08-15',
			checkoutDate: '2027-08-17',
			adults: 2,
			children: 0,
			totalPriceMicros: 12_000_000_000n,
		})
		const fromB = await storeB.getBookingToken(token)
		expect(fromB).not.toBe(null)
		if (fromB === null) throw new Error('multi-instance state coherence broken')
		expect(fromB.hotelId).toBe('demo-hotel-sochi')
	})
})
