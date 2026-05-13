/**
 * Shared activity helpers — strict tests (A.bis.5 fix-up — bug A3.1 from
 * senior bug hunt 2026-05-12).
 *
 * Hunts (per `feedback_strict_tests.md` adversarial + enum FULL coverage):
 *   [R1-R17]  roleCanReadActivityObject — enum FULL coverage:
 *             17 ActivityObjectType values × 3 MemberRole values = 51
 *             explicit visibility cells (NOT >=; exact-value boolean).
 *   [F1-F4]   filterActivitiesByRole — empty / pure-allow / pure-deny / mixed.
 *   [F5]      filter is stable (preserves input order).
 *   [F6]      filter doesn't mutate input.
 */

import { describe, expect, it } from 'bun:test'
import {
	type Activity,
	type ActivityObjectType,
	filterActivitiesByRole,
	roleCanReadActivityObject,
} from './activity.ts'

const ALL_OBJECT_TYPES: readonly ActivityObjectType[] = [
	'booking',
	'property',
	'roomType',
	'room',
	'ratePlan',
	'availability',
	'rate',
	'guest',
	'folio',
	'payment',
	'refund',
	'receipt',
	'dispute',
	'notification',
	'migrationRegistration',
	'channelDispatch',
	'channelInbox',
] as const

const STAFF_DENIED: readonly ActivityObjectType[] = [
	'refund',
	'dispute',
	'notification',
	'channelDispatch',
	'channelInbox',
] as const

describe('shared/activity — roleCanReadActivityObject (RBAC mirror)', () => {
	it('[E1] enum FULL coverage — 17 ActivityObjectType × 3 MemberRole = 51 explicit cells', () => {
		// Owner + manager see EVERYTHING (51 - 17 = 34 of 51 cells = true).
		for (const role of ['owner', 'manager'] as const) {
			for (const objectType of ALL_OBJECT_TYPES) {
				expect(roleCanReadActivityObject(role, objectType)).toBe(true)
			}
		}
		// Staff sees 17 - 5 denied = 12 allowed.
		for (const objectType of ALL_OBJECT_TYPES) {
			const isDenied = STAFF_DENIED.includes(objectType)
			expect(roleCanReadActivityObject('staff', objectType)).toBe(!isDenied)
		}
	})

	// Explicit per-cell assertions for the 5 staff-denied objectTypes — the
	// fix's load-bearing surface (mutation gate per `feedback_strict_tests.md`).
	it('[D1] staff CANNOT see refund activity (RBAC bypass guard — rbac.ts:105)', () => {
		expect(roleCanReadActivityObject('staff', 'refund')).toBe(false)
	})
	it('[D2] staff CANNOT see dispute activity (RBAC bypass guard)', () => {
		expect(roleCanReadActivityObject('staff', 'dispute')).toBe(false)
	})
	it('[D3] staff CANNOT see notification activity (RBAC bypass guard — rbac.ts:107)', () => {
		expect(roleCanReadActivityObject('staff', 'notification')).toBe(false)
	})
	it('[D4] staff CANNOT see channelDispatch activity (RBAC bypass guard)', () => {
		expect(roleCanReadActivityObject('staff', 'channelDispatch')).toBe(false)
	})
	it('[D5] staff CANNOT see channelInbox activity (RBAC bypass guard)', () => {
		expect(roleCanReadActivityObject('staff', 'channelInbox')).toBe(false)
	})

	// Explicit per-cell assertions for the staff-allowed types — guards
	// against the helper becoming an over-broad block.
	it('[A1] staff CAN see booking activity', () => {
		expect(roleCanReadActivityObject('staff', 'booking')).toBe(true)
	})
	it('[A2] staff CAN see guest activity', () => {
		expect(roleCanReadActivityObject('staff', 'guest')).toBe(true)
	})
	it('[A3] staff CAN see folio activity (staff has folio:create/read/update)', () => {
		expect(roleCanReadActivityObject('staff', 'folio')).toBe(true)
	})
	it('[A4] staff CAN see migrationRegistration activity (rbac.ts:116)', () => {
		expect(roleCanReadActivityObject('staff', 'migrationRegistration')).toBe(true)
	})
})

describe('shared/activity — filterActivitiesByRole', () => {
	function mkActivity(objectType: ActivityObjectType, id = 'act_x'): Activity {
		return {
			tenantId: 'org_t1',
			objectType,
			recordId: 'rec_x',
			createdAt: '2026-05-12T10:00:00.000Z',
			id,
			activityType: 'created',
			actorType: 'user',
			actorUserId: 'usr_x',
			impersonatorUserId: null,
			diffJson: {},
		}
	}

	it('[F1] empty input → empty output (deterministic boundary)', () => {
		expect(filterActivitiesByRole([], 'owner')).toEqual([])
		expect(filterActivitiesByRole([], 'staff')).toEqual([])
	})

	it('[F2] owner role — pure pass-through (all entries kept)', () => {
		const input = ALL_OBJECT_TYPES.map((t) => mkActivity(t, `act_${t}`))
		expect(filterActivitiesByRole(input, 'owner')).toEqual(input)
	})

	it('[F3] staff role — 5 of 17 objectTypes filtered out', () => {
		const input = ALL_OBJECT_TYPES.map((t) => mkActivity(t, `act_${t}`))
		const out = filterActivitiesByRole(input, 'staff')
		expect(out.length).toBe(17 - 5)
		const outTypes = new Set(out.map((a) => a.objectType))
		for (const denied of STAFF_DENIED) {
			expect(outTypes.has(denied)).toBe(false)
		}
		// And every allowed type IS present (mutation gate — if implementation
		// flips a denied type to allowed, this catches).
		for (const t of ALL_OBJECT_TYPES) {
			if (!STAFF_DENIED.includes(t)) {
				expect(outTypes.has(t)).toBe(true)
			}
		}
	})

	it('[F4] manager role — pure pass-through (all entries kept)', () => {
		const input = ALL_OBJECT_TYPES.map((t) => mkActivity(t, `act_${t}`))
		expect(filterActivitiesByRole(input, 'manager')).toEqual(input)
	})

	it('[F5] filter is stable — preserves input order', () => {
		const a = mkActivity('booking', 'act_1')
		const b = mkActivity('refund', 'act_2') // staff-denied
		const c = mkActivity('guest', 'act_3')
		const out = filterActivitiesByRole([a, b, c], 'staff')
		expect(out).toEqual([a, c])
	})

	it('[F6] filter does NOT mutate the input array', () => {
		const input: Activity[] = [
			mkActivity('booking', 'act_1'),
			mkActivity('notification', 'act_2'), // staff-denied
		]
		const snapshot = [...input]
		filterActivitiesByRole(input, 'staff')
		expect(input).toEqual(snapshot)
	})
})
