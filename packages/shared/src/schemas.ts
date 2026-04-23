import { z } from 'zod'
import { type EntityKind, ID_PREFIXES } from './ids.ts'

/**
 * Zod schema for a typed ID of a given entity kind.
 * Validates format: {prefix}_{26-char base32}.
 */
export function idSchema<K extends EntityKind>(kind: K) {
	const prefix = ID_PREFIXES[kind]
	const pattern = new RegExp(`^${prefix}_[0-9a-hjkmnp-tv-z]{26}$`, 'i')
	return z.string().regex(pattern, `Invalid ${kind} ID (expected ${prefix}_{26 base32 chars})`)
}

/** Member role values — used by organization plugin access-control. */
export const memberRoleSchema = z.enum(['owner', 'manager', 'staff'])
export type MemberRole = z.infer<typeof memberRoleSchema>
