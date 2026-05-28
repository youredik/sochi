/**
 * Ostrovok / ETG mock-OTA state store — multi-tenant interface.
 *
 * Round 14.6 strategic refactor — store methods accept `tenantId` per call.
 * Pattern matches idempotency.repo.ts canonical multi-tenant design.
 */

import { randomBytes, randomInt } from 'node:crypto'

const BOOK_HASH_TTL_MS = 24 * 60 * 60 * 1000
const FORM_STAGE_TTL_MS = 60 * 60 * 1000

export interface BookHashContext {
	readonly hid: number
	readonly checkin: string
	readonly checkout: string
	readonly adults: number
	readonly children: ReadonlyArray<number>
	readonly currency: 'RUB'
	readonly dailyPrices: ReadonlyArray<number>
	readonly totalPrice: number
	readonly roomName: string
	readonly mealName: string
	readonly issuedAtMs: number
	readonly expiresAtMs: number
}

export interface FormStageContext {
	readonly partnerOrderId: string
	readonly bookHash: string
	readonly orderId: number
	readonly itemId: number
	readonly currency: 'RUB'
	readonly totalAmount: number
	readonly createdAtMs: number
	readonly expiresAtMs: number
}

export interface FinalizedBooking {
	readonly partnerOrderId: string
	readonly orderId: number
	readonly itemId: number
	readonly hid: number
	readonly checkin: string
	readonly checkout: string
	readonly adults: number
	readonly children: ReadonlyArray<number>
	readonly currency: 'RUB'
	readonly totalAmount: number
	readonly status: 'confirmed' | 'cancelled'
	readonly customerEmail: string
	readonly customerPhone: string
	readonly guests: ReadonlyArray<{
		readonly firstName: string
		readonly lastName: string
		readonly isChild: boolean
		readonly age?: number
	}>
	readonly createdAtMs: number
}

export interface FinalizeBookingInput {
	readonly form: FormStageContext
	readonly bookHashContext: BookHashContext
	readonly customerEmail: string
	readonly customerPhone: string
	readonly guests: ReadonlyArray<{
		readonly firstName: string
		readonly lastName: string
		readonly isChild: boolean
		readonly age?: number
	}>
	readonly nowMs?: number
}

export interface StoreBookHashInput {
	readonly bookHash: string
	readonly hid: number
	readonly checkin: string
	readonly checkout: string
	readonly adults: number
	readonly children: ReadonlyArray<number>
	readonly currency: 'RUB'
	readonly dailyPrices: ReadonlyArray<number>
	readonly totalPrice: number
	readonly roomName: string
	readonly mealName: string
	readonly nowMs?: number
}

export interface StoreFormStageInput {
	readonly partnerOrderId: string
	readonly bookHash: string
	readonly orderId: number
	readonly itemId: number
	readonly currency: 'RUB'
	readonly totalAmount: number
	readonly nowMs?: number
}

export type CancelOutcome = 'cancelled' | 'already_cancelled' | 'not_found'

export interface OstrovokStore {
	storeBookHash(tenantId: string, input: StoreBookHashInput): Promise<void>
	getBookHash(tenantId: string, bookHash: string, nowMs?: number): Promise<BookHashContext | null>
	storeFormStage(tenantId: string, input: StoreFormStageInput): Promise<void>
	getFormStage(
		tenantId: string,
		partnerOrderId: string,
		nowMs?: number,
	): Promise<FormStageContext | null>
	finalizeBooking(tenantId: string, input: FinalizeBookingInput): Promise<FinalizedBooking>
	getBooking(tenantId: string, partnerOrderId: string): Promise<FinalizedBooking | null>
	cancelBooking(tenantId: string, partnerOrderId: string): Promise<CancelOutcome>

	__reset(tenantId: string): Promise<void>
	__listBookHashes(
		tenantId: string,
	): Promise<ReadonlyArray<{ bookHash: string; context: BookHashContext }>>
	__listFormStages(tenantId: string): Promise<ReadonlyArray<FormStageContext>>
	__listBookings(tenantId: string): Promise<ReadonlyArray<FinalizedBooking>>
}

export function generateBookHash(): string {
	return randomBytes(16).toString('hex')
}

export function generateOrderId(): number {
	return randomInt(100_000_000_000, 1_000_000_000_000)
}

export function generateItemId(): number {
	return randomInt(100_000_000_000, 1_000_000_000_000)
}

export function createInMemoryOstrovokStore(): OstrovokStore {
	type TenantState = {
		bookHashes: Map<string, BookHashContext>
		formStages: Map<string, FormStageContext>
		bookings: Map<string, FinalizedBooking>
	}
	const tenants = new Map<string, TenantState>()

	function tenantState(tenantId: string): TenantState {
		let s = tenants.get(tenantId)
		if (!s) {
			s = { bookHashes: new Map(), formStages: new Map(), bookings: new Map() }
			tenants.set(tenantId, s)
		}
		return s
	}

	return {
		async storeBookHash(tenantId, input) {
			const now = input.nowMs ?? Date.now()
			tenantState(tenantId).bookHashes.set(input.bookHash, {
				hid: input.hid,
				checkin: input.checkin,
				checkout: input.checkout,
				adults: input.adults,
				children: input.children,
				currency: input.currency,
				dailyPrices: input.dailyPrices,
				totalPrice: input.totalPrice,
				roomName: input.roomName,
				mealName: input.mealName,
				issuedAtMs: now,
				expiresAtMs: now + BOOK_HASH_TTL_MS,
			})
		},

		async getBookHash(tenantId, bookHash, nowMs) {
			const s = tenantState(tenantId)
			const ctx = s.bookHashes.get(bookHash)
			if (ctx === undefined) return null
			const now = nowMs ?? Date.now()
			if (ctx.expiresAtMs < now) {
				s.bookHashes.delete(bookHash)
				return null
			}
			return ctx
		},

		async storeFormStage(tenantId, input) {
			const now = input.nowMs ?? Date.now()
			tenantState(tenantId).formStages.set(input.partnerOrderId, {
				partnerOrderId: input.partnerOrderId,
				bookHash: input.bookHash,
				orderId: input.orderId,
				itemId: input.itemId,
				currency: input.currency,
				totalAmount: input.totalAmount,
				createdAtMs: now,
				expiresAtMs: now + FORM_STAGE_TTL_MS,
			})
		},

		async getFormStage(tenantId, partnerOrderId, nowMs) {
			const s = tenantState(tenantId)
			const ctx = s.formStages.get(partnerOrderId)
			if (ctx === undefined) return null
			const now = nowMs ?? Date.now()
			if (ctx.expiresAtMs < now) {
				s.formStages.delete(partnerOrderId)
				return null
			}
			return ctx
		},

		async finalizeBooking(tenantId, input) {
			const now = input.nowMs ?? Date.now()
			const finalized: FinalizedBooking = {
				partnerOrderId: input.form.partnerOrderId,
				orderId: input.form.orderId,
				itemId: input.form.itemId,
				hid: input.bookHashContext.hid,
				checkin: input.bookHashContext.checkin,
				checkout: input.bookHashContext.checkout,
				adults: input.bookHashContext.adults,
				children: input.bookHashContext.children,
				currency: input.form.currency,
				totalAmount: input.form.totalAmount,
				status: 'confirmed',
				customerEmail: input.customerEmail,
				customerPhone: input.customerPhone,
				guests: input.guests,
				createdAtMs: now,
			}
			const s = tenantState(tenantId)
			s.bookings.set(input.form.partnerOrderId, finalized)
			s.formStages.delete(input.form.partnerOrderId)
			return finalized
		},

		async getBooking(tenantId, partnerOrderId) {
			return tenantState(tenantId).bookings.get(partnerOrderId) ?? null
		},

		async cancelBooking(tenantId, partnerOrderId) {
			const s = tenantState(tenantId)
			const existing = s.bookings.get(partnerOrderId)
			if (existing === undefined) return 'not_found'
			if (existing.status === 'cancelled') return 'already_cancelled'
			s.bookings.set(partnerOrderId, { ...existing, status: 'cancelled' })
			return 'cancelled'
		},

		async __reset(tenantId) {
			const s = tenants.get(tenantId)
			if (s) {
				s.bookHashes.clear()
				s.formStages.clear()
				s.bookings.clear()
			}
		},

		async __listBookHashes(tenantId) {
			const s = tenants.get(tenantId)
			if (!s) return []
			return Array.from(s.bookHashes.entries()).map(([bookHash, context]) => ({
				bookHash,
				context,
			}))
		},

		async __listFormStages(tenantId) {
			const s = tenants.get(tenantId)
			if (!s) return []
			return Array.from(s.formStages.values())
		},

		async __listBookings(tenantId) {
			const s = tenants.get(tenantId)
			if (!s) return []
			return Array.from(s.bookings.values())
		},
	}
}
