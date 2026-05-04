/**
 * magicLinkToken repo (M9.widget.5 — Track A3).
 *
 * Per `plans/m9_widget_5_canonical.md` §7 + §D1:
 *   - Stateful single-use enforcement: atomic UPDATE WHERE consumedAt IS NULL
 *     AND attemptsRemaining > 0 inside serializable tx (TLI retry semantics).
 *   - View tokens = 5 attempts (Apple MPP / Slack unfurl / Outlook SafeLinks
 *     prefetch defense — `etodd.io/2026/03/22/magic-link-pitfalls/` canon).
 *   - Mutate tokens = 1 attempt (cancel/modify is destructive — strict single-use).
 *
 * Audit fields (152-ФЗ ст. 22.1 DPO recordkeeping):
 *   - `issuedFromIp` — initial issue context
 *   - `consumedFromIp` + `consumedFromUa` — consume context (admin-alert
 *     metadata if differs from issuedFromIp)
 *
 * NOT a domain repo per se — narrow read+write surface для magic-link.service.ts only.
 */

import type { sql as SQL } from '../../db/index.ts'
import { textOpt, timestampOpt } from '../../db/ydb-helpers.ts'
import type { MagicLinkScope } from '../../lib/magic-link/jwt.ts'

type SqlInstance = typeof SQL

export interface MagicLinkTokenRow {
	readonly tenantId: string
	readonly jti: string
	readonly bookingId: string
	readonly scope: MagicLinkScope
	readonly issuedAt: Date
	readonly expiresAt: Date
	readonly consumedAt: Date | null
	readonly consumedFromIp: string | null
	readonly consumedFromUa: string | null
	readonly issuedFromIp: string | null
	readonly attemptsRemaining: number
}

/** Default attempts по scope per plan §D1. */
export const DEFAULT_ATTEMPTS_BY_SCOPE: Record<MagicLinkScope, number> = {
	view: 5,
	mutate: 1,
}

interface DbRow {
	tenantId: string
	jti: string
	bookingId: string
	scope: string
	issuedAt: Date
	expiresAt: Date
	consumedAt: Date | null
	consumedFromIp: string | null
	consumedFromUa: string | null
	issuedFromIp: string | null
	attemptsRemaining: number | bigint
}

function rowToToken(row: DbRow): MagicLinkTokenRow {
	const scope = row.scope
	if (scope !== 'view' && scope !== 'mutate') {
		throw new Error(`magicLinkToken row has invalid scope ${scope} (jti=${row.jti})`)
	}
	return {
		tenantId: row.tenantId,
		jti: row.jti,
		bookingId: row.bookingId,
		scope,
		issuedAt: row.issuedAt,
		expiresAt: row.expiresAt,
		consumedAt: row.consumedAt,
		consumedFromIp: row.consumedFromIp,
		consumedFromUa: row.consumedFromUa,
		issuedFromIp: row.issuedFromIp,
		attemptsRemaining: Number(row.attemptsRemaining),
	}
}

export function createMagicLinkTokenRepo(sql: SqlInstance) {
	return {
		/**
		 * Insert fresh magic-link token row. Caller has just signed JWT for
		 * the same `jti` — both are bound atomically (failure of either =
		 * failure of full magic-link.service.issue).
		 */
		async insert(input: {
			readonly tenantId: string
			readonly jti: string
			readonly bookingId: string
			readonly scope: MagicLinkScope
			readonly issuedAt: Date
			readonly expiresAt: Date
			readonly issuedFromIp: string | null
			readonly attemptsRemaining: number
		}): Promise<void> {
			await sql`
				UPSERT INTO magicLinkToken (
					tenantId, jti, bookingId, scope,
					issuedAt, expiresAt, consumedAt,
					consumedFromIp, consumedFromUa, issuedFromIp,
					attemptsRemaining
				)
				VALUES (
					${input.tenantId}, ${input.jti}, ${input.bookingId}, ${input.scope},
					${input.issuedAt}, ${input.expiresAt}, ${timestampOpt(null)},
					${textOpt(null)}, ${textOpt(null)}, ${textOpt(input.issuedFromIp)},
					${input.attemptsRemaining}
				)
			`.idempotent(true)
		},

		/**
		 * Read token row by composite PK. Returns `null` if no row exists.
		 * Read-only (NO consume / mutation). Used by `magic-link.service.verify()`.
		 */
		async findByJti(tenantId: string, jti: string): Promise<MagicLinkTokenRow | null> {
			const [rows = []] = await sql<DbRow[]>`
				SELECT * FROM magicLinkToken
				WHERE tenantId = ${tenantId} AND jti = ${jti}
				LIMIT 1
			`.idempotent(true)
			const row = rows[0]
			return row ? rowToToken(row) : null
		},

		/**
		 * Atomic consume: decrement `attemptsRemaining`, populate `consumedAt` /
		 * `consumedFromIp` / `consumedFromUa` if attempts hit 0.
		 *
		 * Returns:
		 *   - `consumed: true` — atomic UPDATE succeeded; row was active.
		 *     `attemptsRemaining` reflects new value (0 = fully consumed).
		 *   - `consumed: false` — row missing OR already fully consumed OR
		 *     `expiresAt < now`. Caller should return 410 Gone.
		 *
		 * Concurrent consume race: YDB serializable + TLI retry semantics →
		 * exactly one wins; loser sees `attemptsRemaining` post-decrement.
		 *
		 * NB: «consume» on a `view` token decrements but does NOT mark
		 * `consumedAt` until `attemptsRemaining` hits 0 (multi-attempt
		 * Apple MPP defense). Mutate tokens decrement to 0 on first call.
		 */
		async consume(input: {
			readonly tenantId: string
			readonly jti: string
			readonly fromIp: string
			readonly fromUa: string | null
			readonly now: Date
		}): Promise<{
			readonly consumed: boolean
			readonly attemptsRemaining: number
			readonly fullyConsumed: boolean
			readonly token: MagicLinkTokenRow | null
		}> {
			// Atomic SELECT-then-UPDATE inside serializable tx — concurrent
			// consume calls на same jti resolve через YDB OCC + TLI retry
			// (`idempotent: true`). Pattern matches payment.repo.applyTransition
			// (M6.1 canon).
			//
			// Without sql.begin: read+write are 2 separate snapshots — N concurrent
			// callers все see attemptsRemaining=K, all decrement → result K-1 only,
			// but each caller думает «я decremented K→K-1» (false success). Caught
			// empirically [MLR17]: 3 concurrent mutate calls (attempts=1) all
			// succeeded — strict single-use invariant violated.
			//
			// Race-loser fallback: under heavy contention, @ydbjs retry budget
			// can exhaust → throws YDB error (code 400140 «Transaction not found»
			// или 400110 ABORTED). Каноничный race-loser semantic: re-read
			// canonical post-state в fresh tx, return graceful `consumed: false`.
			try {
				return await sql.begin({ idempotent: true }, async (tx) => {
					const [readRows = []] = await tx<DbRow[]>`
					SELECT * FROM magicLinkToken
					WHERE tenantId = ${input.tenantId} AND jti = ${input.jti}
					LIMIT 1
				`
					const existing = readRows[0]
					if (!existing) {
						return { consumed: false, attemptsRemaining: 0, fullyConsumed: false, token: null }
					}
					const token = rowToToken(existing)
					if (token.attemptsRemaining <= 0) {
						return { consumed: false, attemptsRemaining: 0, fullyConsumed: true, token }
					}
					if (token.expiresAt.getTime() <= input.now.getTime()) {
						return {
							consumed: false,
							attemptsRemaining: token.attemptsRemaining,
							fullyConsumed: false,
							token,
						}
					}

					const newAttempts = token.attemptsRemaining - 1
					const willFullyConsume = newAttempts === 0
					await tx`
					UPDATE magicLinkToken
					SET
						attemptsRemaining = ${newAttempts},
						consumedAt = ${willFullyConsume ? input.now : timestampOpt(null)},
						consumedFromIp = ${textOpt(willFullyConsume ? input.fromIp : null)},
						consumedFromUa = ${textOpt(willFullyConsume ? input.fromUa : null)}
					WHERE tenantId = ${input.tenantId} AND jti = ${input.jti}
				`
					const postToken: MagicLinkTokenRow = {
						...token,
						attemptsRemaining: newAttempts,
						consumedAt: willFullyConsume ? input.now : null,
						consumedFromIp: willFullyConsume ? input.fromIp : null,
						consumedFromUa: willFullyConsume ? input.fromUa : null,
					}
					return {
						consumed: true,
						attemptsRemaining: newAttempts,
						fullyConsumed: willFullyConsume,
						token: postToken,
					}
				})
			} catch (err) {
				if (!isYdbRaceError(err)) throw err
				// Race-loser: another tx committed first; re-read canonical post-state.
				const [postRows = []] = await sql<DbRow[]>`
					SELECT * FROM magicLinkToken
					WHERE tenantId = ${input.tenantId} AND jti = ${input.jti}
					LIMIT 1
				`.idempotent(true)
				const postRow = postRows[0]
				if (!postRow) {
					return { consumed: false, attemptsRemaining: 0, fullyConsumed: false, token: null }
				}
				const post = rowToToken(postRow)
				return {
					consumed: false,
					attemptsRemaining: post.attemptsRemaining,
					fullyConsumed: post.attemptsRemaining <= 0,
					token: post,
				}
			}
		},
	}
}

/**
 * Detect YDB race-class errors что indicate «another tx committed first»
 * (TLI retry exhaustion). Walks err.cause chain (max 4 levels) checking:
 *   - code 400140 (NOT_FOUND TX) issue 2015 «Transaction not found»
 *   - code 400110 (ABORTED) — concurrent tx aborted ours
 *   - code 400120 (PRECONDITION_FAILED) — UNIQUE conflict (relevant для UPSERT scenarios)
 */
function isYdbRaceError(err: unknown): boolean {
	let cur: unknown = err
	for (let depth = 0; depth < 4 && cur; depth++) {
		if (cur && typeof cur === 'object') {
			const c = cur as { code?: unknown; message?: unknown; cause?: unknown }
			if (c.code === 400140 || c.code === 400110 || c.code === 400120) return true
			if (typeof c.message === 'string') {
				if (c.message.includes('Transaction not found')) return true
				if (c.message.includes('ABORTED')) return true
				if (c.message.includes('Conflict with existing key')) return true
			}
			cur = c.cause
		} else {
			return false
		}
	}
	return false
}

export type MagicLinkTokenRepo = ReturnType<typeof createMagicLinkTokenRepo>
