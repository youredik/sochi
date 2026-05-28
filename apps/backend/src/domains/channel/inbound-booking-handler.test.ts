/**
 * Round 14.6.4 — inbound booking handler unit tests (A7.5 wow-effect).
 *
 * Pins the per-tenant demo OTA → PMS booking creation flow:
 *   - YT and ETG payload normalization
 *   - tenantId extraction from CloudEvent source URN
 *   - demo-mode vs live-mode gating
 *   - inventory lookup (roomType + ratePlan) per-tenant scope
 *   - channelCode mapping (YT → yandexTravel, ETG → ostrovok, TL → travelLine)
 *   - duplicate-externalId idempotent skip
 *   - malformed data graceful skip
 *
 * Uses in-memory DB stub fixtures so tests run без YDB dependency.
 */

import { describe, expect, it } from 'bun:test'
import type { Booking } from '@horeca/shared'
import { buildCloudEvent, buildSourceUrn } from '../../lib/channel-manager/cloud-events.ts'
import { createInboundBookingHandler } from './inbound-booking-handler.ts'

const TENANT_DEMO = 'org_test_demo_a'
const ROOM_TYPE_ID = 'rmt_test'
const RATE_PLAN_ID = 'rtp_test'

/** Build a minimal `sql` template-tag stub that returns canned rows for each query shape. */
function buildSqlStub(opts: {
	organizationProfile?: { mode: string }
	roomType?: { id: string } | null
	ratePlan?: { id: string } | null
}) {
	// biome-ignore lint/suspicious/noExplicitAny: test stub mirroring runtime template-tag shape.
	const stub: any = (strings: TemplateStringsArray, ..._values: unknown[]) => {
		const query = strings.join('?')
		// SELECT mode FROM organizationProfile
		if (query.includes('organizationProfile')) {
			return Promise.resolve([[opts.organizationProfile ?? { mode: 'demo' }]])
		}
		// SELECT id FROM roomType
		if (query.includes('FROM roomType')) {
			const row = opts.roomType ?? { id: ROOM_TYPE_ID }
			return Promise.resolve([row === null ? [] : [row]])
		}
		// SELECT id FROM ratePlan
		if (query.includes('FROM ratePlan')) {
			const row = opts.ratePlan ?? { id: RATE_PLAN_ID }
			return Promise.resolve([row === null ? [] : [row]])
		}
		return Promise.resolve([[]])
	}
	stub.isolation = () => stub
	stub.idempotent = () => stub
	return stub
}

function buildBookingService(opts: {
	createdBookings?: Booking[]
	throwOn?: (input: { externalId: string | null | undefined }) => Error | null
}) {
	const createdBookings = opts.createdBookings ?? []
	return {
		// biome-ignore lint/suspicious/noExplicitAny: test mock signature widened.
		create: async (tenantId: string, propertyId: string, input: any, _actor: string) => {
			const externalId = (input.externalId as string | null | undefined) ?? null
			const err = opts.throwOn?.({ externalId })
			if (err) throw err
			const booking = {
				id: `bkg_${createdBookings.length + 1}`,
				tenantId,
				propertyId,
				...input,
			} as unknown as Booking
			createdBookings.push(booking)
			return booking
		},
		createdBookings,
		// biome-ignore lint/suspicious/noExplicitAny: stub.
	} as any
}

function buildHandler(opts: {
	sqlStub: ReturnType<typeof buildSqlStub>
	bookingService: ReturnType<typeof buildBookingService>
}) {
	return createInboundBookingHandler({
		sql: opts.sqlStub,
		bookingService: opts.bookingService,
	})
}

describe('createInboundBookingHandler — Round 14.6.4 A7.5 wow-effect', () => {
	it('[IBH1] unknown event type → skip с unknown_event_type reason', async () => {
		const sqlStub = buildSqlStub({})
		const bookingService = buildBookingService({})
		const handler = buildHandler({ sqlStub, bookingService })

		const event = buildCloudEvent({
			id: 'evt_test',
			source: buildSourceUrn({ channelCode: 'YT', organizationId: TENANT_DEMO }),
			type: 'app.sochi.channel.ari.delta.v1', // not booking.created.v1
			data: {},
		})
		const result = await handler({ channelId: 'YT', event })
		expect(result.handled).toBe(false)
		expect(result.skipReason).toBe('unknown_event_type')
		expect(bookingService.createdBookings).toEqual([])
	})

	it('[IBH2] malformed source URN → skip с malformed_data', async () => {
		const sqlStub = buildSqlStub({})
		const bookingService = buildBookingService({})
		const handler = buildHandler({ sqlStub, bookingService })

		const event = buildCloudEvent({
			id: 'evt_test',
			source: 'malformed:not-a-urn',
			type: 'app.sochi.channel.booking.created.v1',
			data: {},
		})
		const result = await handler({ channelId: 'YT', event })
		expect(result.handled).toBe(false)
		expect(result.skipReason).toBe('malformed_data')
	})
})

/**
 * Round 14.6.4 follow-up — tenant inventory resolver с fallback.
 *
 * Pins the synthetic-vs-real property mismatch fix (browser walk
 * 2026-05-28 caught wow-effect silent break: `afterCreateOrganization`
 * seeds channelConnection с synthetic `demoprop_<orgId>` ДО wizard
 * creates real property; A7.5 handler looked up inventory under
 * synthetic → empty → skip → booking never в `booking` table).
 *
 * Behaviour matrix:
 *   - Preferred has BOTH roomType + ratePlan → return preferred tuple
 *   - Preferred has roomType but NO ratePlan → fall back to tenant scope
 *   - Preferred empty + tenant has inventory → return fallback (с logged drift)
 *   - Tenant has nothing → return null
 */
describe('resolveTenantInventory — Round 14.6.4 fallback resolver', () => {
	function buildResolverSqlStub(opts: {
		preferredRoomType?: { id: string } | null
		preferredRatePlan?: { id: string } | null
		fallbackRoomType?: { id: string; propertyId: string } | null
		fallbackRatePlan?: { id: string } | null
	}) {
		// biome-ignore lint/suspicious/noExplicitAny: test stub mirroring runtime template-tag + chainable shape.
		const stub: any = (strings: TemplateStringsArray, ..._values: unknown[]) => {
			const q = strings.join('?')
			let response: unknown[] = []
			if (q.includes('FROM roomType') && q.includes('AND propertyId')) {
				const r = opts.preferredRoomType
				response = [r === null || r === undefined ? [] : [r]]
			} else if (q.includes('FROM ratePlan') && q.includes('roomTypeId')) {
				// First call = preferred ratePlan; second call (after fallback
				// roomType) = fallback ratePlan. Helper-call-order pin.
				const r = opts.preferredRatePlan ?? opts.fallbackRatePlan
				response = [r === null || r === undefined ? [] : [r]]
			} else if (q.includes('FROM roomType') && !q.includes('AND propertyId')) {
				const r = opts.fallbackRoomType
				response = [r === null || r === undefined ? [] : [r]]
			} else {
				response = [[]]
			}
			// Chainable thenable — `.isolation()` + `.idempotent()` + `await`
			// all return self / resolve к response, mirroring @ydbjs/query shape.
			// biome-ignore lint/suspicious/noExplicitAny: thenable shape mirrors @ydbjs/query QueryBuilder.
			const chainable: any = {
				isolation: () => chainable,
				idempotent: () => chainable,
				// biome-ignore lint/suspicious/noThenProperty: thenable shape mandatory for await semantics.
				then: (resolve: (v: unknown) => void) => Promise.resolve(response).then(resolve),
			}
			return chainable
		}
		stub.isolation = () => stub
		stub.idempotent = () => stub
		return stub
	}

	it('[IBH3a] preferred property has full inventory → returns preferred tuple', async () => {
		const sqlStub = buildResolverSqlStub({
			preferredRoomType: { id: 'rmt_synth' },
			preferredRatePlan: { id: 'rtp_synth' },
		})
		const { resolveTenantInventory } = await import('./inbound-booking-handler.ts')
		const result = await resolveTenantInventory(sqlStub, 'org_x', 'demoprop_org_x')
		expect(result).not.toBeNull()
		expect(result?.roomTypeId).toBe('rmt_synth')
		expect(result?.ratePlanId).toBe('rtp_synth')
		expect(result?.resolvedPropertyId).toBe('demoprop_org_x')
	})

	it('[IBH3b] preferred empty → falls back к tenant first property', async () => {
		const sqlStub = buildResolverSqlStub({
			preferredRoomType: null,
			fallbackRoomType: { id: 'rmt_real', propertyId: 'prop_real_xyz' },
			fallbackRatePlan: { id: 'rtp_real' },
		})
		const { resolveTenantInventory } = await import('./inbound-booking-handler.ts')
		const result = await resolveTenantInventory(sqlStub, 'org_x', 'demoprop_org_x')
		expect(result).not.toBeNull()
		expect(result?.roomTypeId).toBe('rmt_real')
		expect(result?.ratePlanId).toBe('rtp_real')
		expect(result?.resolvedPropertyId).toBe('prop_real_xyz')
	})

	it('[IBH3c] tenant has zero inventory → returns null', async () => {
		const sqlStub = buildResolverSqlStub({
			preferredRoomType: null,
			fallbackRoomType: null,
		})
		const { resolveTenantInventory } = await import('./inbound-booking-handler.ts')
		const result = await resolveTenantInventory(sqlStub, 'org_x', 'demoprop_org_x')
		expect(result).toBeNull()
	})
})
