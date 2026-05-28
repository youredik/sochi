/**
 * Round 14.6.4 — A7.5 inbound booking sync orchestrator (demo-mode wow-effect).
 *
 * Closes the per-tenant demo OTA wow-effect chain: when a `booking.created.v1`
 * CloudEvent lands on the inbound webhook receiver (`/api/channel/webhooks/:channelId`)
 * AND the source URN tenant has an active enabled channelConnection AND the
 * organizationProfile.mode is `'demo'`, this handler:
 *
 *   1. Looks up the tenant's `channelConnection.propertyId` (per-tenant —
 *      Round 14.6 seed populates `propertyId='demoprop_<orgId>'`).
 *   2. Picks the first available `roomType` + `ratePlan` from the tenant's
 *      inventory (created в /setup wizard's inventory-step).
 *   3. Creates a synthetic guest from event.data (RFC 2606 fixture emails,
 *      ITU-T E.164.3 phones — reserved-test ranges per Round 8 P0-4 shield).
 *   4. Calls `bookingService.create()` (which short-circuits Round 14.6.4
 *      compliance gate via `mode='demo'` skip).
 *   5. PMS Шахматка at `/o/{orgSlug}/grid` queries booking table → guest
 *      sees the реservation appear в real-time.
 *
 * Canonical 2026 multi-tenant pattern (verified web research 28.05.2026 —
 * see Round 14.6.4 canon section «A7.5 wiring»): never trust per-tenant
 * identifiers from event body; always derive from authenticated source URN
 * + lookup via repository layer.
 *
 * **Production-mode safety**: handler ONLY fires for `mode='demo'` tenants —
 * production tenants ('live' mode) skip silently (event still acked, inbox
 * row written, but no booking row created). Prevents accidental real-PII
 * booking creation from a misconfigured channel. Defense-in-depth alongside
 * Round 8 P0-4 reserved-test-range shield in mock-OTA route handlers.
 *
 * Per-channel data mapping:
 *   - YT (Yandex.Путешествия): event.data has check_in/check_out/guests/customer_email
 *   - ETG (Островок): event.data has checkin/checkout/guests/customer_email
 *
 * Idempotency: bookingService.create() raises on (tenantId, externalId)
 * collision; we wrap in try/catch and log+skip duplicates (CloudEvents
 * receiver may retry on transient failures).
 *
 * Canon: `feedback_round_14_6_per_tenant_demo_canon_2026_05_28.md`.
 */

import { newId } from '@horeca/shared'
import type { query } from '@ydbjs/query'
import type { SochiCloudEvent } from '../../lib/channel-manager/cloud-events.ts'
import { logger } from '../../logger.ts'
import type { BookingService } from '../booking/booking.service.ts'
import { createChannelConnectionRepo } from './connection.repo.ts'

export interface InboundBookingHandlerDeps {
	readonly sql: ReturnType<typeof query>
	readonly bookingService: BookingService
	/** Synthetic actor ID for system-initiated bookings (no real user). */
	readonly systemActorId?: string
}

interface YtBookingData {
	readonly order_id?: unknown
	readonly external_id?: unknown
	readonly check_in?: unknown
	readonly check_out?: unknown
	readonly customer_email?: unknown
	readonly customer_phone?: unknown
	readonly guests?: ReadonlyArray<{
		readonly first_name?: unknown
		readonly last_name?: unknown
	}>
	readonly total_price_rub?: unknown
}

interface EtgBookingData {
	readonly order_id?: unknown
	readonly partner_order_id?: unknown
	readonly checkin?: unknown
	readonly checkout?: unknown
	readonly customer_email?: unknown
	readonly customer_phone?: unknown
	readonly guests?: ReadonlyArray<{
		readonly first_name?: unknown
		readonly last_name?: unknown
	}>
	readonly total_amount?: unknown
}

interface NormalizedBookingData {
	readonly externalId: string
	readonly checkIn: string
	readonly checkOut: string
	readonly guests: ReadonlyArray<{ firstName: string; lastName: string }>
	readonly customerEmail: string
	readonly customerPhone: string
}

function normalizeYtData(data: YtBookingData): NormalizedBookingData | null {
	const externalId = typeof data.order_id === 'string' ? data.order_id : null
	const checkIn = typeof data.check_in === 'string' ? data.check_in : null
	const checkOut = typeof data.check_out === 'string' ? data.check_out : null
	const email = typeof data.customer_email === 'string' ? data.customer_email : null
	const phone = typeof data.customer_phone === 'string' ? data.customer_phone : null
	if (
		externalId === null ||
		checkIn === null ||
		checkOut === null ||
		email === null ||
		phone === null
	)
		return null
	const guests = (Array.isArray(data.guests) ? data.guests : [])
		.map((g) => ({
			firstName: typeof g.first_name === 'string' ? g.first_name : '',
			lastName: typeof g.last_name === 'string' ? g.last_name : '',
		}))
		.filter((g) => g.firstName.length > 0 && g.lastName.length > 0)
	if (guests.length === 0) return null
	return { externalId, checkIn, checkOut, guests, customerEmail: email, customerPhone: phone }
}

function normalizeEtgData(data: EtgBookingData): NormalizedBookingData | null {
	const externalId =
		typeof data.partner_order_id === 'string'
			? data.partner_order_id
			: typeof data.order_id === 'string' || typeof data.order_id === 'number'
				? String(data.order_id)
				: null
	const checkIn = typeof data.checkin === 'string' ? data.checkin : null
	const checkOut = typeof data.checkout === 'string' ? data.checkout : null
	const email = typeof data.customer_email === 'string' ? data.customer_email : null
	const phone = typeof data.customer_phone === 'string' ? data.customer_phone : null
	if (
		externalId === null ||
		checkIn === null ||
		checkOut === null ||
		email === null ||
		phone === null
	)
		return null
	const guests = (Array.isArray(data.guests) ? data.guests : [])
		.map((g) => ({
			firstName: typeof g.first_name === 'string' ? g.first_name : '',
			lastName: typeof g.last_name === 'string' ? g.last_name : '',
		}))
		.filter((g) => g.firstName.length > 0 && g.lastName.length > 0)
	if (guests.length === 0) return null
	return { externalId, checkIn, checkOut, guests, customerEmail: email, customerPhone: phone }
}

function normalizeBookingData(channelId: string, data: unknown): NormalizedBookingData | null {
	if (data === null || typeof data !== 'object') return null
	if (channelId === 'YT') return normalizeYtData(data as YtBookingData)
	if (channelId === 'ETG') return normalizeEtgData(data as EtgBookingData)
	return null
}

export interface InboundBookingResult {
	readonly handled: boolean
	readonly bookingId?: string
	readonly skipReason?:
		| 'unknown_event_type'
		| 'no_connection'
		| 'live_mode'
		| 'no_inventory'
		| 'malformed_data'
		| 'duplicate'
}

/**
 * Build the onAcceptedWebhook callback. Pass to `createChannelFactory({
 * onAcceptedWebhook: createInboundBookingHandler(deps) })`.
 */
export function createInboundBookingHandler(deps: InboundBookingHandlerDeps) {
	const systemActorId = deps.systemActorId ?? 'system'
	const connectionRepo = createChannelConnectionRepo(deps.sql)

	return async ({
		channelId,
		event,
	}: {
		channelId: string
		event: SochiCloudEvent
	}): Promise<InboundBookingResult> => {
		// Only handle booking.created.v1 — cancellations / ARI deltas pass through.
		if (event.type !== 'app.sochi.channel.booking.created.v1') {
			return { handled: false, skipReason: 'unknown_event_type' }
		}

		// Source URN was validated by webhook.routes.ts BEFORE invoking this
		// handler (Round 8 P1-6 cross-tenant authorization + Round 11 P1-B3
		// secret binding). We can trust event.source.tenantId here.
		const tenantId = extractTenantFromSource(event.source)
		if (tenantId === null) {
			logger.warn({ source: event.source }, 'inbound_booking_handler_malformed_source')
			return { handled: false, skipReason: 'malformed_data' }
		}

		// Look up tenant's enabled channelConnection for this channel — gives
		// us per-tenant propertyId (Round 14.6 seeded `'demoprop_<orgId>'`).
		const connections = await connectionRepo.listByTenant(tenantId)
		const conn = connections.find((c) => c.channelId === channelId && c.isEnabled)
		if (conn === undefined) {
			logger.warn(
				{ tenantId, channelId },
				'inbound_booking_handler_no_connection — accepted but no booking created',
			)
			return { handled: false, skipReason: 'no_connection' }
		}
		const propertyId = conn.propertyId

		// Round 14.6.4 production-mode safety — only fire для demo tenants.
		// Live tenants get the inbox row + activity log but NO booking row
		// (their real channels write via dispatch path, not inbound webhook).
		const [profileRows = []] = await deps.sql<[{ mode: string | null }]>`
			SELECT mode FROM organizationProfile
			WHERE organizationId = ${tenantId}
			LIMIT 1
		`
			.isolation('snapshotReadOnly')
			.idempotent(true)
		const mode = profileRows[0]?.mode ?? null
		if (mode !== 'demo') {
			logger.info(
				{ tenantId, channelId, mode },
				'inbound_booking_handler_live_mode_skip — production tenants do not auto-create',
			)
			return { handled: false, skipReason: 'live_mode' }
		}

		// Parse channel-specific data shape into normalized form.
		const normalized = normalizeBookingData(channelId, event.data)
		if (normalized === null) {
			logger.warn(
				{ tenantId, channelId, eventType: event.type },
				'inbound_booking_handler_malformed_data',
			)
			return { handled: false, skipReason: 'malformed_data' }
		}

		// Round 14.6.4 follow-up — resolve inventory с tenant-wide fallback.
		//
		// Round 14.6 `afterCreateOrganization` seeds `channelConnection.propertyId
		// = demoprop_<orgId>` (synthetic ID). Wizard later creates a REAL property
		// (с typeid `prop_<...>`) and bulk-creates roomType + ratePlan под
		// REAL propertyId. Synthetic ID has no inventory.
		//
		// Empirically caught на demo.sepshn.ru 2026-05-28 browser walk: signup
		// → wizard → demo booking → A7.5 handler looked up roomType under
		// synthetic `demoprop_<orgId>` → no rows → handler skip с
		// `no_inventory` → booking row never created → PMS Шахматка пустая →
		// wow-effect silent break.
		//
		// Fix: prefer inventory under `channelConnection.propertyId` (synthetic
		// per-tenant scope canon); fall back к tenant's FIRST property с
		// inventory if synthetic has none. Logs the fallback decision for
		// operator visibility.
		const inventory = await resolveTenantInventory(deps.sql, tenantId, propertyId)
		if (inventory === null) {
			logger.warn(
				{ tenantId, propertyId },
				'inbound_booking_handler_no_inventory — tenant has no roomType/ratePlan',
			)
			return { handled: false, skipReason: 'no_inventory' }
		}
		const { roomTypeId, ratePlanId, resolvedPropertyId } = inventory
		if (resolvedPropertyId !== propertyId) {
			logger.info(
				{ tenantId, synthetic: propertyId, resolved: resolvedPropertyId },
				'inbound_booking_handler_property_fallback — demoprop has no inventory; using tenant first property',
			)
		}

		// Synthetic primary guest — for demo bookings we generate a guest
		// record on-the-fly from event.data. Real bookings (M9 widget flow)
		// resolve via guestService.findOrCreate by phone/email; demo skips
		// that lookup since contact is RFC-2606-reserved test data.
		const primaryGuest = normalized.guests[0]
		if (primaryGuest === undefined) {
			return { handled: false, skipReason: 'malformed_data' }
		}
		const primaryGuestId = newId('guest')

		// Map к BookingCreateInput. Demo bookings use canonical foreign-friendly
		// stub document data — bookingService skips passport gate когда
		// guestDocumentRepo is undefined (Round 7 Senior P0 fix carve-out).
		// channelCode mapping: webhook channelId (YT/ETG/TL — short codes per
		// `webhook-data-schemas.ts` canon) → bookingChannelCode enum value.
		const channelCode = mapWebhookChannelIdToBookingCode(channelId)
		if (channelCode === null) {
			logger.warn({ channelId }, 'inbound_booking_handler_unknown_channel_code')
			return { handled: false, skipReason: 'malformed_data' }
		}
		try {
			const booking = await deps.bookingService.create(
				tenantId,
				resolvedPropertyId,
				{
					roomTypeId,
					ratePlanId,
					checkIn: normalized.checkIn,
					checkOut: normalized.checkOut,
					guestsCount: normalized.guests.length,
					primaryGuestId,
					guestSnapshot: {
						firstName: primaryGuest.firstName,
						lastName: primaryGuest.lastName,
						citizenship: 'RU',
						documentType: 'passport_rf',
						documentNumber: 'demo000000',
					},
					channelCode,
					externalId: normalized.externalId,
				},
				systemActorId,
			)
			logger.info(
				{
					tenantId,
					propertyId: resolvedPropertyId,
					bookingId: booking.id,
					channelId,
					externalId: normalized.externalId,
				},
				'inbound_booking_handler_created — demo booking landed в PMS grid',
			)
			return { handled: true, bookingId: booking.id }
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e)
			// `externalId` collision = idempotent retry. Log info + skip.
			if (message.includes('externalId') || message.includes('duplicate')) {
				logger.info(
					{ tenantId, channelId, externalId: normalized.externalId },
					'inbound_booking_handler_duplicate — idempotent skip',
				)
				return { handled: false, skipReason: 'duplicate' }
			}
			logger.error(
				{
					tenantId,
					channelId,
					externalId: normalized.externalId,
					err: { message: message.slice(0, 200) },
				},
				'inbound_booking_handler_create_failed',
			)
			throw e
		}
	}
}

/**
 * Round 14.6.4 follow-up — resolve tenant inventory с fallback.
 *
 * Returns the first available (roomTypeId, ratePlanId) tuple for the tenant,
 * preferring the channelConnection-scoped `preferredPropertyId` (synthetic
 * Round 14.6 demoprop) but falling back к ANY tenant property с inventory
 * if synthetic is empty. Returns null если tenant has zero inventory.
 *
 * Resolution path:
 *   1. Try `preferredPropertyId` (channelConnection canonical scope).
 *   2. If empty, query tenant's roomTypes ordered by createdAt, pick first.
 *   3. Look up matching ratePlan для that roomType.
 *
 * Logs at info level when fallback fires so operators can see the synthetic-
 * vs-real property drift (Round 14.6.4 wow-effect chain known issue —
 * `afterCreateOrganization` seeds synthetic but wizard creates real).
 */
export async function resolveTenantInventory(
	sql: ReturnType<typeof query>,
	tenantId: string,
	preferredPropertyId: string,
): Promise<{ roomTypeId: string; ratePlanId: string; resolvedPropertyId: string } | null> {
	// Step 1 — try preferred propertyId scope.
	const [preferredRoomTypes = []] = await sql<[{ id: string }]>`
		SELECT id FROM roomType
		WHERE tenantId = ${tenantId} AND propertyId = ${preferredPropertyId}
		ORDER BY createdAt ASC
		LIMIT 1
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)
	const preferredRoomTypeId = preferredRoomTypes[0]?.id
	if (preferredRoomTypeId !== undefined) {
		const [preferredRatePlans = []] = await sql<[{ id: string }]>`
			SELECT id FROM ratePlan
			WHERE tenantId = ${tenantId}
			  AND propertyId = ${preferredPropertyId}
			  AND roomTypeId = ${preferredRoomTypeId}
			ORDER BY createdAt ASC
			LIMIT 1
		`
			.isolation('snapshotReadOnly')
			.idempotent(true)
		const preferredRatePlanId = preferredRatePlans[0]?.id
		if (preferredRatePlanId !== undefined) {
			return {
				roomTypeId: preferredRoomTypeId,
				ratePlanId: preferredRatePlanId,
				resolvedPropertyId: preferredPropertyId,
			}
		}
	}

	// Step 2 — fallback: tenant's first property с inventory.
	const [fallbackRoomTypes = []] = await sql<[{ id: string; propertyId: string }]>`
		SELECT id, propertyId FROM roomType
		WHERE tenantId = ${tenantId}
		ORDER BY createdAt ASC
		LIMIT 1
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)
	const fallbackRow = fallbackRoomTypes[0]
	if (fallbackRow === undefined) return null

	const [fallbackRatePlans = []] = await sql<[{ id: string }]>`
		SELECT id FROM ratePlan
		WHERE tenantId = ${tenantId}
		  AND propertyId = ${fallbackRow.propertyId}
		  AND roomTypeId = ${fallbackRow.id}
		ORDER BY createdAt ASC
		LIMIT 1
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)
	const fallbackRatePlanId = fallbackRatePlans[0]?.id
	if (fallbackRatePlanId === undefined) return null

	return {
		roomTypeId: fallbackRow.id,
		ratePlanId: fallbackRatePlanId,
		resolvedPropertyId: fallbackRow.propertyId,
	}
}

/**
 * Extract tenantId from CloudEvent source URN
 * (`urn:sochi:channel:<channelCode>:tenant:<tenantId>`). Returns null on
 * malformed input (Round 10 P1-B1 charset enforced upstream).
 */
function extractTenantFromSource(source: string): string | null {
	const match = source.match(/^urn:sochi:channel:[A-Za-z0-9_-]{1,16}:tenant:([A-Za-z0-9_-]{1,64})$/)
	return match?.[1] ?? null
}

/**
 * Map webhook channelId (short code per `webhook-data-schemas.ts`) to the
 * canonical `bookingChannelCode` enum value used by booking domain.
 *
 * Canonical mapping (Round 9 demo OTA canon + Round 14 channel landscape):
 *   - YT  → yandexTravel
 *   - ETG → ostrovok
 *   - TL  → travelLine
 *
 * Returns null for unknown channels — caller logs + skips.
 */
function mapWebhookChannelIdToBookingCode(
	channelId: string,
): 'yandexTravel' | 'ostrovok' | 'travelLine' | null {
	switch (channelId) {
		case 'YT':
			return 'yandexTravel'
		case 'ETG':
			return 'ostrovok'
		case 'TL':
			return 'travelLine'
		default:
			return null
	}
}
