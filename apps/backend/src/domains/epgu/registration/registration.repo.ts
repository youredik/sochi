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
					\`retryCount\`,
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
					${0},
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
					retryCount, attemptsHistoryJson,
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
					retryCount, attemptsHistoryJson,
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
			const [rows = []] = await sql<Row[]>`
				SELECT
					tenantId, id, bookingId, guestId, documentId,
					epguChannel, epguOrderId, epguApplicationNumber,
					serviceCode, targetCode, supplierGid, regionCode,
					arrivalDate, departureDate,
					statusCode, isFinal, reasonRefuse, errorCategory,
					submittedAt, lastPolledAt, nextPollAt, finalizedAt,
					retryCount, attemptsHistoryJson,
					createdAt, updatedAt, createdBy, updatedBy
				FROM migrationRegistration
				WHERE isFinal = false
				  AND epguOrderId IS NOT NULL
				  AND (nextPollAt IS NULL OR nextPollAt <= ${now})
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
		 * Patch input fields exposed via Hono PATCH route. Three-state semantics:
		 *   - undefined ⇒ no change
		 *   - null ⇒ clear (e.g. operator clears note)
		 * Distinguished from updateAfterReserve/Poll which are cron-internal
		 * field-precise updates.
		 */
		async patch(
			tenantId: string,
			id: string,
			patch: {
				readonly retryCount?: number
				readonly nextPollAt?: Date | null
				readonly statusCode?: number
				readonly isFinal?: boolean
				readonly reasonRefuse?: string | null
				readonly finalizedAt?: Date | null
			},
			actorId: string,
		): Promise<MigrationRegistration | null> {
			const nowTs = toTs(new Date())
			const sets: string[] = []
			const values: Array<unknown> = []
			if (patch.retryCount !== undefined) {
				sets.push('retryCount')
				values.push(patch.retryCount)
			}
			if (patch.nextPollAt !== undefined) {
				sets.push('nextPollAt')
				values.push(patch.nextPollAt)
			}
			if (patch.statusCode !== undefined) {
				sets.push('statusCode')
				values.push(patch.statusCode)
			}
			if (patch.isFinal !== undefined) {
				sets.push('isFinal')
				values.push(patch.isFinal)
			}
			if (patch.reasonRefuse !== undefined) {
				sets.push('reasonRefuse')
				values.push(patch.reasonRefuse)
			}
			if (patch.finalizedAt !== undefined) {
				sets.push('finalizedAt')
				values.push(patch.finalizedAt)
			}
			if (sets.length === 0) {
				return this.getById(tenantId, id)
			}
			// Two-field branches cover the operator UI surface (retry +
			// nextPollAt). Other fields (statusCode/isFinal/reasonRefuse/
			// finalizedAt) are mutated via dedicated cron paths
			// (updateAfterReserve / updateAfterPoll) rather than through
			// generic patch — keeps FSM transitions auditable.
			if (patch.retryCount !== undefined && patch.nextPollAt !== undefined) {
				await sql`
					UPDATE migrationRegistration
					SET \`retryCount\` = ${patch.retryCount},
					    \`nextPollAt\` = ${timestampOpt(patch.nextPollAt)},
					    \`updatedAt\` = ${nowTs},
					    \`updatedBy\` = ${actorId}
					WHERE \`tenantId\` = ${tenantId} AND \`id\` = ${id}
				`
			} else if (patch.retryCount !== undefined) {
				await sql`
					UPDATE migrationRegistration
					SET \`retryCount\` = ${patch.retryCount},
					    \`updatedAt\` = ${nowTs},
					    \`updatedBy\` = ${actorId}
					WHERE \`tenantId\` = ${tenantId} AND \`id\` = ${id}
				`
			} else if (patch.nextPollAt !== undefined) {
				await sql`
					UPDATE migrationRegistration
					SET \`nextPollAt\` = ${timestampOpt(patch.nextPollAt)},
					    \`updatedAt\` = ${nowTs},
					    \`updatedBy\` = ${actorId}
					WHERE \`tenantId\` = ${tenantId} AND \`id\` = ${id}
				`
			}
			return this.getById(tenantId, id)
		},
	}
}
