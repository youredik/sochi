import type { SQL as SQLTag, TX as TXTag } from '@ydbjs/query'
import { unsafe } from '@ydbjs/query'
import { Optional } from '@ydbjs/value/optional'
import { BoolType, DatetimeType, TextType } from '@ydbjs/value/primitive'
import type { CleanedWhere, CustomAdapter } from 'better-auth/adapters'
import { createAdapterFactory } from 'better-auth/adapters'
import type { sql as SQL } from './index.ts'

/**
 * Either the top-level `sql` QueryClient or a transaction-scoped `tx` handle
 * from `sql.begin(async (tx) => …)`. Only the tagged-template call + `.isolation()`
 * + `.idempotent()` methods are exercised; `.begin()` is deliberately NOT used
 * inside this file — that's the outer `ydbAdapter` factory's job.
 */
type SqlOrTx = SQLTag | TXTag

/**
 * Custom Better Auth adapter for YDB.
 *
 * Why not use one of the stock adapters (Drizzle / Kysely / Prisma)? None of
 * them support YDB. This adapter speaks the Better Auth CustomAdapter contract
 * directly, using @ydbjs/query's tagged-template API underneath.
 *
 * Key points:
 *   - camelCase field names match Better Auth models 1:1 (no mapping layer).
 *   - Nullable columns are set via Optional(null, Type); raw JS null is rejected
 *     by @ydbjs/query. COLUMN_TYPES below registers every nullable column.
 *   - Secondary index hints (INDEX_HINTS) are passed to YDB via `VIEW idx_name`
 *     clauses — critical for lookups that would otherwise full-scan.
 *   - UPSERT is preferred over INSERT/UPDATE for idempotency under retries.
 *   - Read queries use snapshotReadOnly + idempotent(true) → can be retried.
 */

type SqlInstance = typeof SQL

const TEXT_TYPE = new TextType()
const BOOL_TYPE = new BoolType()
const DATETIME_TYPE = new DatetimeType()

/** Column → YDB type for nullable columns. Used to construct Optional(null, Type). */
const COLUMN_TYPES: Record<
	string,
	Record<string, typeof TEXT_TYPE | typeof BOOL_TYPE | typeof DATETIME_TYPE>
> = {
	user: {
		emailVerified: BOOL_TYPE,
		image: TEXT_TYPE,
	},
	session: {
		ipAddress: TEXT_TYPE,
		userAgent: TEXT_TYPE,
		activeOrganizationId: TEXT_TYPE,
	},
	account: {
		accessToken: TEXT_TYPE,
		refreshToken: TEXT_TYPE,
		accessTokenExpiresAt: DATETIME_TYPE,
		refreshTokenExpiresAt: DATETIME_TYPE,
		scope: TEXT_TYPE,
		idToken: TEXT_TYPE,
		password: TEXT_TYPE,
	},
	verification: {
		createdAt: DATETIME_TYPE,
		updatedAt: DATETIME_TYPE,
	},
	organization: {
		logo: TEXT_TYPE,
		metadata: TEXT_TYPE,
		inn: TEXT_TYPE,
		taxForm: TEXT_TYPE,
		dedicatedDatabaseUrl: TEXT_TYPE,
		trialEndsAt: DATETIME_TYPE,
	},
	invitation: {
		role: TEXT_TYPE,
	},
}

/** Convert JS null → typed YDB Optional(null, Type). Non-null values pass through. */
function ydbValue(model: string, field: string, value: unknown): unknown {
	if (value != null) return value
	const colType = COLUMN_TYPES[model]?.[field] ?? TEXT_TYPE
	return new Optional(null, colType)
}

// ---------------------------------------------------------------------------
// Index hints — YDB VIEW optimization for secondary index lookups
// ---------------------------------------------------------------------------
//
// DISABLED on MVP. YDB Query Service + tagged-template `Object.assign(strings,
// {raw: strings})` hack + VIEW index clause → `SCHEME_ERROR 1030: Required
// global index not found` (verified 2026-04-23, see project_ydb_specifics.md).
// CLI path `ydb sql -s` with plain DECLARE works — this is a @ydbjs/query
// tagged-template interop issue, not a schema problem. Better Auth tables
// (user/session/account/...) are small on MVP and full scan is acceptable.
// When scaling matters, use native tagged-template in domain code where
// VIEW works correctly (without the hack).
//
// Re-enable once we verify VIEW works correctly with @ydbjs/query dynamic
// queries (either via upstream fix or by reworking execQuery).

function resolveViewHint(_model: string, _wheres: CleanedWhere[]): string | null {
	return null
}

// ---------------------------------------------------------------------------
// Dynamic WHERE builder
// ---------------------------------------------------------------------------

function escapeLike(value: string): string {
	return value.replace(/%/g, '\\%').replace(/_/g, '\\_')
}

function buildWhere(wheres: CleanedWhere[]): { clause: string; params: unknown[] } {
	if (wheres.length === 0) return { clause: '', params: [] }

	const parts: string[] = []
	const params: unknown[] = []

	for (let i = 0; i < wheres.length; i++) {
		const w = wheres[i]
		if (!w) continue
		const { field, operator: op, value: val } = w
		let condition: string

		if (op === 'eq' && val === null) {
			condition = `\`${field}\` IS NULL`
		} else if (op === 'ne' && val === null) {
			condition = `\`${field}\` IS NOT NULL`
		} else if (op === 'in' || op === 'not_in') {
			const arr = val as (string | number)[]
			const placeholders = arr.map((v) => {
				const idx = params.length
				params.push(v)
				return `$p${idx}`
			})
			condition = `\`${field}\` ${op === 'in' ? 'IN' : 'NOT IN'} (${placeholders.join(', ')})`
		} else if (op === 'contains') {
			const idx = params.length
			params.push(`%${escapeLike(String(val))}%`)
			condition = `\`${field}\` LIKE $p${idx}`
		} else if (op === 'starts_with') {
			const idx = params.length
			params.push(`${escapeLike(String(val))}%`)
			condition = `\`${field}\` LIKE $p${idx}`
		} else if (op === 'ends_with') {
			const idx = params.length
			params.push(`%${escapeLike(String(val))}`)
			condition = `\`${field}\` LIKE $p${idx}`
		} else {
			const opMap: Record<string, string> = {
				eq: '=',
				ne: '!=',
				lt: '<',
				lte: '<=',
				gt: '>',
				gte: '>=',
			}
			const idx = params.length
			params.push(val)
			// `op` can technically be undefined in the Where type even after `Required`
			// (exactOptionalPropertyTypes keeps `| undefined`). Default to eq — BA never
			// emits undefined here, but we defend at the boundary.
			const sqlOp = op ? (opMap[op] ?? '=') : '='
			condition = `\`${field}\` ${sqlOp} $p${idx}`
		}

		if (i > 0) parts.push(w.connector === 'OR' ? ' OR ' : ' AND ')
		parts.push(condition)
	}

	return { clause: `WHERE ${parts.join('')}`, params }
}

// ---------------------------------------------------------------------------
// Dynamic query execution
// ---------------------------------------------------------------------------

/**
 * Execute dynamic SQL. queryStr contains $p0, $p1, … placeholders.
 * Calls sql(templateStrings, ...values) via tagged-template call convention.
 * @ydbjs/query auto-generates DECLARE statements from value types.
 */
async function execQuery(
	sql: SqlOrTx,
	queryStr: string,
	params: unknown[],
	options?: { isolation?: 'snapshotReadOnly' | 'onlineReadOnly'; idempotent?: boolean },
): Promise<[Record<string, unknown>[], ...Record<string, unknown>[][]]> {
	if (params.length === 0) {
		const q = sql`${unsafe(queryStr)}`
		if (options?.isolation) {
			return (await q.isolation(options.isolation).idempotent(options.idempotent ?? false)) as [
				Record<string, unknown>[],
				...Record<string, unknown>[][],
			]
		}
		return (await q) as [Record<string, unknown>[], ...Record<string, unknown>[][]]
	}

	// Split on $pN placeholders, interleave with actual values
	const fragments = queryStr.split(/\$p\d+/)
	const paramRefs = [...queryStr.matchAll(/\$p(\d+)/g)].map((m) => Number(m[1]))

	const strings: string[] = []
	const values: unknown[] = []
	for (let i = 0; i < fragments.length; i++) {
		strings.push(fragments[i] ?? '')
		const refIdx = paramRefs[i]
		if (i < paramRefs.length && refIdx !== undefined) values.push(params[refIdx])
	}

	// sql(strings, ...values) — tagged template call convention
	const templateStrings = Object.assign(strings, { raw: strings })
	const q = sql(templateStrings as TemplateStringsArray, ...values)

	if (options?.isolation) {
		return (await q.isolation(options.isolation).idempotent(options.idempotent ?? false)) as [
			Record<string, unknown>[],
			...Record<string, unknown>[][],
		]
	}
	// biome-ignore lint/nursery/useAwaitThenable: @ydbjs/query Query<T> is thenable (its .then() dispatches exec); biome nursery doesn't see through SqlOrTx union.
	return (await q) as [Record<string, unknown>[], ...Record<string, unknown>[][]]
}

// ---------------------------------------------------------------------------
// UPSERT data preparation
// ---------------------------------------------------------------------------

function prepareUpsertData(
	model: string,
	data: Record<string, unknown>,
): { columns: string[]; values: unknown[] } {
	const columns: string[] = []
	const values: unknown[] = []

	for (const [key, value] of Object.entries(data)) {
		if (value === undefined) continue
		columns.push(key)
		values.push(ydbValue(model, key, value))
	}

	return { columns, values }
}

/**
 * With `supportsDates: true`, factory expects Date back from adapter.
 * @ydbjs/query.toJs() already converts Datetime → Date, so we just pass through.
 */
function convertRow(row: Record<string, unknown>): Record<string, unknown> {
	return row
}

// ---------------------------------------------------------------------------
// CustomAdapter builder — bound to a sql or tx connection
// ---------------------------------------------------------------------------

function buildCrudAdapter(q: SqlOrTx): CustomAdapter {
	return {
		async create({ model, data }) {
			const { columns, values } = prepareUpsertData(model, data as Record<string, unknown>)
			const colList = columns.map((c) => `\`${c}\``).join(', ')
			const placeholders = columns.map((_, i) => `$p${i}`).join(', ')

			const upsertSql = `UPSERT INTO \`${model}\` (${colList}) VALUES (${placeholders})`
			await execQuery(q, upsertSql, values)

			const id = (data as Record<string, unknown>).id as string
			const selectSql = `SELECT * FROM \`${model}\` WHERE \`id\` = $p0`
			const [rows] = await execQuery(q, selectSql, [id])
			const row = rows[0]
			// BA `CustomAdapter.create<T>` promises to return T (the input shape).
			// We can only surface the normalized row; cast through `unknown` is the
			// honest pattern — narrower than `as any` (no method proliferation) but
			// explicit about the type-level limitation in BA's polymorphic adapter.
			if (!row) return data
			return convertRow(row) as unknown as typeof data
		},

		// @ts-expect-error Better Auth `CustomAdapter.findOne<T>` promises to return T
		// (caller's row type), but our generic converter returns Record<string, unknown>.
		// Known SDK limitation — BA's polymorphic adapter interface cannot be satisfied
		// from a type-erased row mapper.
		async findOne({ model, where }) {
			const viewHint = resolveViewHint(model, where)
			const viewClause = viewHint ? ` VIEW ${viewHint}` : ''
			const { clause, params } = buildWhere(where)
			const queryStr = `SELECT * FROM \`${model}\`${viewClause} ${clause} LIMIT 1`

			const [rows] = await execQuery(q, queryStr, params, {
				isolation: 'snapshotReadOnly',
				idempotent: true,
			})
			if (!rows[0]) return null
			return convertRow(rows[0])
		},

		// @ts-expect-error Same as findOne: CustomAdapter.findMany<T> expects T[].
		async findMany({ model, where, limit, sortBy, offset }) {
			let viewClause = ''
			if (where && where.length > 0) {
				const viewHint = resolveViewHint(model, where)
				viewClause = viewHint ? ` VIEW ${viewHint}` : ''
			}

			const { clause, params } = where ? buildWhere(where) : { clause: '', params: [] }
			let queryStr = `SELECT * FROM \`${model}\`${viewClause} ${clause}`

			if (sortBy) {
				queryStr += ` ORDER BY \`${sortBy.field}\` ${sortBy.direction === 'desc' ? 'DESC' : 'ASC'}`
			}
			if (limit) queryStr += ` LIMIT ${Number(limit)}`
			if (offset) queryStr += ` OFFSET ${Number(offset)}`

			const [rows] = await execQuery(q, queryStr, params, {
				isolation: 'snapshotReadOnly',
				idempotent: true,
			})
			const out = rows ?? []
			return out.map(convertRow)
		},

		async count({ model, where }) {
			const { clause, params } = where ? buildWhere(where) : { clause: '', params: [] }
			const queryStr = `SELECT COUNT(*) AS cnt FROM \`${model}\` ${clause}`
			const [rows] = await execQuery(q, queryStr, params, {
				isolation: 'snapshotReadOnly',
				idempotent: true,
			})
			const cnt = rows[0]?.cnt
			return typeof cnt === 'bigint' ? Number(cnt) : Number(cnt ?? 0)
		},

		// @ts-expect-error Same as findOne: CustomAdapter.update<T> expects T | null.
		async update({ model, where, update: updateData }) {
			const viewHint = resolveViewHint(model, where)
			const viewClause = viewHint ? ` VIEW ${viewHint}` : ''
			const { clause, params: whereParams } = buildWhere(where)

			const selectSql = `SELECT * FROM \`${model}\`${viewClause} ${clause} LIMIT 1`
			const [existingRows] = await execQuery(q, selectSql, whereParams)
			const existing = existingRows[0]
			if (!existing) return null

			const merged = { ...existing, ...(updateData as Record<string, unknown>) }
			const { columns, values } = prepareUpsertData(model, merged)
			const colList = columns.map((c) => `\`${c}\``).join(', ')
			const placeholders = columns.map((_, i) => `$p${i}`).join(', ')
			await execQuery(q, `UPSERT INTO \`${model}\` (${colList}) VALUES (${placeholders})`, values)

			const id = merged.id as string
			const [updatedRows] = await execQuery(q, `SELECT * FROM \`${model}\` WHERE \`id\` = $p0`, [
				id,
			])
			if (!updatedRows[0]) return null
			return convertRow(updatedRows[0])
		},

		async updateMany({ model, where, update: updateData }) {
			const viewHint = resolveViewHint(model, where)
			const viewClause = viewHint ? ` VIEW ${viewHint}` : ''
			const { clause, params: whereParams } = buildWhere(where)

			const [existingRows] = await execQuery(
				q,
				`SELECT * FROM \`${model}\`${viewClause} ${clause}`,
				whereParams,
			)
			if (existingRows.length === 0) return 0

			for (const existing of existingRows) {
				const merged = { ...existing, ...(updateData as Record<string, unknown>) }
				const { columns, values } = prepareUpsertData(model, merged)
				const colList = columns.map((c) => `\`${c}\``).join(', ')
				const placeholders = columns.map((_, i) => `$p${i}`).join(', ')
				await execQuery(q, `UPSERT INTO \`${model}\` (${colList}) VALUES (${placeholders})`, values)
			}
			return existingRows.length
		},

		async delete({ model, where }) {
			const { clause, params } = buildWhere(where)
			await execQuery(q, `DELETE FROM \`${model}\` ${clause}`, params)
		},

		async deleteMany({ model, where }) {
			const viewHint = resolveViewHint(model, where)
			const viewClause = viewHint ? ` VIEW ${viewHint}` : ''
			const { clause, params } = buildWhere(where)

			const [countRows] = await execQuery(
				q,
				`SELECT COUNT(*) AS cnt FROM \`${model}\`${viewClause} ${clause}`,
				params,
				{ isolation: 'snapshotReadOnly', idempotent: true },
			)
			const cnt = countRows[0]?.cnt
			const count = typeof cnt === 'bigint' ? Number(cnt) : Number(cnt ?? 0)
			if (count === 0) return 0

			await execQuery(q, `DELETE FROM \`${model}\` ${clause}`, params)
			return count
		},
	}
}

// ---------------------------------------------------------------------------
// Adapter factory export
// ---------------------------------------------------------------------------

/**
 * YDB adapter for Better Auth.
 *
/**
 * Transactions: we implement Better Auth's optional `transaction` hook by
 * opening a YDB `sql.begin(async (tx) => …)` and rebuilding the CRUD adapter
 * bound to `tx`. Any `throw` inside the callback aborts the transaction
 * cleanly (YDB rolls back); normal return auto-commits.
 *
 * This fixes the historical "sign-up is not atomic" footnote (user + account +
 * session across three UPSERTs): a failure mid-way now rolls back, no orphan
 * rows. Verified empirically against @ydbjs/query 6.1.0 (session pool era).
 *
 * The earlier attempt at this (documented in git history) rolled back silently
 * because it built a *new* adapter via `createAdapterFactory` inside the
 * callback instead of a bare `CustomAdapter`. BA's own `wrapWithTx` treated
 * that re-entrant factory as a separate connection and discarded the writes.
 * Here we call `buildCrudAdapter(tx)` directly — a plain object, no factory.
 */
export function ydbAdapter(sql: SqlInstance) {
	return createAdapterFactory({
		config: {
			adapterId: 'ydb',
			supportsDates: true,
			supportsJSON: false,
			supportsBooleans: true,
			supportsArrays: false,
			supportsNumericIds: false,
		},
		adapter: () => ({
			...buildCrudAdapter(sql),
			transaction: <R>(callback: (trx: CustomAdapter) => Promise<R>): Promise<R> =>
				sql.begin(async (tx) => callback(buildCrudAdapter(tx))),
		}),
	})
}
