import type {
	MealsIncluded,
	RatePlan,
	RatePlanCreateInput,
	RatePlanUpdateInput,
} from '@horeca/shared'
import { newId } from '@horeca/shared'
import type { sql as SQL } from '../../db/index.ts'
import { NULL_INT32, NULL_TEXT, toNumber, toTs, tsFromIso } from '../../db/ydb-helpers.ts'
import { RatePlanCodeTakenError } from '../../errors/domain.ts'

type SqlInstance = typeof SQL

type RatePlanRow = {
	tenantId: string
	id: string
	propertyId: string
	roomTypeId: string
	name: string
	code: string
	isDefault: boolean
	isRefundable: boolean
	cancellationHours: number | bigint | null
	mealsIncluded: string | null
	minStay: number | bigint
	maxStay: number | bigint | null
	isActive: boolean
	currency: string
	createdAt: Date
	updatedAt: Date
}

function rowToRatePlan(r: RatePlanRow): RatePlan {
	return {
		id: r.id,
		tenantId: r.tenantId,
		propertyId: r.propertyId,
		roomTypeId: r.roomTypeId,
		name: r.name,
		code: r.code,
		isDefault: r.isDefault,
		isRefundable: r.isRefundable,
		cancellationHours: toNumber(r.cancellationHours),
		mealsIncluded: (r.mealsIncluded ?? 'none') as MealsIncluded,
		minStay: Number(r.minStay),
		maxStay: toNumber(r.maxStay),
		isActive: r.isActive,
		currency: r.currency,
		createdAt: r.createdAt.toISOString(),
		updatedAt: r.updatedAt.toISOString(),
	}
}

/**
 * RatePlan repository. Tenant-scoped reads. Writes include `propertyId` which
 * the service layer resolves from the parent roomType (single source of truth).
 *
 * Uniqueness of `(tenantId, propertyId, code)` is enforced at application level
 * inside `sql.begin()` — YDB does not allow adding UNIQUE indexes to existing
 * tables (see `project_ydb_specifics.md` #12). Serializable isolation (YDB
 * default) makes the SELECT-then-UPSERT pattern race-safe.
 */
export function createRatePlanRepo(sql: SqlInstance) {
	return {
		async listByProperty(
			tenantId: string,
			propertyId: string,
			opts: { includeInactive: boolean; roomTypeId?: string },
		) {
			if (opts.roomTypeId) {
				const [rows = []] = opts.includeInactive
					? await sql<RatePlanRow[]>`
							SELECT * FROM ratePlan
							WHERE tenantId = ${tenantId}
								AND propertyId = ${propertyId}
								AND roomTypeId = ${opts.roomTypeId}
						`
							.isolation('snapshotReadOnly')
							.idempotent(true)
					: await sql<RatePlanRow[]>`
							SELECT * FROM ratePlan
							WHERE tenantId = ${tenantId}
								AND propertyId = ${propertyId}
								AND roomTypeId = ${opts.roomTypeId}
								AND isActive = ${true}
						`
							.isolation('snapshotReadOnly')
							.idempotent(true)
				return rows.map(rowToRatePlan)
			}
			const [rows = []] = opts.includeInactive
				? await sql<RatePlanRow[]>`
						SELECT * FROM ratePlan
						WHERE tenantId = ${tenantId} AND propertyId = ${propertyId}
					`
						.isolation('snapshotReadOnly')
						.idempotent(true)
				: await sql<RatePlanRow[]>`
						SELECT * FROM ratePlan
						WHERE tenantId = ${tenantId} AND propertyId = ${propertyId} AND isActive = ${true}
					`
						.isolation('snapshotReadOnly')
						.idempotent(true)
			return rows.map(rowToRatePlan)
		},

		async getById(tenantId: string, id: string): Promise<RatePlan | null> {
			const [rows = []] = await sql<RatePlanRow[]>`
				SELECT * FROM ratePlan
				WHERE tenantId = ${tenantId} AND id = ${id}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			return row ? rowToRatePlan(row) : null
		},

		async create(
			tenantId: string,
			propertyId: string,
			roomTypeId: string,
			input: RatePlanCreateInput,
		): Promise<RatePlan> {
			const id = newId('ratePlan')
			const now = new Date()
			const nowTs = toTs(now)

			try {
				return await sql.begin(async (tx) => {
					// App-level uniqueness check: see class docstring + project_ydb_specifics #12.
					const [collision = []] = await tx<{ id: string }[]>`
						SELECT id FROM ratePlan
						WHERE tenantId = ${tenantId} AND propertyId = ${propertyId} AND code = ${input.code}
						LIMIT 1
					`
					if (collision[0]) throw new RatePlanCodeTakenError(input.code)

					const cancellationHours = input.cancellationHours ?? NULL_INT32
					const maxStay = input.maxStay ?? NULL_INT32
					const mealsIncluded = input.mealsIncluded ?? 'none'
					const isDefault = input.isDefault ?? false
					const isRefundable = input.isRefundable ?? true
					const minStay = input.minStay ?? 1
					const currency = input.currency ?? 'RUB'

					await tx`
						UPSERT INTO ratePlan (
							\`tenantId\`, \`id\`, \`propertyId\`, \`roomTypeId\`, \`name\`, \`code\`,
							\`isDefault\`, \`isRefundable\`, \`cancellationHours\`, \`mealsIncluded\`,
							\`minStay\`, \`maxStay\`, \`isActive\`, \`currency\`,
							\`createdAt\`, \`updatedAt\`
						) VALUES (
							${tenantId}, ${id}, ${propertyId}, ${roomTypeId}, ${input.name}, ${input.code},
							${isDefault}, ${isRefundable}, ${cancellationHours}, ${mealsIncluded},
							${minStay}, ${maxStay}, ${true}, ${currency},
							${nowTs}, ${nowTs}
						)
					`
					return {
						id,
						tenantId,
						propertyId,
						roomTypeId,
						name: input.name,
						code: input.code,
						isDefault,
						isRefundable,
						cancellationHours: input.cancellationHours ?? null,
						mealsIncluded,
						minStay,
						maxStay: input.maxStay ?? null,
						isActive: true,
						currency,
						createdAt: now.toISOString(),
						updatedAt: now.toISOString(),
					}
				})
			} catch (err) {
				// sql.begin wraps non-retryable throws in `Error("Transaction failed.", { cause })`.
				// See project_ydb_specifics #11.
				if (err instanceof Error && err.cause instanceof RatePlanCodeTakenError) throw err.cause
				throw err
			}
		},

		async update(
			tenantId: string,
			id: string,
			patch: RatePlanUpdateInput,
		): Promise<RatePlan | null> {
			try {
				return await sql.begin(async (tx) => {
					const [rows = []] = await tx<RatePlanRow[]>`
						SELECT * FROM ratePlan
						WHERE tenantId = ${tenantId} AND id = ${id}
						LIMIT 1
					`
					const row = rows[0]
					if (!row) return null
					const current = rowToRatePlan(row)

					// Nullable-field patch rule: `undefined` = no change, `null` = clear.
					const nextCancellationHours: number | null =
						'cancellationHours' in patch && patch.cancellationHours !== undefined
							? patch.cancellationHours
							: current.cancellationHours
					const nextMaxStay: number | null =
						'maxStay' in patch && patch.maxStay !== undefined ? patch.maxStay : current.maxStay
					const nextCode = patch.code ?? current.code

					// Code changed → re-check uniqueness in the same tx.
					if (nextCode !== current.code) {
						const [collision = []] = await tx<{ id: string }[]>`
							SELECT id FROM ratePlan
							WHERE tenantId = ${tenantId}
								AND propertyId = ${current.propertyId}
								AND code = ${nextCode}
								AND id != ${id}
							LIMIT 1
						`
						if (collision[0]) throw new RatePlanCodeTakenError(nextCode)
					}

					const merged: RatePlan = {
						...current,
						name: patch.name ?? current.name,
						code: nextCode,
						isDefault: patch.isDefault ?? current.isDefault,
						isRefundable: patch.isRefundable ?? current.isRefundable,
						cancellationHours: nextCancellationHours,
						mealsIncluded: patch.mealsIncluded ?? current.mealsIncluded,
						minStay: patch.minStay ?? current.minStay,
						maxStay: nextMaxStay,
						currency: patch.currency ?? current.currency,
						isActive: patch.isActive ?? current.isActive,
						updatedAt: new Date().toISOString(),
					}
					const cancellationHours = merged.cancellationHours ?? NULL_INT32
					const maxStay = merged.maxStay ?? NULL_INT32
					const mealsIncluded = merged.mealsIncluded ?? NULL_TEXT
					const createdAtTs = tsFromIso(merged.createdAt)
					const updatedAtTs = tsFromIso(merged.updatedAt)

					await tx`
						UPSERT INTO ratePlan (
							\`tenantId\`, \`id\`, \`propertyId\`, \`roomTypeId\`, \`name\`, \`code\`,
							\`isDefault\`, \`isRefundable\`, \`cancellationHours\`, \`mealsIncluded\`,
							\`minStay\`, \`maxStay\`, \`isActive\`, \`currency\`,
							\`createdAt\`, \`updatedAt\`
						) VALUES (
							${tenantId}, ${id}, ${merged.propertyId}, ${merged.roomTypeId}, ${merged.name}, ${merged.code},
							${merged.isDefault}, ${merged.isRefundable}, ${cancellationHours}, ${mealsIncluded},
							${merged.minStay}, ${maxStay}, ${merged.isActive}, ${merged.currency},
							${createdAtTs}, ${updatedAtTs}
						)
					`
					return merged
				})
			} catch (err) {
				if (err instanceof Error && err.cause instanceof RatePlanCodeTakenError) throw err.cause
				throw err
			}
		},

		async delete(tenantId: string, id: string): Promise<boolean> {
			const current = await this.getById(tenantId, id)
			if (!current) return false
			await sql`
				DELETE FROM ratePlan
				WHERE tenantId = ${tenantId} AND id = ${id}
			`
			return true
		},
	}
}

export type RatePlanRepo = ReturnType<typeof createRatePlanRepo>
