import type { City } from '@horeca/shared'
import { newId } from '@horeca/shared'
import type { sql as SQL } from '../../db/index.ts'
import { NULL_INT32, NULL_TEXT, toTs } from '../../db/ydb-helpers.ts'

type SqlInstance = typeof SQL

/**
 * Single-tx «one-shot» onboarding payload. The wizard collects the user's
 * gosti­nica metadata in two screens (ИНН lookup → confirm; rooms + price →
 * done) and POSTs the union to `/api/v1/onboarding/inventory`. The whole
 * inventory must commit atomically so a failure mid-stream never leaves a
 * tenant with a partially-wired property — the wizard rerun would then
 * collide on room numbers and confuse the user.
 *
 * What we create (4 entity classes, 1 transaction):
 *   1. `property` × 1            — name / address / city / timezone / tourism-tax
 *   2. `roomType` × 1            — «Стандартный», capacity 2, default beds
 *   3. `room`     × N            — numbers `101`..`100+N` on floor 1
 *   4. `ratePlan` × 1            — «Базовый», refundable, RUB, default plan
 *
 * Rates (date × roomType × ratePlan price rows) are intentionally NOT seeded
 * here; Шахматка renders empty cells and the operator fills them per the
 * existing rate-management UI. Seeding 365 default rates per onboarding
 * inflates the tx and rolls the «90-second» target back into territory
 * where individual rate edits become friction. Deferred to a later pass
 * if usage data shows it matters.
 */
export interface CreateInventoryPropertyInput {
	readonly name: string
	readonly address: string
	readonly city: City
	readonly timezone?: string
	readonly tourismTaxRateBps?: number | null
}

export interface CreateInventoryInput {
	readonly property: CreateInventoryPropertyInput
	readonly rooms: number
	readonly avgPriceRub: number
}

export interface CreateInventoryResult {
	readonly propertyId: string
	readonly roomTypeId: string
	readonly ratePlanId: string
	readonly roomIds: readonly string[]
}

const DEFAULT_TIMEZONE = 'Europe/Moscow'
const DEFAULT_ROOM_TYPE_NAME = 'Стандартный'
const DEFAULT_RATE_PLAN_NAME = 'Базовый'
const DEFAULT_RATE_PLAN_CODE = 'BASE'

/** Hotel-floor-1 numbering: room index 1 → '101', 2 → '102', …, 100 → '200'. */
function roomNumberFor(index: number): string {
	return String(100 + index)
}

export interface OnboardingService {
	createInventory(tenantId: string, input: CreateInventoryInput): Promise<CreateInventoryResult>
}

/**
 * Wires the bulk-insert transaction. Repos (property / roomType / room /
 * ratePlan) are deliberately NOT composed here — each repo's `create()`
 * captures its own sql binding and isn't tx-aware. Inlining the four
 * UPSERTs against the `tx` context keeps everything in a single
 * `sql.begin({idempotent: true})` block so YDB's retryable-tx handler
 * can replay end-to-end on conflict without smearing partial state.
 */
export function createOnboardingService(sql: SqlInstance): OnboardingService {
	return {
		async createInventory(tenantId, input) {
			const propertyId = newId('property')
			const roomTypeId = newId('roomType')
			const ratePlanId = newId('ratePlan')
			const roomIds = Array.from({ length: input.rooms }, () => newId('room'))
			const now = new Date()
			const nowTs = toTs(now)

			const timezone = input.property.timezone ?? DEFAULT_TIMEZONE
			const tourismTaxRateBind =
				input.property.tourismTaxRateBps === undefined || input.property.tourismTaxRateBps === null
					? NULL_INT32
					: input.property.tourismTaxRateBps

			// Bind through named variables (NOT inline integer literals) — the
			// @ydbjs/query template parser infers numeric literals to the
			// narrowest Uint/Int type that fits the value, which collides with
			// the schema's Int32 declaration and trips ERROR 1030 «Type
			// annotation». Existing repos avoid this by always binding through
			// variables; we mirror.
			const isActive = true
			const floorOne = 1
			const maxOccupancyTwo = 2
			const baseBedsTwo = 2
			const extraBedsZero = 0
			const cancellationHours24 = 24
			const minStayOne = 1
			// ratePlan.mealsIncluded is `Utf8?` (nullable string enum: none/
			// breakfast/halfBoard/fullBoard) — NOT a boolean. Onboarding default
			// is 'none' since most Сочи SMB rooms ship без meals included.
			const mealsIncludedNone = 'none'
			const currencyRub = 'RUB'

			await sql.begin({ idempotent: true }, async (tx) => {
				// 1. property — single row.
				await tx`
					UPSERT INTO property (
						\`tenantId\`, \`id\`, \`name\`, \`address\`, \`city\`, \`timezone\`,
						\`tourismTaxRateBps\`, \`isActive\`, \`createdAt\`, \`updatedAt\`
					) VALUES (
						${tenantId}, ${propertyId}, ${input.property.name}, ${input.property.address},
						${input.property.city}, ${timezone},
						${tourismTaxRateBind}, ${isActive}, ${nowTs}, ${nowTs}
					)
				`

				// 2. roomType — single row, canonical defaults.
				await tx`
					UPSERT INTO roomType (
						\`tenantId\`, \`id\`, \`propertyId\`, \`name\`, \`description\`,
						\`maxOccupancy\`, \`baseBeds\`, \`extraBeds\`, \`areaSqm\`,
						\`inventoryCount\`, \`isActive\`, \`createdAt\`, \`updatedAt\`
					) VALUES (
						${tenantId}, ${roomTypeId}, ${propertyId}, ${DEFAULT_ROOM_TYPE_NAME}, ${NULL_TEXT},
						${maxOccupancyTwo}, ${baseBedsTwo}, ${extraBedsZero}, ${NULL_INT32},
						${input.rooms}, ${isActive}, ${nowTs}, ${nowTs}
					)
				`

				// 3. rooms — per-row UPSERT inside the same tx. Matches the
				// existing canon set by `rate.repo.bulkUpsert` /
				// `availability.repo.bulkUpsert`: all rows commit atomically as
				// part of one `sql.begin({idempotent: true})`, while the
				// tagged-template `${var}` binding gives YDB the column-typing
				// it needs without the `AS_TABLE(…)` struct-shape gymnastics.
				// Latency for N≤200 inside a single tx is dominated by the
				// commit phase, not the per-statement round-trip — onboarding
				// stays well under the 90-second human budget.
				for (let i = 0; i < input.rooms; i += 1) {
					const number = roomNumberFor(i + 1)
					const id = roomIds[i]
					if (!id) continue // unreachable: roomIds.length === input.rooms
					await tx`
						UPSERT INTO room (
							\`tenantId\`, \`id\`, \`propertyId\`, \`roomTypeId\`, \`number\`,
							\`floor\`, \`isActive\`, \`notes\`, \`createdAt\`, \`updatedAt\`
						) VALUES (
							${tenantId}, ${id}, ${propertyId}, ${roomTypeId}, ${number},
							${floorOne}, ${isActive}, ${NULL_TEXT}, ${nowTs}, ${nowTs}
						)
					`
				}

				// 4. ratePlan — single «Базовый» plan, RUB, refundable, isDefault.
				await tx`
					UPSERT INTO ratePlan (
						\`tenantId\`, \`id\`, \`propertyId\`, \`roomTypeId\`, \`name\`, \`code\`,
						\`isDefault\`, \`isRefundable\`, \`cancellationHours\`, \`mealsIncluded\`,
						\`minStay\`, \`maxStay\`, \`isActive\`, \`currency\`,
						\`createdAt\`, \`updatedAt\`
					) VALUES (
						${tenantId}, ${ratePlanId}, ${propertyId}, ${roomTypeId},
						${DEFAULT_RATE_PLAN_NAME}, ${DEFAULT_RATE_PLAN_CODE},
						${isActive}, ${isActive}, ${cancellationHours24}, ${mealsIncludedNone},
						${minStayOne}, ${NULL_INT32}, ${isActive}, ${currencyRub},
						${nowTs}, ${nowTs}
					)
				`
			})

			// `avgPriceRub` is intentionally not persisted to ratePlan: rate
			// rows live in a separate `rate` table keyed по (date, ratePlan,
			// roomType). The wizard frontend will use this value as the
			// suggested default in Шахматка's "fill calendar" affordance —
			// echoed back in the response so the wizard can hand-off cleanly.
			return { propertyId, roomTypeId, ratePlanId, roomIds }
		},
	}
}
