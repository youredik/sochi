/**
 * MigrationRegistration repository — YDB CRUD за `migrationRegistration`
 * table (migration 0035).
 *
 * Patch semantics (canonical в codebase, mirrors compliance.repo.ts):
 *   - `undefined` ⇒ no change to stored field
 *   - explicit `null` ⇒ clear field (set DB NULL)
 *
 * Cross-tenant isolation: PK (tenantId, id), все WHERE clauses filter by
 * tenantId. Repo тесты verify cross-tenant matrix per pre-done audit.
 *
 * Read-after-write: серииализованный isolation (NO snapshotReadOnly per
 * `feedback_no_snapshotReadOnly_in_tests.md`). Сильное consistency для FSM
 * polling — иначе cron видит устаревший status и race-condition'ит.
 */
import type { EpguChannel, EpguErrorCategory, MigrationRegistration } from '@horeca/shared'
import type { sql as SQL } from '../../../db/index.ts'
import {
	dateFromIso,
	NULL_TEXT,
	NULL_TIMESTAMP,
	textOpt,
	timestampOpt,
	toJson,
	toTs,
} from '../../../db/ydb-helpers.ts'

type SqlInstance = typeof SQL

type Row = {
	tenantId: string
	id: string
	bookingId: string
	guestId: string
	documentId: string
	epguChannel: string
	epguOrderId: string | null
	epguApplicationNumber: string | null
	serviceCode: string
	targetCode: string
	supplierGid: string
	regionCode: string
	arrivalDate: Date
	departureDate: Date
	statusCode: number
	isFinal: boolean
	reasonRefuse: string | null
	errorCategory: string | null
	submittedAt: Date | null
	lastPolledAt: Date | null
	nextPollAt: Date | null
	finalizedAt: Date | null
	retryCount: number | bigint
	attemptsHistoryJson: unknown | null
	operatorNote: string | null
	createdAt: Date
	updatedAt: Date
	createdBy: string
	updatedBy: string
}

function rowToDomain(r: Row): MigrationRegistration {
	return {
		tenantId: r.tenantId,
		id: r.id,
		bookingId: r.bookingId,
		guestId: r.guestId,
		documentId: r.documentId,
		epguChannel: r.epguChannel as EpguChannel,
		epguOrderId: r.epguOrderId,
		epguApplicationNumber: r.epguApplicationNumber,
		serviceCode: r.serviceCode,
		targetCode: r.targetCode,
		supplierGid: r.supplierGid,
		regionCode: r.regionCode,
		// YDB Date → 'YYYY-MM-DD' (toISOString().slice(0,10))
		arrivalDate: r.arrivalDate.toISOString().slice(0, 10),
		departureDate: r.departureDate.toISOString().slice(0, 10),
		statusCode: r.statusCode,
		isFinal: r.isFinal,
		reasonRefuse: r.reasonRefuse,
		errorCategory: r.errorCategory as EpguErrorCategory | null,
		submittedAt: r.submittedAt ? r.submittedAt.toISOString() : null,
		lastPolledAt: r.lastPolledAt ? r.lastPolledAt.toISOString() : null,
		nextPollAt: r.nextPollAt ? r.nextPollAt.toISOString() : null,
		finalizedAt: r.finalizedAt ? r.finalizedAt.toISOString() : null,
		retryCount: Number(r.retryCount),
		attemptsHistoryJson: r.attemptsHistoryJson ?? null,
		operatorNote: r.operatorNote,
		createdAt: r.createdAt.toISOString(),
		updatedAt: r.updatedAt.toISOString(),
		createdBy: r.createdBy,
		updatedBy: r.updatedBy,
	}
}

export interface CreateInput {
	readonly tenantId: string
	readonly id: string
	readonly bookingId: string
	readonly guestId: string
	readonly documentId: string
	readonly epguChannel: EpguChannel
	readonly serviceCode: string
	readonly targetCode: string
	readonly supplierGid: string
	readonly regionCode: string
	readonly arrivalDate: string // YYYY-MM-DD
	readonly departureDate: string
	readonly statusCode: number
	readonly actorId: string
}

export function createMigrationRegistrationRepo(sql: SqlInstance) {
	return {
		/**
		 * Insert new draft row. Throws on PK collision (server-side check).
		 * Каноническое поведение: каждое booking_confirmed создаёт ровно одну
		 * row через CDC consumer (M8.A.5.cdc). Manual operator submit тоже
		 * через эту функцию (UI POST `/migration-registrations`).
		 */
		async create(input: CreateInput): Promise<MigrationRegistration> {
			const now = new Date()
			const nowTs = toTs(now)
			await sql`
				UPSERT INTO migrationRegistration (
					\`tenantId\`, \`id\`, \`bookingId\`, \`guestId\`, \`documentId\`,
					\`epguChannel\`, \`epguOrderId\`, \`epguApplicationNumber\`,
					\`serviceCode\`, \`targetCode\`, \`supplierGid\`, \`regionCode\`,
					\`arrivalDate\`, \`departureDate\`,
					\`statusCode\`, \`isFinal\`, \`reasonRefuse\`, \`errorCategory\`,
					\`submittedAt\`, \`lastPolledAt\`, \`nextPollAt\`, \`finalizedAt\`,
					\`retryCount\`, \`operatorNote\`,
					\`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
				) VALUES (
					${input.tenantId}, ${input.id}, ${input.bookingId},
					${input.guestId}, ${input.documentId},
					${input.epguChannel}, ${NULL_TEXT}, ${NULL_TEXT},
					${input.serviceCode}, ${input.targetCode},
					${input.supplierGid}, ${input.regionCode},
					${dateFromIso(input.arrivalDate)},
					${dateFromIso(input.departureDate)},
					${input.statusCode}, ${false}, ${NULL_TEXT}, ${NULL_TEXT},
					${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TIMESTAMP},
					${0}, ${NULL_TEXT},
					${nowTs}, ${nowTs}, ${input.actorId}, ${input.actorId}
				)
			`
			const got = await this.getById(input.tenantId, input.id)
			if (!got) {
				throw new Error(
					`migrationRegistration.create: row ${input.id} not visible after upsert (tenant ${input.tenantId})`,
				)
			}
			return got
		},

		async getById(tenantId: string, id: string): Promise<MigrationRegistration | null> {
			const [rows = []] = await sql<Row[]>`
				SELECT
					tenantId, id, bookingId, guestId, documentId,
					epguChannel, epguOrderId, epguApplicationNumber,
					serviceCode, targetCode, supplierGid, regionCode,
					arrivalDate, departureDate,
					statusCode, isFinal, reasonRefuse, errorCategory,
					submittedAt, lastPolledAt, nextPollAt, finalizedAt,
					retryCount, attemptsHistoryJson, operatorNote,
					createdAt, updatedAt, createdBy, updatedBy
				FROM migrationRegistration
				WHERE tenantId = ${tenantId} AND id = ${id}
				LIMIT 1
			`.idempotent(true)
			const row = rows[0]
			return row ? rowToDomain(row) : null
		},

		async listByBooking(tenantId: string, bookingId: string): Promise<MigrationRegistration[]> {
			const [rows = []] = await sql<Row[]>`
				SELECT
					tenantId, id, bookingId, guestId, documentId,
					epguChannel, epguOrderId, epguApplicationNumber,
					serviceCode, targetCode, supplierGid, regionCode,
					arrivalDate, departureDate,
					statusCode, isFinal, reasonRefuse, errorCategory,
					submittedAt, lastPolledAt, nextPollAt, finalizedAt,
					retryCount, attemptsHistoryJson, operatorNote,
					createdAt, updatedAt, createdBy, updatedBy
				FROM migrationRegistration
				WHERE tenantId = ${tenantId} AND bookingId = ${bookingId}
				ORDER BY createdAt DESC
			`.idempotent(true)
			return rows.map(rowToDomain)
		},

		async listPendingPoll(now: Date, limit: number): Promise<MigrationRegistration[]> {
			// Pick non-final rows whose nextPollAt is due. Cron polls these.
			// statusCode IN (1,2,5,17,21,22) excludes finals (3,4,10) and draft (0)
			// + drafts are also picked up if nextPollAt becomes due (manual retry).
			//
			// ORDER BY (nextPollAt IS NULL DESC, nextPollAt ASC): FIFO по due-date
			// чтобы honor 24h ЕПГУ deadline (Постановление №1668) — oldest
			// pending получают priority. NULL nextPollAt идёт первым (manual
			// retry case без scheduled re-poll), потом oldest scheduled.
			//
			// YDB doesn't support `NULLS FIRST` syntax — used boolean DESC
			// pattern (true sorts after false in default; DESC inverts to NULLs first).
			// Determinism для test'ов: same query → same order.
			const [rows = []] = await sql<Row[]>`
				SELECT
					tenantId, id, bookingId, guestId, documentId,
					epguChannel, epguOrderId, epguApplicationNumber,
					serviceCode, targetCode, supplierGid, regionCode,
					arrivalDate, departureDate,
					statusCode, isFinal, reasonRefuse, errorCategory,
					submittedAt, lastPolledAt, nextPollAt, finalizedAt,
					retryCount, attemptsHistoryJson, operatorNote,
					createdAt, updatedAt, createdBy, updatedBy
				FROM migrationRegistration
				WHERE isFinal = false
				  AND epguOrderId IS NOT NULL
				  AND (nextPollAt IS NULL OR nextPollAt <= ${now})
				ORDER BY (nextPollAt IS NULL) DESC, nextPollAt ASC
				LIMIT ${limit}
			`.idempotent(true)
			return rows.map(rowToDomain)
		},

		async updateAfterReserve(
			tenantId: string,
			id: string,
			patch: {
				readonly epguOrderId: string
				readonly statusCode: number
				readonly submittedAt: Date
			},
		): Promise<void> {
			const nowTs = toTs(new Date())
			await sql`
				UPDATE migrationRegistration
				SET
					\`epguOrderId\` = ${textOpt(patch.epguOrderId)},
					\`statusCode\` = ${patch.statusCode},
					\`submittedAt\` = ${timestampOpt(patch.submittedAt)},
					\`updatedAt\` = ${nowTs}
				WHERE \`tenantId\` = ${tenantId} AND \`id\` = ${id}
			`
		},

		async updateAfterPoll(
			tenantId: string,
			id: string,
			patch: {
				readonly statusCode: number
				readonly isFinal: boolean
				readonly reasonRefuse: string | null
				readonly errorCategory: EpguErrorCategory | null
				readonly retryCount: number
				readonly lastPolledAt: Date
				readonly nextPollAt: Date | null
				readonly finalizedAt: Date | null
			},
		): Promise<void> {
			const nowTs = toTs(new Date())
			await sql`
				UPDATE migrationRegistration
				SET
					\`statusCode\` = ${patch.statusCode},
					\`isFinal\` = ${patch.isFinal},
					\`reasonRefuse\` = ${textOpt(patch.reasonRefuse)},
					\`errorCategory\` = ${textOpt(patch.errorCategory)},
					\`retryCount\` = ${patch.retryCount},
					\`lastPolledAt\` = ${timestampOpt(patch.lastPolledAt)},
					\`nextPollAt\` = ${timestampOpt(patch.nextPollAt)},
					\`finalizedAt\` = ${timestampOpt(patch.finalizedAt)},
					\`updatedAt\` = ${nowTs}
				WHERE \`tenantId\` = ${tenantId} AND \`id\` = ${id}
			`
		},

		/**
		 * Operator-facing patch — only fields exposed through the PATCH UI route.
		 * Three-state semantics per nullable column:
		 *   - undefined ⇒ no change (preserve current value)
		 *   - null ⇒ clear (allowed только для nullable columns)
		 *   - value ⇒ overwrite
		 *
		 * Implementation: full-row UPSERT (per YDB gotcha #14 «full-row UPSERT
		 * для many-nullable tables»). Read current row → apply three-state
		 * patch semantics → UPSERT all columns. Avoids combinatorial branch
		 * explosion (3 fields × 3 states = 27 SET combinations) и keeps
		 * UPSERT idempotent под YDB semantics.
		 *
		 * FSM-controlled columns (statusCode, isFinal, reasonRefuse, finalizedAt,
		 * lastPolledAt, errorCategory, submittedAt, epguOrderId, ...) НЕ в patch
		 * surface — they advance via updateAfterReserve / updateAfterPoll /
		 * cancel pathways, keeping FSM transitions auditable. Generic patch
		 * предназначен для operator-side mutations: retry retryCount + nextPollAt
		 * + operatorNote.
		 */
		async patch(
			tenantId: string,
			id: string,
			patch: {
				readonly retryCount?: number
				readonly nextPollAt?: Date | null
				readonly operatorNote?: string | null
			},
			actorId: string,
		): Promise<MigrationRegistration | null> {
			const allUndefined =
				patch.retryCount === undefined &&
				patch.nextPollAt === undefined &&
				patch.operatorNote === undefined
			if (allUndefined) {
				return this.getById(tenantId, id)
			}
			const current = await this.getById(tenantId, id)
			if (!current) return null

			// Apply three-state semantics per field.
			const nextRetryCount = patch.retryCount ?? current.retryCount
			const nextNextPollAt =
				patch.nextPollAt === undefined
					? current.nextPollAt
						? new Date(current.nextPollAt)
						: null
					: patch.nextPollAt
			const nextOperatorNote =
				patch.operatorNote === undefined ? current.operatorNote : patch.operatorNote

			const now = new Date()
			const nowTs = toTs(now)

			// Full-row UPSERT — preserve все non-patched fields verbatim.
			await sql`
				UPSERT INTO migrationRegistration (
					\`tenantId\`, \`id\`, \`bookingId\`, \`guestId\`, \`documentId\`,
					\`epguChannel\`, \`epguOrderId\`, \`epguApplicationNumber\`,
					\`serviceCode\`, \`targetCode\`, \`supplierGid\`, \`regionCode\`,
					\`arrivalDate\`, \`departureDate\`,
					\`statusCode\`, \`isFinal\`, \`reasonRefuse\`, \`errorCategory\`,
					\`submittedAt\`, \`lastPolledAt\`, \`nextPollAt\`, \`finalizedAt\`,
					\`retryCount\`, \`attemptsHistoryJson\`, \`operatorNote\`,
					\`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
				) VALUES (
					${current.tenantId}, ${current.id}, ${current.bookingId},
					${current.guestId}, ${current.documentId},
					${current.epguChannel},
					${textOpt(current.epguOrderId)},
					${textOpt(current.epguApplicationNumber)},
					${current.serviceCode}, ${current.targetCode},
					${current.supplierGid}, ${current.regionCode},
					${dateFromIso(current.arrivalDate)},
					${dateFromIso(current.departureDate)},
					${current.statusCode}, ${current.isFinal},
					${textOpt(current.reasonRefuse)},
					${textOpt(current.errorCategory)},
					${timestampOpt(current.submittedAt ? new Date(current.submittedAt) : null)},
					${timestampOpt(current.lastPolledAt ? new Date(current.lastPolledAt) : null)},
					${timestampOpt(nextNextPollAt)},
					${timestampOpt(current.finalizedAt ? new Date(current.finalizedAt) : null)},
					${nextRetryCount},
					${toJson(current.attemptsHistoryJson)},
					${textOpt(nextOperatorNote)},
					${toTs(new Date(current.createdAt))},
					${nowTs},
					${current.createdBy}, ${actorId}
				)
			`
			return this.getById(tenantId, id)
		},
	}
}
