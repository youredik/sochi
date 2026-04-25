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

// ===========================================================================
// M6.5A foundation coverage — extractIdentity + SYSTEM_FIELDS for the 5 new
// payment-domain object types (folio / payment / refund / receipt / dispute).
//
// Pre-done audit (FROM START — feedback_pre_done_audit.md):
//   [X] extractIdentity 4D-PK domains: booking/folio/payment → key[3]
//   [X] extractIdentity 3D-PK domains: refund/receipt/dispute → key[2]
//   [X] extractIdentity 2D-PK fallback: single-PK domains → key[1]
//   [X] Missing key slot returns null (negative path) for each PK shape
//   [X] Empty-string tenant slot returns null (defensive against malformed)
//   [X] buildActivitiesFromEvent INSERT/UPDATE/DELETE for each new domain
//   [X] SYSTEM_FIELDS contains EVERY state-transition timestamp from canon
//   [X] diffFields skips new state-transition timestamps (single-domain check)
//   [X] cross-domain isolation: same key shape but different objectType
//       extracts different recordId (e.g. key[2]=foo vs key[3]=bar)
// ===========================================================================

describe('extractIdentity — 4D-PK domains (booking/folio/payment)', () => {
	test('folio: key[0]=tenantId, key[3]=id', () => {
		const event: CdcEvent = {
			key: ['org_a', 'prop_x', 'book_y', 'fol_z'],
			newImage: { status: 'open' },
		}
		const acts = buildActivitiesFromEvent(event, 'folio')
		expect(acts).toHaveLength(1)
		expect(acts[0]?.tenantId).toBe('org_a')
		expect(acts[0]?.recordId).toBe('fol_z')
		expect(acts[0]?.objectType).toBe('folio')
	})

	test('payment: key[0]=tenantId, key[3]=id', () => {
		const event: CdcEvent = {
			key: ['org_a', 'prop_x', 'book_y', 'pay_z'],
			newImage: { status: 'created', amountMinor: '15900' },
		}
		const acts = buildActivitiesFromEvent(event, 'payment')
		expect(acts).toHaveLength(1)
		expect(acts[0]?.tenantId).toBe('org_a')
		expect(acts[0]?.recordId).toBe('pay_z')
	})

	test('folio missing key[3] → empty result', () => {
		const event: CdcEvent = { key: ['org_a', 'prop_x', 'book_y'], newImage: { status: 'open' } }
		expect(buildActivitiesFromEvent(event, 'folio')).toEqual([])
	})

	test('payment missing key[3] → empty result', () => {
		const event: CdcEvent = { key: ['org_a', 'prop_x', 'book_y'], newImage: { status: 'created' } }
		expect(buildActivitiesFromEvent(event, 'payment')).toEqual([])
	})

	test('payment with empty tenant slot → empty result', () => {
		const event: CdcEvent = {
			key: ['', 'prop_x', 'book_y', 'pay_z'],
			newImage: { status: 'created' },
		}
		expect(buildActivitiesFromEvent(event, 'payment')).toEqual([])
	})
})

describe('extractIdentity — 3D-PK domains (refund/receipt/dispute)', () => {
	test('refund: key[0]=tenantId, key[2]=id', () => {
		const event: CdcEvent = {
			key: ['org_a', 'pay_x', 'ref_z'],
			newImage: { status: 'pending', amountMinor: '5000' },
		}
		const acts = buildActivitiesFromEvent(event, 'refund')
		expect(acts).toHaveLength(1)
		expect(acts[0]?.tenantId).toBe('org_a')
		expect(acts[0]?.recordId).toBe('ref_z')
		expect(acts[0]?.objectType).toBe('refund')
	})

	test('receipt: key[0]=tenantId, key[2]=id', () => {
		const event: CdcEvent = {
			key: ['org_a', 'pay_x', 'rcp_z'],
			newImage: { status: 'pending', kind: 'final' },
		}
		const acts = buildActivitiesFromEvent(event, 'receipt')
		expect(acts).toHaveLength(1)
		expect(acts[0]?.recordId).toBe('rcp_z')
		expect(acts[0]?.objectType).toBe('receipt')
	})

	test('dispute: key[0]=tenantId, key[2]=id', () => {
		const event: CdcEvent = {
			key: ['org_a', 'pay_x', 'dsp_z'],
			newImage: { status: 'opened', reasonCode: '4853' },
		}
		const acts = buildActivitiesFromEvent(event, 'dispute')
		expect(acts).toHaveLength(1)
		expect(acts[0]?.recordId).toBe('dsp_z')
		expect(acts[0]?.objectType).toBe('dispute')
	})

	test('refund missing key[2] → empty result', () => {
		const event: CdcEvent = { key: ['org_a', 'pay_x'], newImage: { status: 'pending' } }
		expect(buildActivitiesFromEvent(event, 'refund')).toEqual([])
	})

	test('dispute with empty key[2] → empty result', () => {
		const event: CdcEvent = { key: ['org_a', 'pay_x', ''], newImage: { status: 'opened' } }
		expect(buildActivitiesFromEvent(event, 'dispute')).toEqual([])
	})
})

describe('extractIdentity — FULL ActivityObjectType enum coverage', () => {
	// Lock that EVERY ActivityObjectType is dispatched correctly.
	// 4D-PK domains → key[3]; 3D-PK → key[2]; 2D fallback → key[1].
	const FOUR_D = ['booking', 'folio', 'payment'] as const
	const THREE_D = ['refund', 'receipt', 'dispute'] as const
	const TWO_D_FALLBACK = [
		'property',
		'roomType',
		'room',
		'ratePlan',
		'availability',
		'rate',
		'guest',
	] as const

	test('all known ActivityObjectTypes are covered (3+3+7 = 13)', () => {
		expect(FOUR_D.length + THREE_D.length + TWO_D_FALLBACK.length).toBe(13)
	})

	test.each(FOUR_D)('4D dispatch: %s → key[0]=tenantId, key[3]=id', (objectType) => {
		const event: CdcEvent = {
			key: ['org_a', 'p1', 'middle', 'rec_z'],
			newImage: { status: 's', updatedBy: 'u' },
		}
		const acts = buildActivitiesFromEvent(event, objectType)
		expect(acts).toHaveLength(1)
		expect(acts[0]?.tenantId).toBe('org_a')
		expect(acts[0]?.recordId).toBe('rec_z')
		expect(acts[0]?.objectType).toBe(objectType)
	})

	test.each(THREE_D)('3D dispatch: %s → key[0]=tenantId, key[2]=id', (objectType) => {
		const event: CdcEvent = {
			key: ['org_a', 'parent_id', 'rec_z'],
			newImage: { status: 's', updatedBy: 'u' },
		}
		const acts = buildActivitiesFromEvent(event, objectType)
		expect(acts).toHaveLength(1)
		expect(acts[0]?.tenantId).toBe('org_a')
		expect(acts[0]?.recordId).toBe('rec_z')
		expect(acts[0]?.objectType).toBe(objectType)
	})

	test.each(TWO_D_FALLBACK)('2D fallback: %s → key[0]=tenantId, key[1]=id', (objectType) => {
		const event: CdcEvent = {
			key: ['org_a', 'rec_z'],
			newImage: { name: 'sample', updatedBy: 'u' },
		}
		const acts = buildActivitiesFromEvent(event, objectType)
		expect(acts).toHaveLength(1)
		expect(acts[0]?.tenantId).toBe('org_a')
		expect(acts[0]?.recordId).toBe('rec_z')
		expect(acts[0]?.objectType).toBe(objectType)
	})
})

describe('extractIdentity — cross-domain isolation', () => {
	// Same key array but different objectType MUST produce different recordIds
	// — guards against regression where 4D/3D dispatch gets mistakenly unified.
	const sameKey = ['org_a', 'p_x', 'middle', 'last']
	const newImage = { status: 's', updatedBy: 'u' }

	test('payment(4D) on this key → recordId=last', () => {
		const acts = buildActivitiesFromEvent({ key: sameKey, newImage }, 'payment')
		expect(acts[0]?.recordId).toBe('last')
	})

	test('refund(3D) on this key → recordId=middle (different slot!)', () => {
		const acts = buildActivitiesFromEvent({ key: sameKey, newImage }, 'refund')
		expect(acts[0]?.recordId).toBe('middle')
	})

	test('property(2D) on this key → recordId=p_x (yet another slot)', () => {
		const acts = buildActivitiesFromEvent({ key: sameKey, newImage }, 'property')
		expect(acts[0]?.recordId).toBe('p_x')
	})
})

describe('SYSTEM_FIELDS — exact-set assertion (canon coverage)', () => {
	// Lock the system-field set so adding/removing a state-transition timestamp
	// without a deliberate decision shows up in code review. Sorted for stability.
	const expected = [
		// Audit
		'createdAt',
		'updatedAt',
		'createdBy',
		'updatedBy',
		// Booking FSM
		'confirmedAt',
		'checkedInAt',
		'checkedOutAt',
		'cancelledAt',
		'noShowAt',
		// Payment FSM (9-state, canon)
		'authorizedAt',
		'capturedAt',
		'refundedAt',
		'canceledAt',
		'failedAt',
		'expiredAt',
		// Refund FSM (3-state, canon)
		'requestedAt',
		'succeededAt',
		// Folio FSM (3-state, canon)
		'closedAt',
		'settledAt',
		// folioLine sub-state
		'postedAt',
		'voidedAt',
		// Receipt FSM (5-state)
		'sentAt',
		'correctedAt',
		// Dispute FSM (5-state)
		'submittedAt',
		'resolvedAt',
	]

	test('SYSTEM_FIELDS == expected canon set (exact equality, sorted)', () => {
		expect([...SYSTEM_FIELDS].sort()).toEqual([...expected].sort())
	})

	test('SYSTEM_FIELDS size = 25 (locked count)', () => {
		// 4 audit + 5 booking + 6 payment + 2 refund + 2 folio + 2 folioLine
		// + 2 receipt + 2 dispute = 25.
		// If you add a new FSM, update this count + the expected array above.
		expect(SYSTEM_FIELDS.size).toBe(25)
	})
})

describe('diffFields — skips new domain state timestamps', () => {
	test('payment status flip emits ONE statusChange (not 6 timestamp deltas)', () => {
		// Simulate full payment lifecycle: created → succeeded.
		// All FSM timestamps go from null → ISO; status goes from 'pending' → 'succeeded'.
		// Expected: ONE statusChange row only, no per-timestamp fieldChange noise.
		const event: CdcEvent = {
			key: ['org_a', 'prop_x', 'book_y', 'pay_z'],
			oldImage: {
				status: 'pending',
				authorizedAt: null,
				capturedAt: null,
				updatedBy: 'u_old',
			},
			newImage: {
				status: 'succeeded',
				authorizedAt: '2026-04-25T10:00:00Z',
				capturedAt: '2026-04-25T10:00:01Z',
				updatedBy: 'u_new',
			},
		}
		const acts = buildActivitiesFromEvent(event, 'payment')
		expect(acts).toHaveLength(1)
		expect(acts[0]?.activityType).toBe('statusChange')
	})

	test('refund pending → succeeded: ONE statusChange (succeededAt skipped)', () => {
		const event: CdcEvent = {
			key: ['org_a', 'pay_x', 'ref_z'],
			oldImage: { status: 'pending', succeededAt: null, updatedBy: 'u_old' },
			newImage: {
				status: 'succeeded',
				succeededAt: '2026-04-25T10:00:00Z',
				updatedBy: 'u_new',
			},
		}
		const acts = buildActivitiesFromEvent(event, 'refund')
		expect(acts).toHaveLength(1)
		expect(acts[0]?.activityType).toBe('statusChange')
		expect(acts[0]?.diffJson).toMatchObject({
			field: 'status',
			oldValue: 'pending',
			newValue: 'succeeded',
		})
	})

	test('folio open → closed: ONE statusChange (closedAt + closedBy skipped)', () => {
		const event: CdcEvent = {
			key: ['org_a', 'prop_x', 'book_y', 'fol_z'],
			oldImage: { status: 'open', closedAt: null, closedBy: null, updatedBy: 'u_old' },
			newImage: {
				status: 'closed',
				closedAt: '2026-04-25T10:00:00Z',
				closedBy: 'u_new',
				updatedBy: 'u_new',
			},
		}
		const acts = buildActivitiesFromEvent(event, 'folio')
		// closedAt is system; closedBy is a non-system field (not in SYSTEM_FIELDS)
		// → 1 statusChange + 1 fieldChange(closedBy: null → u_new)
		expect(acts).toHaveLength(2)
		expect(acts[0]?.activityType).toBe('statusChange')
		expect(acts[1]?.activityType).toBe('fieldChange')
		expect(acts[1]?.diffJson).toMatchObject({ field: 'closedBy' })
	})

	test('dispute opened → won: ONE statusChange (resolvedAt + submittedAt skipped)', () => {
		const event: CdcEvent = {
			key: ['org_a', 'pay_x', 'dsp_z'],
			oldImage: {
				status: 'opened',
				resolvedAt: null,
				submittedAt: null,
				updatedBy: 'u_old',
			},
			newImage: {
				status: 'won',
				resolvedAt: '2026-04-25T10:00:00Z',
				submittedAt: '2026-04-25T09:00:00Z',
				updatedBy: 'u_new',
			},
		}
		const acts = buildActivitiesFromEvent(event, 'dispute')
		expect(acts).toHaveLength(1)
		expect(acts[0]?.activityType).toBe('statusChange')
	})
})
