/**
 * Unit + property-based tests for CDC handler pure functions.
 *
 * Business invariants (example-based):
 *   [D1] `diffFields` returns one entry per changed non-system field
 *   [D2] Skips fields in SYSTEM_FIELDS set (createdAt/updatedAt/… + state
 *        transition timestamps — those are captured by statusChange semantic)
 *   [D3] Treats a field present in only one image as changed (schema drift
 *        or newly-added column on UPSERT)
 *   [D4] Stringified equality — catches Date/number JSON round-trip drift
 *   [D5] INSERT event → ONE `created` activity
 *   [D6] DELETE event → ONE `deleted` activity
 *   [D7] UPDATE with status change → ONE `statusChange` + N `fieldChange`
 *        (other fields)
 *   [D8] UPDATE with only non-status changes → N `fieldChange` rows only
 *   [D9] UPDATE with zero non-system diffs → empty result (no noise rows)
 *   [D10] Missing `id`/`tenantId` in image → empty result (can't attribute)
 *   [D11] actorUserId falls back to createdBy → 'system' in that order
 *
 * Property-based (fuzz over input space):
 *   [DP1] diffFields produces NO entry for a field that IS in skip-set,
 *         regardless of value
 *   [DP2] If oldImage === newImage (deep-equal clone), diffFields returns []
 *   [DP3] Every emitted activity carries the expected tenantId + recordId
 *         from the image (for any INSERT/UPDATE/DELETE event)
 */
import { fc, test as pbTest } from '@fast-check/vitest'
import { describe, expect, test } from 'vitest'
import {
	buildActivitiesFromEvent,
	type CdcEvent,
	diffFields,
	SYSTEM_FIELDS,
} from './cdc-handlers.ts'

describe('diffFields (pure)', () => {
	test('[D1] returns one entry per changed non-system field', () => {
		const oldImage = { name: 'A', price: 100, status: 'active' }
		const newImage = { name: 'B', price: 200, status: 'active' }
		expect(diffFields(oldImage, newImage)).toEqual([
			{ field: 'name', oldValue: 'A', newValue: 'B' },
			{ field: 'price', oldValue: 100, newValue: 200 },
		])
	})

	test('[D2] skips SYSTEM_FIELDS even when changed', () => {
		const oldImage = { status: 'confirmed', updatedAt: 't1', updatedBy: 'u1', checkedInAt: null }
		const newImage = { status: 'in_house', updatedAt: 't2', updatedBy: 'u2', checkedInAt: 't3' }
		expect(diffFields(oldImage, newImage)).toEqual([
			{ field: 'status', oldValue: 'confirmed', newValue: 'in_house' },
		])
	})

	test('[D3] field present only in newImage counts as changed', () => {
		const diffs = diffFields({}, { addedField: 'value' })
		expect(diffs).toEqual([{ field: 'addedField', oldValue: undefined, newValue: 'value' }])
	})

	test('[D4] stringified compare ignores Date/number/string equivalence via JSON', () => {
		// Round-trip through JSON: number stays number, string stays string.
		const oldImage = { count: 5 }
		const newImage = { count: 5 }
		expect(diffFields(oldImage, newImage)).toEqual([])
	})

	test('[D9] zero non-system diffs → empty array (no noise)', () => {
		const oldImage = { updatedAt: 't1', status: 'x' }
		const newImage = { updatedAt: 't2', status: 'x' }
		expect(diffFields(oldImage, newImage)).toEqual([])
	})
})

describe('buildActivitiesFromEvent (pure)', () => {
	const base = { tenantId: 'org_abc', id: 'book_123' }

	test('[D5] INSERT (newImage only) → one `created` activity', () => {
		// YDB CDC contract: newImage does NOT include PK columns. They're in `key`.
		// Our booking compound PK: [tenantId, propertyId, checkIn, id].
		const event: CdcEvent = {
			key: ['org_abc', 'prop_1', '2027-07-01', 'book_123'],
			update: { status: 'confirmed' },
			newImage: { status: 'confirmed', amount: 1000, createdBy: 'usr_1' },
		}
		const acts = buildActivitiesFromEvent(event, 'booking')
		expect(acts).toHaveLength(1)
		expect(acts[0]).toMatchObject({
			tenantId: 'org_abc',
			objectType: 'booking',
			recordId: 'book_123',
			activityType: 'created',
			actorUserId: 'usr_1',
		})
		const diff = acts[0]?.diffJson as { fields: Record<string, unknown> }
		expect(diff.fields.amount).toBe(1000)
		expect(diff.fields.status).toBe('confirmed')
	})

	test('[D6] DELETE (oldImage only) → one `deleted` activity', () => {
		const event: CdcEvent = {
			key: ['org_abc', 'prop_1', '2027-07-01', 'book_123'],
			erase: {},
			oldImage: { ...base, status: 'cancelled', createdBy: 'usr_2', updatedBy: 'usr_2' },
		}
		const acts = buildActivitiesFromEvent(event, 'booking')
		expect(acts).toHaveLength(1)
		expect(acts[0]?.activityType).toBe('deleted')
	})

	test('[D7] UPDATE with status change → one statusChange + field changes for others', () => {
		const event: CdcEvent = {
			key: ['org_abc', 'prop_1', '2027-07-01', 'book_123'],
			update: { status: 'cancelled', cancelReason: 'guest request' },
			oldImage: {
				...base,
				status: 'confirmed',
				cancelReason: null,
				assignedRoomId: null,
				updatedBy: 'usr_old',
			},
			newImage: {
				...base,
				status: 'cancelled',
				cancelReason: 'guest request',
				assignedRoomId: null,
				updatedBy: 'usr_new',
			},
		}
		const acts = buildActivitiesFromEvent(event, 'booking')
		expect(acts).toHaveLength(2)
		expect(acts[0]?.activityType).toBe('statusChange')
		expect(acts[0]?.diffJson).toEqual({
			field: 'status',
			oldValue: 'confirmed',
			newValue: 'cancelled',
		})
		expect(acts[1]?.activityType).toBe('fieldChange')
		expect(acts[1]?.diffJson).toMatchObject({
			field: 'cancelReason',
			newValue: 'guest request',
		})
		// Actor resolves from newImage.updatedBy (the one who made the change).
		expect(acts[0]?.actorUserId).toBe('usr_new')
	})

	test('[D8] UPDATE with only non-status diffs → fieldChange rows only', () => {
		const event: CdcEvent = {
			key: ['org_abc', 'prop_1', '2027-07-01', 'book_123'],
			update: { notes: 'updated' },
			oldImage: { ...base, status: 'confirmed', notes: 'old', updatedBy: 'usr_x' },
			newImage: { ...base, status: 'confirmed', notes: 'updated', updatedBy: 'usr_x' },
		}
		const acts = buildActivitiesFromEvent(event, 'booking')
		expect(acts).toHaveLength(1)
		expect(acts[0]?.activityType).toBe('fieldChange')
		expect(acts[0]?.diffJson).toMatchObject({ field: 'notes', newValue: 'updated' })
	})

	test('[D9] UPDATE with only system-field changes → empty result', () => {
		const event: CdcEvent = {
			key: ['org_abc', 'prop_1', '2027-07-01', 'book_123'],
			update: { updatedAt: 't2' },
			oldImage: { ...base, updatedAt: 't1', status: 'confirmed' },
			newImage: { ...base, updatedAt: 't2', status: 'confirmed' },
		}
		expect(buildActivitiesFromEvent(event, 'booking')).toEqual([])
	})

	test('[D10] missing key components → empty result (no attribution possible)', () => {
		// PK in YDB CDC is in `key[]`, not in newImage. Validate guards:
		const missingBoth: CdcEvent = { key: [], newImage: { status: 'x' } }
		expect(buildActivitiesFromEvent(missingBoth, 'booking')).toEqual([])

		// booking PK[3]=id; key with 3 components is missing the id slot.
		const missingId: CdcEvent = {
			key: ['org_1', 'prop_1', '2027-07-01'],
			newImage: { status: 'x' },
		}
		expect(buildActivitiesFromEvent(missingId, 'booking')).toEqual([])

		// Empty string in tenant slot → treated as missing.
		const emptyTenant: CdcEvent = {
			key: ['', 'prop_1', '2027-07-01', 'book_1'],
			newImage: { status: 'x' },
		}
		expect(buildActivitiesFromEvent(emptyTenant, 'booking')).toEqual([])
	})

	test('[D11] actor resolution: updatedBy → createdBy → "system"', () => {
		const bookingKey = ['org_abc', 'prop_1', '2027-07-01', 'book_123']
		const withUpdatedBy: CdcEvent = {
			key: bookingKey,
			newImage: { status: 'x', updatedBy: 'u1', createdBy: 'u2' },
		}
		expect(buildActivitiesFromEvent(withUpdatedBy, 'booking')[0]?.actorUserId).toBe('u1')

		const withCreatedByOnly: CdcEvent = {
			key: bookingKey,
			newImage: { status: 'x', createdBy: 'u2' },
		}
		expect(buildActivitiesFromEvent(withCreatedByOnly, 'booking')[0]?.actorUserId).toBe('u2')

		const anonymous: CdcEvent = { key: bookingKey, newImage: { status: 'x' } }
		expect(buildActivitiesFromEvent(anonymous, 'booking')[0]?.actorUserId).toBe('system')
	})
})

// ---------------------------------------------------------------------------
// Property-based fuzz — cover the input space beyond hand-rolled examples.
// ---------------------------------------------------------------------------

const jsonValueArb = fc.oneof(
	fc.string(),
	fc.integer(),
	fc.boolean(),
	fc.constant(null),
	fc.constant(undefined),
)

const imageArb = fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), jsonValueArb, {
	minKeys: 0,
	maxKeys: 15,
})

describe('diffFields — property-based', () => {
	pbTest.prop([imageArb, imageArb])(
		'[DP1] no entry EVER emitted for a field in skip-set, regardless of values',
		(oldImage, newImage) => {
			const diffs = diffFields(oldImage, newImage)
			for (const d of diffs) {
				expect(SYSTEM_FIELDS.has(d.field)).toBe(false)
			}
		},
	)

	pbTest.prop([imageArb])(
		'[DP2] diffing an image against itself yields an empty result',
		(image) => {
			// Deep clone to guarantee ref inequality — JSON.stringify roundtrip.
			const clone = JSON.parse(JSON.stringify(image)) as Record<string, unknown>
			expect(diffFields(image, clone)).toEqual([])
		},
	)
})

describe('buildActivitiesFromEvent — property-based', () => {
	const tenantArb = fc.string({ minLength: 1, maxLength: 30 })
	const recordArb = fc.string({ minLength: 1, maxLength: 30 })

	pbTest.prop([tenantArb, recordArb, imageArb])(
		'[DP3] every emitted activity carries tenantId + recordId from the PK key array',
		(tenantId, recordId, image) => {
			// Booking compound PK: [tenantId, propertyId, checkIn, id].
			const event: CdcEvent = {
				key: [tenantId, 'prop_any', '2030-01-01', recordId],
				newImage: image,
			}
			const acts = buildActivitiesFromEvent(event, 'booking')
			for (const a of acts) {
				expect(a.tenantId).toBe(tenantId)
				expect(a.recordId).toBe(recordId)
				expect(a.objectType).toBe('booking')
			}
		},
	)
})
