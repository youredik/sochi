import { z } from 'zod'
import { idSchema } from './schemas.ts'

/**
 * Guest — personal data for a reservation primary/companion guest.
 *
 * Two audiences:
 *   - PMS staff registration (name + contact + document basics).
 *   - МВД reporting (foreign guests): visa + migration card + arrival/stay
 *     dates + registrationAddress. The admin workflow submits within
 *     1 business day of arrival per the 2025-reform МВД rules verified
 *     2026-04 (see memory `project_ru_compliance_blockers.md` §1).
 *
 * `citizenship` is a country ISO-3166 alpha-2 or alpha-3 code; 'RU' is the
 * default path (no МВД notification needed). Any non-RU citizenship triggers
 * `registrationStatus = 'pending'` on bookings (see booking.service).
 *
 * `documentType` is a free-form string enum — we don't constrain to a fixed
 * set because MVD reporting accepts 40+ document types; the admin UI
 * picker validates against a reference list, not this schema.
 */

const nameSchema = z.string().min(1).max(100)
const optionalShortString = z.string().max(100).nullable().optional()
const optionalMediumString = z.string().max(500).nullable().optional()
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
const citizenshipSchema = z
	.string()
	.length(2)
	.regex(/^[A-Z]{2}$/, 'ISO-3166 alpha-2, uppercase')
	.or(
		z
			.string()
			.length(3)
			.regex(/^[A-Z]{3}$/, 'ISO-3166 alpha-3, uppercase'),
	)

/**
 * G4.bis (2026-05-15) — RU citizenship canonical detector.
 *
 * `citizenshipSchema` accepts BOTH ISO-3166 alpha-2 ('RU') AND alpha-3
 * ('RUS'). До G4.bis backend `deriveRegistrationStatus` checked только
 * alpha-2 → operator typing 'RUS' (valid per schema) silently triggered
 * МВД pipeline для actual RU citizen. Frontend `registrationBadgeFor`
 * had same hardcoded 2-string check.
 *
 * Sealed Set + case-insensitive comparator — both alpha encodings count
 * как «Russian citizen» canonically. Reused backend + frontend для
 * single source of truth.
 */
export const RUSSIAN_CITIZENSHIP_CODES: ReadonlySet<string> = new Set(['RU', 'RUS'])

export function isRussianCitizenship(citizenship: string): boolean {
	return RUSSIAN_CITIZENSHIP_CODES.has(citizenship.toUpperCase())
}

/**
 * Foreign-citizen detector — **fail-closed** counterpart к isRussianCitizenship.
 *
 * Unknown/empty/null citizenship → treated as FOREIGN (true). Rationale: МВД-учёт
 * gate (109-ФЗ ст.22 ч.3 — уведомление о прибытии в течение 1 раб. дня, штраф
 * 400-500к₽ ст.18.9 КоАП) MUST err toward REQUIRING a passport scan when
 * citizenship is missing. Over-requiring a scan for an unknown guest is safe;
 * skipping it for an actually-foreign guest is a compliance violation.
 *
 * Use this (NOT `!isRussianCitizenship(x)`) wherever `citizenship` may be absent
 * — booking snapshot (`?.`), OTA imports без гражданства, legacy rows.
 */
export function isForeignCitizenship(citizenship: string | null | undefined): boolean {
	return !isRussianCitizenship(citizenship ?? '')
}

export const guestCreateInput = z.object({
	lastName: nameSchema,
	firstName: nameSchema,
	middleName: optionalShortString,
	birthDate: dateSchema.nullable().optional(),
	citizenship: citizenshipSchema,
	documentType: z.string().min(1).max(50),
	documentSeries: optionalShortString,
	documentNumber: z.string().min(1).max(50),
	documentIssuedBy: optionalMediumString,
	documentIssuedDate: dateSchema.nullable().optional(),
	registrationAddress: optionalMediumString,
	phone: optionalShortString,
	email: optionalShortString,
	notes: optionalMediumString,
	// Foreign-guest МВД fields — nullable by default, required at check-in
	// for non-RU citizens (enforced by booking.service, not by this schema).
	visaNumber: optionalShortString,
	visaType: optionalShortString,
	visaExpiresAt: dateSchema.nullable().optional(),
	migrationCardNumber: optionalShortString,
	arrivalDate: dateSchema.nullable().optional(),
	stayUntil: dateSchema.nullable().optional(),
})
export type GuestCreateInput = z.infer<typeof guestCreateInput>

export const guestUpdateInput = guestCreateInput
	.partial()
	.refine((v) => Object.keys(v).length > 0, 'At least one field required')
export type GuestUpdateInput = z.infer<typeof guestUpdateInput>

export const guestIdParam = z.object({ id: idSchema('guest') })

export type Guest = {
	id: string
	tenantId: string
	lastName: string
	firstName: string
	middleName: string | null
	birthDate: string | null
	citizenship: string
	documentType: string
	documentSeries: string | null
	documentNumber: string
	documentIssuedBy: string | null
	documentIssuedDate: string | null
	registrationAddress: string | null
	phone: string | null
	email: string | null
	notes: string | null
	visaNumber: string | null
	visaType: string | null
	visaExpiresAt: string | null
	migrationCardNumber: string | null
	arrivalDate: string | null
	stayUntil: string | null
	createdAt: string
	updatedAt: string
}
