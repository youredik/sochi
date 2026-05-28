import type { City } from '@horeca/shared'
import { newId } from '@horeca/shared'
import type { sql as SQL } from '../../db/index.ts'
import { dateFromIso, NULL_INT32, NULL_TEXT, toTs } from '../../db/ydb-helpers.ts'

type SqlInstance = typeof SQL

/**
 * Single-tx «one-shot» onboarding payload. The wizard collects the user's
 * gosti­nica metadata in two screens (ИНН lookup → confirm; rooms + price →
 * done) and POSTs the union to `/api/v1/onboarding/inventory`. The whole
 * inventory must commit atomically so a failure mid-stream never leaves a
 * tenant with a partially-wired property — the wizard rerun would then
 * collide on room numbers and confuse the user.
 *
 * What we create (6 entity classes, 1 transaction):
 *   1. `property`    × 1                  — name / address / city / timezone / tourism-tax
 *   2. `roomType`    × 1                  — «Стандартный», capacity 2, default beds
 *   3. `room`        × N                  — numbers `101`..`100+N` on floor 1
 *   4. `ratePlan`    × 1                  — «Базовый», refundable, RUB, default plan
 *   5. `rate`        × `RATE_SEED_DAYS`   — per-night price rows, today..+N-1, at
 *      `avgPriceRub`. Empty rate = unsellable inventory.
 *   6. `availability` × `RATE_SEED_DAYS`  — per-night allotment rows, today..+N-1,
 *      `allotment = input.rooms`, `sold=0`, no stop-sell / min-stay /
 *      closed-to-arrival/departure constraints. Caught real-bug-hunt
 *      2026-05-15: previously omitted → `booking.create` 409 NO_INVENTORY
 *      «no availability row for {date}» from the FIRST booking attempt
 *      post-wizard. Tests passed pre-Phase-16 closure (`8436dd7`) because
 *      shared/demo tenant had seed-demo-tenant.ts coverage; per-worker
 *      isolated tenants exposed the gap. Seeded NOW so Шахматка is
 *      bookable end-to-end immediately. Operator can edit via existing
 *      `POST /properties/:id/availability` admin endpoint.
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

/**
 * Days of price-row seeding window starting today (inclusive). 90 ≈ 3 months
 * — long enough to cover the usual booking-far-ahead horizon for Сочи SMB
 * (typical demand peaks 60-90 days out for summer), short enough to keep
 * the onboarding tx well under the 90-second human budget (90 rows × ratePlan
 * × roomType = 90 UPSERTs ≈ 1-2 s on local YDB).
 */
const RATE_SEED_DAYS = 90

/** ISO YYYY-MM-DD string for `today + offset` days (UTC anchor). */
function isoDateOffset(offset: number): string {
	const d = new Date()
	d.setUTCHours(0, 0, 0, 0)
	d.setUTCDate(d.getUTCDate() + offset)
	return d.toISOString().slice(0, 10)
}

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

				// 5. rate × RATE_SEED_DAYS — flat `avgPriceRub` for today..+(N-1).
				// Per-row UPSERT inside the same tx (same pattern as `room` × N
				// above) — N≤90 stays well inside YDB's tx-statement budget and
				// keeps the onboarding round-trip ≤ 2 s on local infra. The
				// operator overrides via `POST /api/v1/rate-plans/:id/rates`.
				const amountMicros = BigInt(input.avgPriceRub) * 1_000_000n
				for (let dayOffset = 0; dayOffset < RATE_SEED_DAYS; dayOffset += 1) {
					const dateBind = dateFromIso(isoDateOffset(dayOffset))
					await tx`
						UPSERT INTO rate (
							\`tenantId\`, \`propertyId\`, \`roomTypeId\`, \`ratePlanId\`, \`date\`,
							\`amountMicros\`, \`currency\`, \`createdAt\`, \`updatedAt\`
						) VALUES (
							${tenantId}, ${propertyId}, ${roomTypeId}, ${ratePlanId}, ${dateBind},
							${amountMicros}, ${currencyRub}, ${nowTs}, ${nowTs}
						)
					`
				}

				// 6. availability × RATE_SEED_DAYS — allotment=input.rooms, sold=0,
				// no stop-sell / min-stay / closed-to-arrival|departure. Mirrors
				// the existing `rate` loop date range so EVERY rate-priced night
				// has a matching availability row. Booking creation in
				// `booking.repo.ts:385-400` reads availability per night and
				// throws `NO_INVENTORY` on missing row — seeding here closes
				// the pre-existing «no availability row» 409 trap caught when
				// per-worker e2e tenant migration exposed onboarding gap.
				const initialSold = 0
				const noMinStay = NULL_INT32
				const noMaxStay = NULL_INT32
				const noStopSell = false
				const noCta = false
				const noCtd = false
				for (let dayOffset = 0; dayOffset < RATE_SEED_DAYS; dayOffset += 1) {
					const dateBind = dateFromIso(isoDateOffset(dayOffset))
					await tx`
						UPSERT INTO availability (
							\`tenantId\`, \`propertyId\`, \`roomTypeId\`, \`date\`,
							\`allotment\`, \`sold\`, \`minStay\`, \`maxStay\`,
							\`closedToArrival\`, \`closedToDeparture\`, \`stopSell\`,
							\`createdAt\`, \`updatedAt\`
						) VALUES (
							${tenantId}, ${propertyId}, ${roomTypeId}, ${dateBind},
							${input.rooms}, ${initialSold}, ${noMinStay}, ${noMaxStay},
							${noCta}, ${noCtd}, ${noStopSell},
							${nowTs}, ${nowTs}
						)
					`
				}

				// 7. Round 14.6.4 follow-up — re-point demo channelConnection
				// rows к the newly-created REAL propertyId.
				//
				// `afterCreateOrganization` seeds demo `channelConnection` с
				// synthetic propertyId (`demoprop_<orgId>`) ДО того как
				// existed any real property. Per-tenant demo OTA emits
				// webhooks scoped к the synthetic ID; A7.5 inbound-booking-
				// handler then looks up roomType/ratePlan under synthetic →
				// empty → handler skips → wow-effect silent break.
				//
				// Empirically caught на demo.sepshn.ru 2026-05-28 browser walk:
				// signup → wizard → demo booking succeeded в mock-OTA route
				// but never landed в `booking` table → PMS Шахматка empty.
				//
				// Architectural fix: after wizard creates real property с
				// inventory, UPDATE the demo channelConnection rows к point
				// at the real property. Idempotent UPSERT keyed on
				// (tenantId, propertyId, channelId). Old synthetic rows stay
				// in place but A7.5 handler now finds inventory under the
				// real ID. Defense-in-depth: `inbound-booking-handler.ts`
				// also adds a tenant-wide fallback if channelConnection is
				// missing inventory.
				const demoChannels = ['YT', 'ETG'] as const
				for (const channelId of demoChannels) {
					await tx`
						UPSERT INTO channelConnection (
							\`tenantId\`, \`propertyId\`, \`channelId\`,
							\`mode\`, \`role\`, \`syncStatus\`, \`isEnabled\`,
							\`createdAt\`, \`updatedAt\`
						) VALUES (
							${tenantId}, ${propertyId}, ${channelId},
							${'mock'}, ${'independent_operator'}, ${'idle'}, ${isActive},
							${nowTs}, ${nowTs}
						)
					`
				}
			})

			// `avgPriceRub` persists as `RATE_SEED_DAYS` rate rows (step 5);
			// `input.rooms` persists as the matching availability allotment
			// rows (step 6). Шахматка immediately bookable from wizard finish.
			// We echo `avgPriceRub` back in the response for the frontend's
			// «suggested default» affordance в the fill-calendar UI when the
			// operator wants to extend the horizon beyond RATE_SEED_DAYS.
			return { propertyId, roomTypeId, ratePlanId, roomIds }
		},
	}
}
