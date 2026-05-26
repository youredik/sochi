/**
 * Round 14 Phase E3 — Per-channel webhook `data` field zod validation.
 *
 * Canon: `feedback_round_12_polish_canon_2026_05_26.md` deferred Round 14 —
 * Webhook Zod data validation. Before E3, CloudEvent envelope was validated
 * but `data` payload passed через `unknown` to handlers. Malformed downstream
 * payload could crash adapter or corrupt audit log silently.
 *
 * Strategy — per-channel schema, applied AFTER envelope parse but BEFORE
 * `onAccepted` emit. Failed validation → 400 + structured error.
 *
 * Coverage matrix:
 *   - YT (Yandex Travel): `booking.created.v1`, `booking.cancelled.v1`
 *   - ETG (Островок): `booking.created.v1`, `booking.cancelled.v1`
 *   - TL (TravelLine): `reservation.created.v1`, `reservation.cancelled.v1`,
 *     `ari.delta.v1`
 *   - YK (ЮKassa): `payment.succeeded.v1`, `payment.refunded.v1`
 *
 * Unknown event-type → pass-through (forward-compat). Backend handler decides
 * if pass-through is OK. Schema absence does NOT block — schema MISMATCH does.
 */

import { z } from 'zod'

// ── Yandex Travel ─────────────────────────────────────────────────────────
const YtBookingCreatedDataSchema = z.object({
	order_id: z.string().min(1),
	external_id: z.string().min(1),
	channel_id: z.literal('YT'),
	hotel_id: z.string().min(1),
	check_in: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	check_out: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	adults: z.number().int().min(1),
	children: z.number().int().min(0).optional(),
	guests: z
		.array(
			z.object({
				first_name: z.string(),
				last_name: z.string(),
				is_child: z.boolean().optional(),
				age: z.number().optional(),
			}),
		)
		.optional(),
	customer_email: z.string().optional(),
	customer_phone: z.string().optional(),
	comment: z.string().optional(),
	total_price_rub: z.number(),
	currency: z.literal('RUB'),
})

const YtBookingCancelledDataSchema = z.object({
	order_id: z.string().min(1),
	external_id: z.string().min(1),
	channel_id: z.literal('YT'),
	cancellation_reason: z.string().optional(),
})

// ── Островок ETG ──────────────────────────────────────────────────────────
const EtgBookingCreatedDataSchema = z.object({
	partner_order_id: z.string().min(1),
	book_hash: z.string().min(1),
	channel_id: z.literal('ETG'),
	hid: z.number().int().positive(),
	check_in: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	check_out: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	rooms: z.array(z.unknown()).optional(),
	user_email: z.string().optional(),
	user_phone: z.string().optional(),
	total_price: z.number(),
	currency_code: z.literal('RUB'),
})

const EtgBookingCancelledDataSchema = z.object({
	partner_order_id: z.string().min(1),
	channel_id: z.literal('ETG'),
	cancellation_state: z.enum(['cancelled', 'partially_cancelled']),
})

// ── TravelLine ────────────────────────────────────────────────────────────
const TlReservationCreatedDataSchema = z.object({
	reservation_id: z.string().min(1),
	channel_id: z.literal('TL'),
	property_code: z.string().min(1),
	arrival: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	departure: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	guest_count: z.number().int().min(1),
	total_amount_micros: z.union([z.string(), z.number()]),
})

const TlReservationCancelledDataSchema = z.object({
	reservation_id: z.string().min(1),
	channel_id: z.literal('TL'),
})

const TlAriDeltaDataSchema = z.object({
	channel_id: z.literal('TL'),
	property_code: z.string().min(1),
	room_type_id: z.string().min(1),
	rate_plan_id: z.string().min(1),
	date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})

// ── ЮKassa ────────────────────────────────────────────────────────────────
const YkPaymentSucceededDataSchema = z.object({
	payment_id: z.string().min(1),
	amount: z.object({ value: z.string(), currency: z.string() }),
	status: z.literal('succeeded'),
})

const YkPaymentRefundedDataSchema = z.object({
	refund_id: z.string().min(1),
	payment_id: z.string().min(1),
	amount: z.object({ value: z.string(), currency: z.string() }),
})

// ── Registry — eventType → schema ─────────────────────────────────────────
const SCHEMA_REGISTRY: Readonly<Record<string, z.ZodTypeAny>> = {
	'app.sochi.channel.booking.created.v1.YT': YtBookingCreatedDataSchema,
	'app.sochi.channel.booking.cancelled.v1.YT': YtBookingCancelledDataSchema,
	'app.sochi.channel.booking.created.v1.ETG': EtgBookingCreatedDataSchema,
	'app.sochi.channel.booking.cancelled.v1.ETG': EtgBookingCancelledDataSchema,
	'app.sochi.channel.reservation.created.v1.TL': TlReservationCreatedDataSchema,
	'app.sochi.channel.reservation.cancelled.v1.TL': TlReservationCancelledDataSchema,
	'app.sochi.channel.ari.delta.v1.TL': TlAriDeltaDataSchema,
	'app.sochi.payment.succeeded.v1.YK': YkPaymentSucceededDataSchema,
	'app.sochi.payment.refunded.v1.YK': YkPaymentRefundedDataSchema,
}

export type WebhookDataValidationResult =
	| { readonly kind: 'ok' }
	| { readonly kind: 'no_schema' } // unknown event-type — pass-through OK
	| { readonly kind: 'invalid'; readonly errors: ReadonlyArray<string> }

/**
 * Validate webhook event `data` field против per-channel zod schema.
 * Returns `'no_schema'` for unknown event-type+channel combinations
 * (forward-compat). Returns `'invalid'` with formatted error list when
 * schema exists but data doesn't match.
 */
export function validateWebhookData(input: {
	readonly eventType: string
	readonly channelId: string
	readonly data: unknown
}): WebhookDataValidationResult {
	const registryKey = `${input.eventType}.${input.channelId}`
	const schema = SCHEMA_REGISTRY[registryKey]
	if (schema === undefined) return { kind: 'no_schema' }
	const result = schema.safeParse(input.data)
	if (result.success) return { kind: 'ok' }
	const errors = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
	return { kind: 'invalid', errors }
}
