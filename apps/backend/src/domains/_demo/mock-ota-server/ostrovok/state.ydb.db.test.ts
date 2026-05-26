/**
 * Round 14 self-review #6 — Ostrovok YDB store integration tests (real YDB).
 *
 * Validates the YDB-backed primary-state implementation. Runs against the
 * `pnpm test:db` lane which spins Docker YDB on port 2236.
 *
 * Closes test-coverage canon gap (`feedback_critical_fix_test_coverage`):
 * the `createInMemoryOstrovokStore` is exercised by the routes unit tests,
 * but the YDB code path was never directly tested before this commit. Same
 * pattern as `dcr.ydb.repo.db.test.ts` canon precedent.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { sql } from '../../../../db/index.ts'
import { createYdbOstrovokStore, generateBookHash, type OstrovokStore } from './state.ts'

describe('Ostrovok YDB store — integration (real YDB)', () => {
	let store: OstrovokStore
	const createdBookHashes: string[] = []
	const createdPartnerIds: string[] = []

	beforeEach(() => {
		store = createYdbOstrovokStore(sql)
	})

	afterEach(async () => {
		// Clean up test data — leave the table в a known-empty state.
		await store.__reset()
		createdBookHashes.length = 0
		createdPartnerIds.length = 0
	})

	test('[OSTRYDB1] storeBookHash + getBookHash round-trip persists across calls', async () => {
		const bookHash = generateBookHash()
		createdBookHashes.push(bookHash)
		await store.storeBookHash({
			bookHash,
			hid: 8473727,
			checkin: '2027-08-15',
			checkout: '2027-08-17',
			adults: 2,
			children: [],
			currency: 'RUB',
			dailyPrices: [7000, 7000],
			totalPrice: 14000,
			roomName: 'Стандартный',
			mealName: 'Без питания',
		})
		const ctx = await store.getBookHash(bookHash)
		expect(ctx).not.toBe(null)
		if (ctx === null) throw new Error('unreachable')
		expect(ctx.hid).toBe(8473727)
		expect(ctx.checkin).toBe('2027-08-15')
		expect(ctx.checkout).toBe('2027-08-17')
		expect(ctx.adults).toBe(2)
		expect(ctx.currency).toBe('RUB')
		expect(ctx.dailyPrices).toEqual([7000, 7000])
		expect(ctx.totalPrice).toBe(14000)
		expect(ctx.roomName).toBe('Стандартный')
		expect(ctx.mealName).toBe('Без питания')
	})

	test('[OSTRYDB2] getBookHash returns null for unknown hash', async () => {
		const ctx = await store.getBookHash('a'.repeat(32))
		expect(ctx).toBe(null)
	})

	test('[OSTRYDB3] storeFormStage + getFormStage round-trip persists', async () => {
		const bookHash = generateBookHash()
		await store.storeBookHash({
			bookHash,
			hid: 8473727,
			checkin: '2027-08-15',
			checkout: '2027-08-17',
			adults: 2,
			children: [],
			currency: 'RUB',
			dailyPrices: [7000, 7000],
			totalPrice: 14000,
			roomName: 'Стандартный',
			mealName: 'Без питания',
		})
		const partnerOrderId = `00000000-0000-4000-8000-${Date.now().toString().padStart(12, '0')}`
		createdPartnerIds.push(partnerOrderId)
		await store.storeFormStage({
			partnerOrderId,
			bookHash,
			orderId: 123456789012,
			itemId: 234567890123,
			currency: 'RUB',
			totalAmount: 14000,
		})
		const stage = await store.getFormStage(partnerOrderId)
		expect(stage).not.toBe(null)
		if (stage === null) throw new Error('unreachable')
		expect(stage.partnerOrderId).toBe(partnerOrderId)
		expect(stage.bookHash).toBe(bookHash)
		expect(stage.orderId).toBe(123456789012)
		expect(stage.itemId).toBe(234567890123)
		expect(stage.totalAmount).toBe(14000)
	})

	test('[OSTRYDB4] finalizeBooking promotes formStage к booking + deletes form row', async () => {
		const bookHash = generateBookHash()
		const partnerOrderId = `11111111-0000-4000-8000-${Date.now().toString().padStart(12, '0')}`
		createdBookHashes.push(bookHash)
		createdPartnerIds.push(partnerOrderId)

		await store.storeBookHash({
			bookHash,
			hid: 8473727,
			checkin: '2027-08-15',
			checkout: '2027-08-17',
			adults: 2,
			children: [],
			currency: 'RUB',
			dailyPrices: [7000, 7000],
			totalPrice: 14000,
			roomName: 'Стандартный',
			mealName: 'Без питания',
		})
		await store.storeFormStage({
			partnerOrderId,
			bookHash,
			orderId: 123456789012,
			itemId: 234567890123,
			currency: 'RUB',
			totalAmount: 14000,
		})

		const formCtx = await store.getFormStage(partnerOrderId)
		const bookHashCtx = await store.getBookHash(bookHash)
		if (formCtx === null || bookHashCtx === null) throw new Error('precondition failed')

		const booking = await store.finalizeBooking({
			form: formCtx,
			bookHashContext: bookHashCtx,
			customerEmail: 'petr@example.com',
			customerPhone: '+70000000002',
			guests: [{ firstName: 'Пётр', lastName: 'Петров', isChild: false }],
		})

		expect(booking.partnerOrderId).toBe(partnerOrderId)
		expect(booking.status).toBe('confirmed')
		expect(booking.customerEmail).toBe('petr@example.com')

		// Form-stage row deleted
		const formAfter = await store.getFormStage(partnerOrderId)
		expect(formAfter).toBe(null)
		// Booking row exists
		const bookingFetched = await store.getBooking(partnerOrderId)
		expect(bookingFetched).not.toBe(null)
		if (bookingFetched === null) throw new Error('unreachable')
		expect(bookingFetched.status).toBe('confirmed')
		expect(bookingFetched.customerEmail).toBe('petr@example.com')
		expect(bookingFetched.guests.length).toBe(1)
		expect(bookingFetched.guests[0]?.firstName).toBe('Пётр')
	})

	test('[OSTRYDB5] cancelBooking transitions confirmed → cancelled (idempotent on retry)', async () => {
		const bookHash = generateBookHash()
		const partnerOrderId = `22222222-0000-4000-8000-${Date.now().toString().padStart(12, '0')}`
		await store.storeBookHash({
			bookHash,
			hid: 8473727,
			checkin: '2027-08-15',
			checkout: '2027-08-17',
			adults: 2,
			children: [],
			currency: 'RUB',
			dailyPrices: [7000, 7000],
			totalPrice: 14000,
			roomName: 'Стандартный',
			mealName: 'Без питания',
		})
		await store.storeFormStage({
			partnerOrderId,
			bookHash,
			orderId: 123,
			itemId: 234,
			currency: 'RUB',
			totalAmount: 14000,
		})
		const formCtx = await store.getFormStage(partnerOrderId)
		const bookHashCtx = await store.getBookHash(bookHash)
		if (formCtx === null || bookHashCtx === null) throw new Error('precondition failed')

		await store.finalizeBooking({
			form: formCtx,
			bookHashContext: bookHashCtx,
			customerEmail: 'petr@example.com',
			customerPhone: '+70000000002',
			guests: [{ firstName: 'Пётр', lastName: 'Петров', isChild: false }],
		})

		const r1 = await store.cancelBooking(partnerOrderId)
		expect(r1).toBe('cancelled')
		const r2 = await store.cancelBooking(partnerOrderId)
		expect(r2).toBe('already_cancelled')
		const r3 = await store.cancelBooking('nonexistent-id')
		expect(r3).toBe('not_found')
	})

	test('[OSTRYDB6] cross-instance simulation — second store instance sees data from first (multi-instance state coherence)', async () => {
		// THIS IS THE KEY TEST — proves the migration fixed the production bug.
		// Two separate store instances share the same YDB tables. Multi-YC-instance
		// production analog: each instance creates its own `createYdbOstrovokStore(sql)`
		// but they all see the same persisted state.
		const storeA = createYdbOstrovokStore(sql)
		const storeB = createYdbOstrovokStore(sql)

		const bookHash = generateBookHash()
		await storeA.storeBookHash({
			bookHash,
			hid: 8473727,
			checkin: '2027-08-15',
			checkout: '2027-08-17',
			adults: 2,
			children: [],
			currency: 'RUB',
			dailyPrices: [7000, 7000],
			totalPrice: 14000,
			roomName: 'Стандартный',
			mealName: 'Без питания',
		})
		// Store B can read what Store A wrote — closes Run #112-114 multi-instance bug.
		const fromB = await storeB.getBookHash(bookHash)
		expect(fromB).not.toBe(null)
		if (fromB === null) throw new Error('multi-instance state coherence broken')
		expect(fromB.hid).toBe(8473727)
	})
})
