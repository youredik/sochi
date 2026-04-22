import { z } from 'zod'
import { ID_PREFIXES, type EntityKind } from './ids.ts'

/**
 * Zod schema for a typed ID of a given entity kind.
 * Validates format: {prefix}_{26-char base32}.
 */
export function idSchema<K extends EntityKind>(kind: K) {
	const prefix = ID_PREFIXES[kind]
	const pattern = new RegExp(`^${prefix}_[0-9a-hjkmnp-tv-z]{26}$`, 'i')
	return z
		.string()
		.regex(pattern, `Invalid ${kind} ID (expected ${prefix}_{26 base32 chars})`)
}

/** ISO 3166-1 alpha-2 country code (uppercase). */
export const countryCodeSchema = z
	.string()
	.length(2)
	.regex(/^[A-Z]{2}$/, 'Expected ISO 3166-1 alpha-2 country code')

/** Russian-style INN: 10 digits for legal entities, 12 for individuals. */
export const innSchema = z.string().regex(/^(\d{10}|\d{12})$/, 'INN must be 10 or 12 digits')

/** Organization plan values. */
export const orgPlanSchema = z.enum(['trial', 'basic'])
export type OrgPlan = z.infer<typeof orgPlanSchema>

/** Member role values. */
export const memberRoleSchema = z.enum(['owner', 'manager', 'staff'])
export type MemberRole = z.infer<typeof memberRoleSchema>

/** Booking status values. */
export const bookingStatusSchema = z.enum([
	'pending',
	'confirmed',
	'checked_in',
	'checked_out',
	'cancelled',
	'no_show',
])
export type BookingStatus = z.infer<typeof bookingStatusSchema>

/** Booking source values. */
export const bookingSourceSchema = z.enum([
	'direct',
	'yandex_travel',
	'ostrovok',
	'avito',
	'walk_in',
])
export type BookingSource = z.infer<typeof bookingSourceSchema>

/** Guest document type values. */
export const documentTypeSchema = z.enum([
	'ru_passport',
	'foreign_passport',
	'ru_driver_license',
	'military_id',
])
export type DocumentType = z.infer<typeof documentTypeSchema>

/** Job type values. */
export const jobTypeSchema = z.enum([
	'mvd_submit',
	'yookassa_refund',
	'ota_sync',
	'send_email',
])
export type JobType = z.infer<typeof jobTypeSchema>

/** Job status values. */
export const jobStatusSchema = z.enum(['pending', 'running', 'done', 'failed', 'dead'])
export type JobStatus = z.infer<typeof jobStatusSchema>
