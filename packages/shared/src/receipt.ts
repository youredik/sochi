import { z } from 'zod'
import { idSchema } from './schemas.ts'

/**
 * Receipt domain — 54-ФЗ ФФД 1.2 fiscal record per payment / refund.
 *
 * Per canonical decisions (memory `project_payment_domain_canonical.md`
 * "Fiscalization decision"):
 *   - V1 primary provider: ЮKassa "Чеки от ЮKassa".
 *   - V1 escape-hatch (interface seam, не impl): ATOL Online (1733₽/mo,
 *     supports correction чек). Activates когда volume justifies.
 *   - V1 stub provider: emits stub receipts in dev / demo mode.
 *   - 5-state SM: pending → sent → confirmed | failed | corrected (terminal).
 *   - 54-ФЗ does NOT allow void / edit. Mistakes are corrected via a NEW
 *     receipt with `correctsReceiptId` referencing the original. Domain
 *     enforces correction chain depth ≤ 3 (ФНС regulatory limit).
 *   - Money: Int64 копейки.
 *   - Idempotency-Key UUIDv4 with exponential backoff 2-4-8-16-32-64s
 *     (canon "Error retry matrix").
 */

/* --------------------------------------------------------------- enums + SM */

const receiptKindValues = ['advance', 'prepayment_full', 'final', 'refund', 'correction'] as const
export const receiptKindSchema = z.enum(receiptKindValues)
export type ReceiptKind = z.infer<typeof receiptKindSchema>

const receiptStatusValues = ['pending', 'sent', 'confirmed', 'failed', 'corrected'] as const
export const receiptStatusSchema = z.enum(receiptStatusValues)
export type ReceiptStatus = z.infer<typeof receiptStatusSchema>

/**
 * Terminal states (no further transition). corrected = superseded by chain
 * successor; confirmed = ОФД/ФНС acknowledged; failed = retryable via NEW
 * row (54-ФЗ permits a fresh attempt with new IdempotencyKey).
 */
export const TERMINAL_RECEIPT_STATUSES: readonly ReceiptStatus[] = [
	'confirmed',
	'failed',
	'corrected',
] as const

const receiptProviderValues = ['yookassa_cheki', 'atol_online', 'stub'] as const
export const receiptProviderSchema = z.enum(receiptProviderValues)
export type ReceiptProvider = z.infer<typeof receiptProviderSchema>

/* ------------------------------------------------------------- FFD 1.2 tags */

/**
 * tag1054 — operation type.
 *   1 = приход
 *   2 = возврат прихода
 *   3 = коррекция прихода
 *   4 = коррекция возврата
 */
export const receiptTag1054Schema = z.union([
	z.literal(1),
	z.literal(2),
	z.literal(3),
	z.literal(4),
])
export type ReceiptTag1054 = z.infer<typeof receiptTag1054Schema>

/**
 * tag1212 — предмет расчёта. =4 ('услуга') for hotel accommodation V1.
 * Reserved для будущих kinds (товар=1, работа=2, etc.) when we ever
 * sell real goods through the same fiscal seam.
 */
export const receiptTag1212Schema = z.literal(4)
export type ReceiptTag1212 = z.infer<typeof receiptTag1212Schema>

/**
 * tag1214 — способ расчёта (per FFD 1.2 scenario):
 *   1 = полная предоплата (prepayment_full)
 *   2 = частичная предоплата (advance with room known)
 *   3 = аванс (advance TBD)
 *   4 = полный расчёт (final settlement, with tag 1215 zachet)
 */
export const receiptTag1214Schema = z.union([
	z.literal(1),
	z.literal(2),
	z.literal(3),
	z.literal(4),
])
export type ReceiptTag1214 = z.infer<typeof receiptTag1214Schema>

/**
 * tag1199 — НДС. =5 (0%) for accommodation per ФНС decree, продлено до
 * 31.12.2030 by Постановление-1860 (Government of RU classification).
 */
export const receiptTag1199Schema = z.literal(5)
export type ReceiptTag1199 = z.infer<typeof receiptTag1199Schema>

/* ----------------------------------------------------- line items (tag 1059) */

/** Line item per FFD 1.2 (tag 1059 + sub-tags). */
export const receiptLineSchema = z.object({
	/** tag 1030 — name (max 128 chars per spec). */
	name: z.string().min(1).max(128),
	/** tag 1023 — quantity (integer or 3-decimal). */
	quantity: z.coerce.bigint().refine((n) => n > 0n, 'quantity must be > 0'),
	/** tag 1079 — unit price in копейки. */
	priceMinor: z.coerce.bigint().refine((n) => n >= 0n, 'priceMinor must be >= 0'),
	/** tag 1043 — line total in копейки. Caller computes price * quantity. */
	sumMinor: z.coerce.bigint().refine((n) => n >= 0n, 'sumMinor must be >= 0'),
	/** tag 1199 — НДС (5 = 0% for accommodation). */
	tag1199: receiptTag1199Schema,
	/** tag 1212 — предмет расчёта (4 = услуга). */
	tag1212: receiptTag1212Schema,
	/** tag 1214 — способ расчёта. */
	tag1214: receiptTag1214Schema,
})
export type ReceiptLine = z.infer<typeof receiptLineSchema>

/* --------------------------------------------------------------- domain rows */

/** Receipt row shape (read model). Money is bigint string for JSON. */
export type Receipt = {
	tenantId: string
	paymentId: string
	id: string
	refundId: string | null
	kind: ReceiptKind
	correctsReceiptId: string | null
	status: ReceiptStatus
	provider: ReceiptProvider
	tag1054: ReceiptTag1054
	tag1212: ReceiptTag1212
	tag1214: ReceiptTag1214
	tag1199: ReceiptTag1199
	tag1008: string
	linesJson: ReceiptLine[]
	totalMinor: string
	currency: string
	fnsRegId: string | null
	fdNumber: string | null
	fp: string | null
	qrPayload: string | null
	idempotencyKey: string
	version: number
	createdAt: string
	updatedAt: string
	sentAt: string | null
	confirmedAt: string | null
	failedAt: string | null
	correctedAt: string | null
	failureReason: string | null
	createdBy: string
	updatedBy: string
}

/* ----------------------------------------------------------------- API inputs */

const totalMinorSchema = z.coerce
	.bigint()
	.refine((n) => n > 0n, 'totalMinor must be > 0')
	.refine((n) => n <= 9_223_372_036_854_775_807n, 'Overflow: must fit Int64')

/** POST /payments/:id/receipts — create a fiscal receipt request. */
export const receiptCreateInput = z.object({
	kind: receiptKindSchema,
	provider: receiptProviderSchema,
	tag1054: receiptTag1054Schema,
	tag1212: receiptTag1212Schema,
	tag1214: receiptTag1214Schema,
	tag1199: receiptTag1199Schema,
	/** Email or E.164 phone (mandatory online sale с 2025-09-01). */
	tag1008: z
		.string()
		.min(1)
		.max(255)
		.refine(
			(v) => v.includes('@') || /^\+?[0-9]{10,15}$/.test(v),
			'tag1008 must be email or E.164 phone (mandatory с 2025-09-01)',
		),
	lines: z.array(receiptLineSchema).min(1).max(100),
	totalMinor: totalMinorSchema,
	correctsReceiptId: idSchema('receipt').nullable().optional(),
	refundId: idSchema('refund').nullable().optional(),
	idempotencyKey: z.uuid(),
})
export type ReceiptCreateInput = z.infer<typeof receiptCreateInput>

export const receiptIdParam = z.object({ id: idSchema('receipt') })

export const receiptListParams = z.object({
	paymentId: idSchema('payment').optional(),
	status: receiptStatusSchema.optional(),
})
export type ReceiptListParams = z.infer<typeof receiptListParams>

/** Domain limit on correction chain depth (ФНС regulatory). */
export const RECEIPT_CORRECTION_CHAIN_MAX_DEPTH = 3
