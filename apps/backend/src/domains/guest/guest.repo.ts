import type { Guest, GuestCreateInput, GuestUpdateInput } from '@horeca/shared'
import { newId } from '@horeca/shared'
import type { sql as SQL } from '../../db/index.ts'
import { dateOpt, NULL_TEXT, toTs, tsFromIso } from '../../db/ydb-helpers.ts'

type SqlInstance = typeof SQL

type GuestRow = {
	tenantId: string
	id: string
	lastName: string
	firstName: string
	middleName: string | null
	birthDate: Date | null
	citizenship: string
	documentType: string
	documentSeries: string | null
	documentNumber: string
	documentIssuedBy: string | null
	documentIssuedDate: Date | null
	registrationAddress: string | null
	phone: string | null
	email: string | null
	notes: string | null
	visaNumber: string | null
	visaType: string | null
	visaExpiresAt: Date | null
	migrationCardNumber: string | null
	arrivalDate: Date | null
	stayUntil: Date | null
	createdAt: Date
	updatedAt: Date
}

const dateToYmd = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null)

function rowToGuest(r: GuestRow): Guest {
	return {
		id: r.id,
		tenantId: r.tenantId,
		lastName: r.lastName,
		firstName: r.firstName,
		middleName: r.middleName,
		birthDate: dateToYmd(r.birthDate),
		citizenship: r.citizenship,
		documentType: r.documentType,
		documentSeries: r.documentSeries,
		documentNumber: r.documentNumber,
		documentIssuedBy: r.documentIssuedBy,
		documentIssuedDate: dateToYmd(r.documentIssuedDate),
		registrationAddress: r.registrationAddress,
		phone: r.phone,
		email: r.email,
		notes: r.notes,
		visaNumber: r.visaNumber,
		visaType: r.visaType,
		visaExpiresAt: dateToYmd(r.visaExpiresAt),
		migrationCardNumber: r.migrationCardNumber,
		arrivalDate: dateToYmd(r.arrivalDate),
		stayUntil: dateToYmd(r.stayUntil),
		createdAt: r.createdAt.toISOString(),
		updatedAt: r.updatedAt.toISOString(),
	}
}

/**
 * Guest repository. All CRUD tenant-scoped; `tenantId` is the first PK
 * column. Writes use full-row UPSERT (per YDB gotcha #14 — UPDATE on mixed
 * NOT NULL + nullable columns fails the server-side type inference).
 */
export function createGuestRepo(sql: SqlInstance) {
	return {
		async list(tenantId: string): Promise<Guest[]> {
			const [rows = []] = await sql<GuestRow[]>`
				SELECT * FROM guest
				WHERE tenantId = ${tenantId}
				ORDER BY lastName ASC, firstName ASC, id ASC
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.map(rowToGuest)
		},

		async getById(tenantId: string, id: string): Promise<Guest | null> {
			const [rows = []] = await sql<GuestRow[]>`
				SELECT * FROM guest
				WHERE tenantId = ${tenantId} AND id = ${id}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			return row ? rowToGuest(row) : null
		},

		async create(tenantId: string, input: GuestCreateInput): Promise<Guest> {
			const id = newId('guest')
			const now = new Date()
			const nowTs = toTs(now)
			const merged: Guest = {
				id,
				tenantId,
				lastName: input.lastName,
				firstName: input.firstName,
				middleName: input.middleName ?? null,
				birthDate: input.birthDate ?? null,
				citizenship: input.citizenship,
				documentType: input.documentType,
				documentSeries: input.documentSeries ?? null,
				documentNumber: input.documentNumber,
				documentIssuedBy: input.documentIssuedBy ?? null,
				documentIssuedDate: input.documentIssuedDate ?? null,
				registrationAddress: input.registrationAddress ?? null,
				phone: input.phone ?? null,
				email: input.email ?? null,
				notes: input.notes ?? null,
				visaNumber: input.visaNumber ?? null,
				visaType: input.visaType ?? null,
				visaExpiresAt: input.visaExpiresAt ?? null,
				migrationCardNumber: input.migrationCardNumber ?? null,
				arrivalDate: input.arrivalDate ?? null,
				stayUntil: input.stayUntil ?? null,
				createdAt: now.toISOString(),
				updatedAt: now.toISOString(),
			}
			await upsertGuest(sql, merged, nowTs, nowTs)
			return merged
		},

		async update(tenantId: string, id: string, patch: GuestUpdateInput): Promise<Guest | null> {
			return sql.begin(async (tx) => {
				const [rows = []] = await tx<GuestRow[]>`
					SELECT * FROM guest
					WHERE tenantId = ${tenantId} AND id = ${id}
					LIMIT 1
				`
				const row = rows[0]
				if (!row) return null
				const current = rowToGuest(row)

				const pick = <K extends keyof GuestUpdateInput>(key: K, fallback: Guest[K]): Guest[K] =>
					key in patch && patch[key] !== undefined ? (patch[key] as Guest[K]) : fallback

				const merged: Guest = {
					...current,
					lastName: patch.lastName ?? current.lastName,
					firstName: patch.firstName ?? current.firstName,
					middleName: pick('middleName', current.middleName),
					birthDate: pick('birthDate', current.birthDate),
					citizenship: patch.citizenship ?? current.citizenship,
					documentType: patch.documentType ?? current.documentType,
					documentSeries: pick('documentSeries', current.documentSeries),
					documentNumber: patch.documentNumber ?? current.documentNumber,
					documentIssuedBy: pick('documentIssuedBy', current.documentIssuedBy),
					documentIssuedDate: pick('documentIssuedDate', current.documentIssuedDate),
					registrationAddress: pick('registrationAddress', current.registrationAddress),
					phone: pick('phone', current.phone),
					email: pick('email', current.email),
					notes: pick('notes', current.notes),
					visaNumber: pick('visaNumber', current.visaNumber),
					visaType: pick('visaType', current.visaType),
					visaExpiresAt: pick('visaExpiresAt', current.visaExpiresAt),
					migrationCardNumber: pick('migrationCardNumber', current.migrationCardNumber),
					arrivalDate: pick('arrivalDate', current.arrivalDate),
					stayUntil: pick('stayUntil', current.stayUntil),
					updatedAt: new Date().toISOString(),
				}

				await upsertGuest(
					tx as unknown as SqlInstance,
					merged,
					tsFromIso(merged.createdAt),
					tsFromIso(merged.updatedAt),
				)
				return merged
			})
		},

		async delete(tenantId: string, id: string): Promise<boolean> {
			const current = await this.getById(tenantId, id)
			if (!current) return false
			await sql`
				DELETE FROM guest
				WHERE tenantId = ${tenantId} AND id = ${id}
			`
			return true
		},
	}
}

export type GuestRepo = ReturnType<typeof createGuestRepo>

/**
 * Full-row UPSERT shared by `create` and `update`. Extracted so there's a
 * single source of truth for column binding (M4b-2 lesson — duplicated
 * 40-line UPSERT blocks = maintenance hazard).
 */
async function upsertGuest(
	sql: SqlInstance,
	g: Guest,
	createdAtTs: ReturnType<typeof toTs>,
	updatedAtTs: ReturnType<typeof toTs>,
): Promise<void> {
	await sql`
		UPSERT INTO guest (
			\`tenantId\`, \`id\`, \`lastName\`, \`firstName\`, \`middleName\`,
			\`birthDate\`, \`citizenship\`,
			\`documentType\`, \`documentSeries\`, \`documentNumber\`,
			\`documentIssuedBy\`, \`documentIssuedDate\`,
			\`registrationAddress\`, \`phone\`, \`email\`, \`notes\`,
			\`visaNumber\`, \`visaType\`, \`visaExpiresAt\`,
			\`migrationCardNumber\`, \`arrivalDate\`, \`stayUntil\`,
			\`createdAt\`, \`updatedAt\`
		) VALUES (
			${g.tenantId}, ${g.id}, ${g.lastName}, ${g.firstName}, ${g.middleName ?? NULL_TEXT},
			${dateOpt(g.birthDate)}, ${g.citizenship},
			${g.documentType}, ${g.documentSeries ?? NULL_TEXT}, ${g.documentNumber},
			${g.documentIssuedBy ?? NULL_TEXT}, ${dateOpt(g.documentIssuedDate)},
			${g.registrationAddress ?? NULL_TEXT}, ${g.phone ?? NULL_TEXT},
			${g.email ?? NULL_TEXT}, ${g.notes ?? NULL_TEXT},
			${g.visaNumber ?? NULL_TEXT}, ${g.visaType ?? NULL_TEXT},
			${dateOpt(g.visaExpiresAt)},
			${g.migrationCardNumber ?? NULL_TEXT},
			${dateOpt(g.arrivalDate)}, ${dateOpt(g.stayUntil)},
			${createdAtTs}, ${updatedAtTs}
		)
	`
}
