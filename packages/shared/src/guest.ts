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
