import { z } from 'zod'
import { idSchema } from './schemas.ts'

/**
 * PropertyBlock — operator-side maintenance / out-of-order / personal-use
 * block at the **room level** (not roomType), for a date range. Distinct
 * domain from `booking`:
 *   - no guest, no folio, no payment, no check-in/out
 *   - 152-ФЗ exposure window: zero PII by design (comment field is
 *     PII-guarded — refuse digit≥10 or email patterns)
 *   - separate read path так что queries don't need WHERE type='guest' filter
 *
 * Canon: 5/6 industry leaders model as separate entity:
 *   - Mews ResourceBlock (Connector API)
 *   - Apaleo Block aggregate + OOO/OOS/OOI status
 *   - OPERA Cloud OOO with configurable reason codes
 *   - Cloudbeds Maintenance blocks (skipped by auto-assign)
 *   - Bnovo «закрытие продажи» с тремя причинами + comment
 *   (TravelLine single-reason также separate, минимальный enum)
 *
 * Per-room granularity (NOT per-roomType): all leaders. Reason: cleaning/
 * maintenance is a physical attribute, not inventory bucket. Если нужно
 * блокировать всю категорию — N blocks для каждого room в одной tx.
 *
 * Reason enum (4 values, RU labels):
 *   - repair        — Ремонт (сантехника, мебель, электрика)
 *   - deep_clean    — Генеральная уборка (сезонная / после долгого гостя)
 *   - personal_use  — Личное пользование (владелец, VIP, служебное)
 *   - hold_other    — Прочая блокировка (резерв под событие, фотосъёмка)
 *
 * Bnovo's 3-bucket model refined for RU HoReCa context. Avoid OPERA's 10+
 * configurable codes (overkill для 5-50-room property). Avoid TravelLine's
 * single-value (under-modeled).
 *
 * NB: don't model «туристический налог reservation» — налог 2% Сочи это
 * charge on guest stay, not a room block.
 */

const propertyBlockReasonValues = ['repair', 'deep_clean', 'personal_use', 'hold_other'] as const
export const propertyBlockReasonSchema = z.enum(propertyBlockReasonValues)
export type PropertyBlockReason = z.infer<typeof propertyBlockReasonSchema>

/** Human-readable RU labels keyed by enum value. Frontend uses these
 *  verbatim — also serves as i18n source-of-truth. */
export const propertyBlockReasonLabelsRu: Record<PropertyBlockReason, string> = {
	repair: 'Ремонт',
	deep_clean: 'Генеральная уборка',
	personal_use: 'Личное пользование',
	hold_other: 'Прочая блокировка',
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')

/**
 * 152-ФЗ PII guard. Refuse comment containing:
 *   - 10+ consecutive digits (passport/phone/INN patterns)
 *   - email-like pattern (local@domain.tld)
 *
 * Operator must use the booking entity for any guest-linked hold, not
 * block.comment. Bnovo + TravelLine free-text fields have NO such guard —
 * we improve here.
 *
 * Exported so backend AND frontend can reuse identical check (server
 * authoritative, client gives early hint).
 */
const tenDigitsRegex = /\d{10}/
// Conservative email regex — covers most realistic PII leak patterns
// without false-positive on legitimate punctuation-rich comments.
const emailLikeRegex = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
export function isPropertyBlockCommentPII(value: string): boolean {
	return tenDigitsRegex.test(value) || emailLikeRegex.test(value)
}

const commentSchema = z
	.string()
	.max(200, 'Не более 200 символов')
	.refine(
		(v) => !isPropertyBlockCommentPII(v),
		'Не указывайте телефон, номер документа или e-mail — для гостевых данных используйте бронирование',
	)

export const propertyBlockCreateInput = z
	.object({
		roomIds: z.array(idSchema('room')).min(1, 'Выберите хотя бы один номер').max(50),
		startDate: dateSchema,
		endDate: dateSchema,
		reason: propertyBlockReasonSchema,
		comment: commentSchema.optional().nullable(),
	})
	.refine((v) => v.startDate < v.endDate, {
		message: 'Дата окончания должна быть позже даты начала',
		path: ['endDate'],
	})
export type PropertyBlockCreateInput = z.infer<typeof propertyBlockCreateInput>

export const propertyBlockUpdateInput = z
	.object({
		startDate: dateSchema.optional(),
		endDate: dateSchema.optional(),
		reason: propertyBlockReasonSchema.optional(),
		comment: commentSchema.nullable().optional(),
	})
	.refine((obj) => Object.keys(obj).length > 0, 'At least one field must be provided')
export type PropertyBlockUpdateInput = z.infer<typeof propertyBlockUpdateInput>

export const propertyBlockListParams = z
	.object({
		from: dateSchema,
		to: dateSchema,
	})
	.refine((v) => v.from <= v.to, 'from must be <= to')

export const propertyBlockIdParam = z.object({ id: idSchema('propertyBlock') })

export type PropertyBlock = {
	id: string
	tenantId: string
	propertyId: string
	roomId: string
	startDate: string
	endDate: string
	reason: PropertyBlockReason
	comment: string | null
	createdBy: string
	createdAt: string
	updatedAt: string
}

/**
 * Availability check response (G9 Surface 1). Returned by
 * `GET /properties/:propertyId/availability?roomTypeId&from&to`.
 *
 * `availableCount` — rooms of this type that are FREE for the entire
 * window (= total active rooms − overlapping bookings − active blocks).
 *
 * `bookedCount` / `blockedCount` — diagnostic breakdown for the
 * conflict-banner UX. Sum may exceed total если booking and block
 * overlap (rare but possible — operator created block over booking
 * separately).
 */
export type AvailabilityCheckResult = {
	roomTypeId: string
	from: string
	to: string
	totalRooms: number
	bookedCount: number
	blockedCount: number
	availableCount: number
}

export const availabilityCheckParams = z
	.object({
		roomTypeId: idSchema('roomType'),
		from: dateSchema,
		to: dateSchema,
	})
	.refine((v) => v.from < v.to, {
		message: 'to must be > from (exclusive checkout)',
		path: ['to'],
	})
