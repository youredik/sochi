/**
 * Folio repository — atomic folio + folioLine writes inside `sql.begin`.
 *
 * Patterns inherited from booking.repo.ts (the reference for our YDB conventions):
 *   - All methods take `tenantId` first; tenant isolation absolute.
 *   - `sql.begin({ idempotent })` for retryable writes; manual unwrap of
 *     `err.cause` because `sql.begin` wraps non-retryable errors in
 *     `new Error('Transaction failed.', { cause })` (see memory
 *     `project_ydb_specifics.md` #11).
 *   - Full-row UPSERT for any update touching a nullable column (#14 — YDB
 *     `UPDATE ... SET` rejects mixed NOT NULL + Optional binds).
 *   - `Date` columns wrapped via `dateFromIso`; `Timestamp` via `toTs`/`tsFromIso`
 *     to preserve ms precision (#10).
 *   - OCC version-CAS: every UPDATE bumps `version`; concurrent writers see a
 *     mismatch and surface `FolioVersionConflictError` (invariant #6).
 *
 * Methods (M6.1 surface — only what demo + invariants require):
 *   - createForBooking: open a guest folio for a booking (called from booking
 *     creation flow + backfill). Returns the new folio.
 *   - getById: tenant-scoped by-id lookup.
 *   - listByBooking: all folios for a booking (group bookings have multiple).
 *   - postLine: append a posted folioLine + bump folio.balanceMinor in one tx.
 *   - voidLine: same-day reversal of a posted line + adjust balance.
 *   - close: open → closed. Blocks if any draft lines exist.
 *   - recomputeBalance: source-of-truth recompute from folioLine projection.
 *     Called by CDC consumer after every line/payment/refund commit.
 *
 * Key invariants enforced here (cross-ref to canon):
 *   - #6 version monotonic: every UPDATE bumps version by exactly 1.
 *   - #4 folio-close-no-pending-lines: blocks close if draft lines exist.
 *   - #12 folio-balance-conservation: recomputeBalance is the authoritative
 *     projection from folioLine sum (caller passes payment/refund sums).
 *   - #13 terminal-no-rollback: settled is terminal; service layer asserts.
 *   - #14 currency-folio-match: posting a line in different currency rejects.
 *   - Cross-tenant immutable: never accept a tenantId different from the row's.
 */
import type { FolioKind, FolioLine, FolioLineStatus, Folio as FolioRow } from '@horeca/shared'
import { newId } from '@horeca/shared'
import type { TX } from '@ydbjs/query'
import type { sql as SQL } from '../../db/index.ts'
import { NULL_TEXT, NULL_TIMESTAMP, timestampOpt, toTs } from '../../db/ydb-helpers.ts'
import {
	FolioCurrencyMismatchError,
	FolioHasDraftLinesError,
	FolioNotFoundError,
	FolioVersionConflictError,
	InvalidFolioLineTransitionError,
	InvalidFolioTransitionError,
} from '../../errors/domain.ts'
import { computeBalanceMinor, computeChargesMinor } from './lib/folio-balance.ts'

type SqlInstance = typeof SQL

/* =================================================================== row shapes */

type FolioDbRow = {
	tenantId: string
	propertyId: string
	bookingId: string
	id: string
	kind: string
	status: string
	currency: string
	balanceMinor: number | bigint
	version: number | bigint
	closedAt: Date | null
	settledAt: Date | null
	closedBy: string | null
	companyId: string | null
	createdAt: Date
	updatedAt: Date
	createdBy: string
	updatedBy: string
}

type FolioLineDbRow = {
	tenantId: string
	folioId: string
	id: string
	category: string
	description: string
	amountMinor: number | bigint
	isAccommodationBase: boolean
	taxRateBps: number | bigint
	lineStatus: string
	routingRuleId: string | null
	postedAt: Date | null
	voidedAt: Date | null
	voidReason: string | null
	version: number | bigint
	createdAt: Date
	updatedAt: Date
	createdBy: string
	updatedBy: string
}

function rowToFolio(r: FolioDbRow): FolioRow {
	return {
		tenantId: r.tenantId,
		propertyId: r.propertyId,
		bookingId: r.bookingId,
		id: r.id,
		kind: r.kind as FolioKind,
		status: r.status as FolioRow['status'],
		currency: r.currency,
		balanceMinor: BigInt(r.balanceMinor).toString(),
		version: Number(r.version),
		closedAt: r.closedAt?.toISOString() ?? null,
		settledAt: r.settledAt?.toISOString() ?? null,
		closedBy: r.closedBy,
		companyId: r.companyId,
		createdAt: r.createdAt.toISOString(),
		updatedAt: r.updatedAt.toISOString(),
		createdBy: r.createdBy,
		updatedBy: r.updatedBy,
	}
}

function rowToFolioLine(r: FolioLineDbRow): FolioLine {
	return {
		tenantId: r.tenantId,
		folioId: r.folioId,
		id: r.id,
		category: r.category as FolioLine['category'],
		description: r.description,
		amountMinor: BigInt(r.amountMinor).toString(),
		isAccommodationBase: r.isAccommodationBase,
		taxRateBps: Number(r.taxRateBps),
		lineStatus: r.lineStatus as FolioLineStatus,
		routingRuleId: r.routingRuleId,
		postedAt: r.postedAt?.toISOString() ?? null,
		voidedAt: r.voidedAt?.toISOString() ?? null,
		voidReason: r.voidReason,
		version: Number(r.version),
		createdAt: r.createdAt.toISOString(),
		updatedAt: r.updatedAt.toISOString(),
		createdBy: r.createdBy,
		updatedBy: r.updatedBy,
	}
}

/* ========================================================== private tx helpers */

async function loadFolioForTx(tx: TX, tenantId: string, id: string): Promise<FolioRow | null> {
	// VIEW-less scan because folio is small (~ N folios per booking, N <= 8).
	// PK starts with tenantId so this is a single-shard short range scan.
	const [rows = []] = await tx<FolioDbRow[]>`
		SELECT * FROM folio WHERE tenantId = ${tenantId} AND id = ${id} LIMIT 1
	`
	const row = rows[0]
	return row ? rowToFolio(row) : null
}

async function loadLinesForTx(tx: TX, tenantId: string, folioId: string): Promise<FolioLine[]> {
	const [rows = []] = await tx<FolioLineDbRow[]>`
		SELECT * FROM folioLine
		WHERE tenantId = ${tenantId} AND folioId = ${folioId}
		ORDER BY createdAt ASC, id ASC
	`
	return rows.map(rowToFolioLine)
}

/**
 * Full-row UPSERT for folio. Used by every state transition because YDB
 * `UPDATE ... SET` chokes on mixed NOT NULL + Optional columns (#14).
 *
 * `next.version` MUST equal `current.version + 1` — caller responsibility.
 */
async function upsertFolioRow(
	tx: TX,
	current: FolioRow,
	next: {
		status?: FolioRow['status']
		balanceMinor?: bigint
		version: number
		updatedAt: Date
		updatedBy: string
		closedAt?: Date | null
		settledAt?: Date | null
		closedBy?: string | null
	},
): Promise<void> {
	const status = next.status ?? current.status
	const balance = next.balanceMinor ?? BigInt(current.balanceMinor)
	const closedAtDate =
		'closedAt' in next ? next.closedAt : current.closedAt ? new Date(current.closedAt) : null
	const settledAtDate =
		'settledAt' in next ? next.settledAt : current.settledAt ? new Date(current.settledAt) : null
	const closedBy = 'closedBy' in next ? next.closedBy : current.closedBy

	await tx`
		UPSERT INTO folio (
			\`tenantId\`, \`propertyId\`, \`bookingId\`, \`id\`,
			\`kind\`, \`status\`, \`currency\`, \`balanceMinor\`, \`version\`,
			\`closedAt\`, \`settledAt\`, \`closedBy\`, \`companyId\`,
			\`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
		) VALUES (
			${current.tenantId}, ${current.propertyId}, ${current.bookingId}, ${current.id},
			${current.kind}, ${status}, ${current.currency}, ${balance}, ${next.version},
			${timestampOpt(closedAtDate)},
			${timestampOpt(settledAtDate)},
			${closedBy ?? NULL_TEXT},
			${current.companyId ?? NULL_TEXT},
			${toTs(new Date(current.createdAt))}, ${toTs(next.updatedAt)},
			${current.createdBy}, ${next.updatedBy}
		)
	`
}

/** version-CAS guard: throw if loaded version differs from expected. */
function assertVersion(folio: FolioRow, expected: number): void {
	if (folio.version !== expected) {
		throw new FolioVersionConflictError(folio.id, expected, folio.version)
	}
}

/* ============================================================ public surface */

export type FolioCreateContext = {
	actorUserId: string
	currency: string
	companyId: string | null
}

export function createFolioRepo(sql: SqlInstance) {
	return {
		/**
		 * Open a fresh folio for a booking. version starts at 1, balance at 0.
		 *
		 * V1 demo flow: called automatically from booking-create with
		 * `kind='guest'`. Group bookings (V2) will call multiple times for
		 * group_master + per-room guest folios.
		 */
		async createForBooking(
			tenantId: string,
			propertyId: string,
			bookingId: string,
			kind: FolioKind,
			ctx: FolioCreateContext,
		): Promise<FolioRow> {
			const id = newId('folio')
			const now = new Date()
			const nowTs = toTs(now)

			await sql`
				UPSERT INTO folio (
					\`tenantId\`, \`propertyId\`, \`bookingId\`, \`id\`,
					\`kind\`, \`status\`, \`currency\`, \`balanceMinor\`, \`version\`,
					\`closedAt\`, \`settledAt\`, \`closedBy\`, \`companyId\`,
					\`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
				) VALUES (
					${tenantId}, ${propertyId}, ${bookingId}, ${id},
					${kind}, ${'open'}, ${ctx.currency}, ${0n}, ${1},
					${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TEXT},
					${ctx.companyId ?? NULL_TEXT},
					${nowTs}, ${nowTs}, ${ctx.actorUserId}, ${ctx.actorUserId}
				)
			`

			return {
				tenantId,
				propertyId,
				bookingId,
				id,
				kind,
				status: 'open',
				currency: ctx.currency,
				balanceMinor: '0',
				version: 1,
				closedAt: null,
				settledAt: null,
				closedBy: null,
				companyId: ctx.companyId,
				createdAt: now.toISOString(),
				updatedAt: now.toISOString(),
				createdBy: ctx.actorUserId,
				updatedBy: ctx.actorUserId,
			}
		},

		async getById(tenantId: string, id: string): Promise<FolioRow | null> {
			const [rows = []] = await sql<FolioDbRow[]>`
				SELECT * FROM folio WHERE tenantId = ${tenantId} AND id = ${id} LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			return row ? rowToFolio(row) : null
		},

		async listByBooking(tenantId: string, bookingId: string): Promise<FolioRow[]> {
			const [rows = []] = await sql<FolioDbRow[]>`
				SELECT * FROM folio VIEW ixFolioBooking
				WHERE tenantId = ${tenantId} AND bookingId = ${bookingId}
				ORDER BY createdAt ASC, id ASC
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.map(rowToFolio)
		},

		/**
		 * Receivables / aging dashboard — открытые + закрытые-неоплаченные folios
		 * с положительным balanceMinor для конкретного property. Использует
		 * `ixFolioStatus GLOBAL SYNC ON (tenantId, propertyId, status)` (single-shard
		 * scan по композитному ключу). `balanceMinor > 0` фильтруется в predicate
		 * — не индексируется отдельно (cardinality balance > 0 ≈ 90% открытых).
		 *
		 * `settled` исключаем: терминальное состояние, balance гарантированно 0.
		 * `closed` включаем: закрытые-без-оплаты — главный сигнал просрочки.
		 *
		 * Ordering by `createdAt ASC` → старейшие сверху (canon aging dashboard:
		 * самые просроченные первыми).
		 */
		async listReceivablesByProperty(tenantId: string, propertyId: string): Promise<FolioRow[]> {
			const [rows = []] = await sql<FolioDbRow[]>`
				SELECT * FROM folio VIEW ixFolioStatus
				WHERE tenantId = ${tenantId}
				  AND propertyId = ${propertyId}
				  AND status IN ('open', 'closed')
				  AND balanceMinor > 0
				ORDER BY createdAt ASC, id ASC
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.map(rowToFolio)
		},

		async listLinesByFolio(tenantId: string, folioId: string): Promise<FolioLine[]> {
			const [rows = []] = await sql<FolioLineDbRow[]>`
				SELECT * FROM folioLine
				WHERE tenantId = ${tenantId} AND folioId = ${folioId}
				ORDER BY createdAt ASC, id ASC
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.map(rowToFolioLine)
		},

		/**
		 * Post a line to an open folio in one tx:
		 *   1. Load folio (CAS version check).
		 *   2. Currency match assertion (invariant #14).
		 *   3. Status check: only `open` folios accept lines.
		 *   4. INSERT folioLine with `lineStatus='posted'`, `postedAt=now`.
		 *   5. UPSERT folio with `balanceMinor += amountMinor`, `version += 1`.
		 *
		 * Returns the new line. Throws on:
		 *   - FolioNotFoundError (cross-tenant or deleted)
		 *   - InvalidFolioTransitionError (folio not open)
		 *   - FolioCurrencyMismatchError
		 *   - FolioVersionConflictError (concurrent CAS)
		 */
		async postLine(
			tenantId: string,
			folioId: string,
			input: {
				category: FolioLine['category']
				description: string
				amountMinor: bigint
				isAccommodationBase: boolean
				taxRateBps: number
				routingRuleId: string | null
				expectedFolioCurrency: string
				expectedFolioVersion: number
			},
			actorUserId: string,
		): Promise<{ folio: FolioRow; line: FolioLine }> {
			try {
				return await sql.begin({ idempotent: true }, async (tx) => {
					const current = await loadFolioForTx(tx, tenantId, folioId)
					if (!current) throw new FolioNotFoundError(folioId)
					if (current.status !== 'open') {
						throw new InvalidFolioTransitionError(current.status, 'open (post line)')
					}
					if (current.currency !== input.expectedFolioCurrency) {
						throw new FolioCurrencyMismatchError(current.currency, input.expectedFolioCurrency)
					}
					assertVersion(current, input.expectedFolioVersion)

					const lineId = newId('folioLine')
					const now = new Date()
					const nowTs = toTs(now)

					await tx`
						UPSERT INTO folioLine (
							\`tenantId\`, \`folioId\`, \`id\`,
							\`category\`, \`description\`, \`amountMinor\`,
							\`isAccommodationBase\`, \`taxRateBps\`,
							\`lineStatus\`, \`routingRuleId\`, \`postedAt\`, \`voidedAt\`, \`voidReason\`,
							\`version\`,
							\`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
						) VALUES (
							${tenantId}, ${folioId}, ${lineId},
							${input.category}, ${input.description}, ${input.amountMinor},
							${input.isAccommodationBase}, ${input.taxRateBps},
							${'posted'}, ${input.routingRuleId ?? NULL_TEXT},
							${toTs(now)}, ${NULL_TIMESTAMP}, ${NULL_TEXT},
							${1},
							${nowTs}, ${nowTs}, ${actorUserId}, ${actorUserId}
						)
					`

					const newBalance = BigInt(current.balanceMinor) + input.amountMinor
					const newVersion = current.version + 1
					await upsertFolioRow(tx, current, {
						balanceMinor: newBalance,
						version: newVersion,
						updatedAt: now,
						updatedBy: actorUserId,
					})

					const line: FolioLine = {
						tenantId,
						folioId,
						id: lineId,
						category: input.category,
						description: input.description,
						amountMinor: input.amountMinor.toString(),
						isAccommodationBase: input.isAccommodationBase,
						taxRateBps: input.taxRateBps,
						lineStatus: 'posted',
						routingRuleId: input.routingRuleId,
						postedAt: now.toISOString(),
						voidedAt: null,
						voidReason: null,
						version: 1,
						createdAt: now.toISOString(),
						updatedAt: now.toISOString(),
						createdBy: actorUserId,
						updatedBy: actorUserId,
					}
					const folio: FolioRow = {
						...current,
						balanceMinor: newBalance.toString(),
						version: newVersion,
						updatedAt: now.toISOString(),
						updatedBy: actorUserId,
					}
					return { folio, line }
				})
			} catch (err) {
				// Unwrap sql.begin's `Transaction failed.` wrap (#11).
				if (err instanceof Error && err.cause instanceof FolioNotFoundError) throw err.cause
				if (err instanceof Error && err.cause instanceof InvalidFolioTransitionError)
					throw err.cause
				if (err instanceof Error && err.cause instanceof FolioCurrencyMismatchError) throw err.cause
				if (err instanceof Error && err.cause instanceof FolioVersionConflictError) throw err.cause
				throw err
			}
		},

		/**
		 * Void a posted line:
		 *   1. Load line + folio.
		 *   2. Line must be `posted` (draft lines are deleted, not voided;
		 *      void-of-void is forbidden — terminal sub-state).
		 *   3. UPSERT line with `lineStatus='void'`, voidedAt=now, voidReason=...
		 *   4. UPSERT folio with `balanceMinor -= amountMinor`, version+=1.
		 */
		async voidLine(
			tenantId: string,
			folioId: string,
			lineId: string,
			reason: string,
			actorUserId: string,
		): Promise<{ folio: FolioRow; line: FolioLine }> {
			try {
				return await sql.begin({ idempotent: true }, async (tx) => {
					const folio = await loadFolioForTx(tx, tenantId, folioId)
					if (!folio) throw new FolioNotFoundError(folioId)

					const [lineRows = []] = await tx<FolioLineDbRow[]>`
						SELECT * FROM folioLine
						WHERE tenantId = ${tenantId} AND folioId = ${folioId} AND id = ${lineId}
						LIMIT 1
					`
					const lineRow = lineRows[0]
					if (!lineRow) throw new FolioNotFoundError(lineId)

					const current = rowToFolioLine(lineRow)
					if (current.lineStatus !== 'posted') {
						throw new InvalidFolioLineTransitionError(current.lineStatus, 'void')
					}

					const now = new Date()
					const nowTs = toTs(now)
					const newLineVersion = current.version + 1

					await tx`
						UPSERT INTO folioLine (
							\`tenantId\`, \`folioId\`, \`id\`,
							\`category\`, \`description\`, \`amountMinor\`,
							\`isAccommodationBase\`, \`taxRateBps\`,
							\`lineStatus\`, \`routingRuleId\`, \`postedAt\`, \`voidedAt\`, \`voidReason\`,
							\`version\`,
							\`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
						) VALUES (
							${tenantId}, ${folioId}, ${lineId},
							${current.category}, ${current.description}, ${BigInt(current.amountMinor)},
							${current.isAccommodationBase}, ${current.taxRateBps},
							${'void'}, ${current.routingRuleId ?? NULL_TEXT},
							${current.postedAt ? toTs(new Date(current.postedAt)) : NULL_TIMESTAMP},
							${nowTs}, ${reason},
							${newLineVersion},
							${toTs(new Date(current.createdAt))}, ${nowTs}, ${current.createdBy}, ${actorUserId}
						)
					`

					const lineAmount = BigInt(current.amountMinor)
					const newBalance = BigInt(folio.balanceMinor) - lineAmount
					const newFolioVersion = folio.version + 1
					await upsertFolioRow(tx, folio, {
						balanceMinor: newBalance,
						version: newFolioVersion,
						updatedAt: now,
						updatedBy: actorUserId,
					})

					return {
						folio: {
							...folio,
							balanceMinor: newBalance.toString(),
							version: newFolioVersion,
							updatedAt: now.toISOString(),
							updatedBy: actorUserId,
						},
						line: {
							...current,
							lineStatus: 'void',
							voidedAt: now.toISOString(),
							voidReason: reason,
							version: newLineVersion,
							updatedAt: now.toISOString(),
							updatedBy: actorUserId,
						},
					}
				})
			} catch (err) {
				if (err instanceof Error && err.cause instanceof FolioNotFoundError) throw err.cause
				if (err instanceof Error && err.cause instanceof InvalidFolioLineTransitionError)
					throw err.cause
				throw err
			}
		},

		/**
		 * Close a folio (open → closed). Invariant #4: blocks if any draft lines.
		 * Settled state is reached separately when balance hits zero.
		 */
		async close(tenantId: string, folioId: string, actorUserId: string): Promise<FolioRow> {
			try {
				return await sql.begin({ idempotent: true }, async (tx) => {
					const current = await loadFolioForTx(tx, tenantId, folioId)
					if (!current) throw new FolioNotFoundError(folioId)
					if (current.status !== 'open') {
						throw new InvalidFolioTransitionError(current.status, 'closed')
					}

					const lines = await loadLinesForTx(tx, tenantId, folioId)
					const draftCount = lines.filter((l) => l.lineStatus === 'draft').length
					if (draftCount > 0) {
						throw new FolioHasDraftLinesError(folioId, draftCount)
					}

					const now = new Date()
					const newVersion = current.version + 1
					await upsertFolioRow(tx, current, {
						status: 'closed',
						version: newVersion,
						updatedAt: now,
						updatedBy: actorUserId,
						closedAt: now,
						closedBy: actorUserId,
					})

					return {
						...current,
						status: 'closed',
						version: newVersion,
						closedAt: now.toISOString(),
						closedBy: actorUserId,
						updatedAt: now.toISOString(),
						updatedBy: actorUserId,
					}
				})
			} catch (err) {
				if (err instanceof Error && err.cause instanceof FolioNotFoundError) throw err.cause
				if (err instanceof Error && err.cause instanceof InvalidFolioTransitionError)
					throw err.cause
				if (err instanceof Error && err.cause instanceof FolioHasDraftLinesError) throw err.cause
				throw err
			}
		},

		/**
		 * Authoritative balance recompute from folioLine projection + caller-supplied
		 * payment/refund sums. Called by CDC consumer after every commit affecting the
		 * folio. Invariant #12 (balance conservation).
		 *
		 * Pure-lib `computeBalanceMinor` is the math; this method handles the
		 * persistence side (load, recompute, CAS-bump).
		 */
		async recomputeBalance(
			tenantId: string,
			folioId: string,
			paymentsAppliedMinor: bigint,
			refundsAppliedMinor: bigint,
			actorUserId: string,
		): Promise<FolioRow> {
			try {
				return await sql.begin({ idempotent: true }, async (tx) => {
					const current = await loadFolioForTx(tx, tenantId, folioId)
					if (!current) throw new FolioNotFoundError(folioId)
					const lines = await loadLinesForTx(tx, tenantId, folioId)
					const charges = computeChargesMinor(lines)
					const balance = computeBalanceMinor({
						chargesMinor: charges,
						paymentsAppliedMinor,
						refundsAppliedMinor,
					})

					if (balance.toString() === current.balanceMinor) {
						// No-op: balance unchanged; skip the CAS bump to avoid
						// CDC churn on idle ticks.
						return current
					}

					const now = new Date()
					const newVersion = current.version + 1
					await upsertFolioRow(tx, current, {
						balanceMinor: balance,
						version: newVersion,
						updatedAt: now,
						updatedBy: actorUserId,
					})

					return {
						...current,
						balanceMinor: balance.toString(),
						version: newVersion,
						updatedAt: now.toISOString(),
						updatedBy: actorUserId,
					}
				})
			} catch (err) {
				if (err instanceof Error && err.cause instanceof FolioNotFoundError) throw err.cause
				throw err
			}
		},
	}
}

export type FolioRepo = ReturnType<typeof createFolioRepo>
