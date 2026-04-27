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

/**
 * Wire-format bigint: accepts JSON `string` (canonical wire form) OR native
 * `bigint` (server-side service calls). Coerces to bigint and refines to
 * Int64 range. Mirrors `bigIntMinorSchema` in folio.ts; canonicalised here
 * so M8.A.0 schemas (compliance / addon / media) reuse one rule.
 *
 * Usage:
 *   priceMicros: int64WireSchema   — accepts "800000000" or 800_000_000n
 */
export const int64WireSchema = z.coerce
	.bigint()
	.refine(
		(n) => n >= -9_223_372_036_854_775_808n && n <= 9_223_372_036_854_775_807n,
		'Overflow: must fit Int64',
	)
