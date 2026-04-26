/**
 * RBAC — strict tests per memory `feedback_strict_tests.md`.
 *
 * Test plan:
 *   ALL_ROLES — exhaustive enum coverage
 *   hasPermission — boundary + adversarial:
 *     [HP1] owner всегда true (full access)
 *     [HP2] staff CANNOT refund (industry canon: financial decision = manager+)
 *     [HP3] staff CAN payment.create (front-desk operation)
 *     [HP4] manager CAN refund + read but NOT billing.manage
 *     [HP5] missing resource → false (no implicit allow)
 *     [HP6] AND-semantics: any one missing action → false
 *     [HP7] empty permissions object → true (nothing requested = nothing denied)
 *     [HP8] full enum: every role × every action explicit
 */
import { describe, expect, test } from 'vitest'
import { ALL_ROLES, hasPermission, type MemberRole } from './rbac.ts'

describe('ALL_ROLES — exhaustive enum coverage', () => {
	test('exhaustive enum, stable order: owner → manager → staff', () => {
		expect(ALL_ROLES).toEqual(['owner', 'manager', 'staff'])
	})
})

describe('hasPermission — owner', () => {
	test('[HP1] owner has full access on every resource', () => {
		expect(hasPermission('owner', { property: ['delete'] })).toBe(true)
		expect(hasPermission('owner', { folio: ['close'] })).toBe(true)
		expect(hasPermission('owner', { folio: ['reopen'] })).toBe(true)
		expect(hasPermission('owner', { payment: ['create'] })).toBe(true)
		expect(hasPermission('owner', { refund: ['create'] })).toBe(true)
		expect(hasPermission('owner', { billing: ['manage'] })).toBe(true)
	})

	test('owner can do MULTIPLE resources at once (AND-semantics ALL granted)', () => {
		expect(
			hasPermission('owner', {
				folio: ['close', 'reopen'],
				payment: ['create', 'read'],
				refund: ['create', 'read'],
			}),
		).toBe(true)
	})
})

describe('hasPermission — manager', () => {
	test('[HP4] manager can refund.create (financial operations OK)', () => {
		expect(hasPermission('manager', { refund: ['create'] })).toBe(true)
		expect(hasPermission('manager', { refund: ['read'] })).toBe(true)
	})

	test('manager can close + reopen folios (revenue ops)', () => {
		expect(hasPermission('manager', { folio: ['close'] })).toBe(true)
		expect(hasPermission('manager', { folio: ['reopen'] })).toBe(true)
	})

	test('manager CANNOT billing.manage (only owner)', () => {
		expect(hasPermission('manager', { billing: ['manage'] })).toBe(false)
		// But CAN read billing (e.g., view subscription state)
		expect(hasPermission('manager', { billing: ['read'] })).toBe(true)
	})

	test('manager CANNOT property.delete (only owner)', () => {
		expect(hasPermission('manager', { property: ['delete'] })).toBe(false)
		expect(hasPermission('manager', { property: ['update'] })).toBe(true)
	})
})

describe('hasPermission — staff (CRITICAL: Apaleo+Cloudbeds canon)', () => {
	test('[HP3] staff CAN payment.create (front-desk: collect cash/card)', () => {
		expect(hasPermission('staff', { payment: ['create'] })).toBe(true)
		expect(hasPermission('staff', { payment: ['read'] })).toBe(true)
	})

	test('[HP2] staff CANNOT refund.create (industry canon: manager+ only)', () => {
		expect(hasPermission('staff', { refund: ['create'] })).toBe(false)
	})

	test('staff CANNOT refund.read (privacy on financial data)', () => {
		expect(hasPermission('staff', { refund: ['read'] })).toBe(false)
	})

	test('staff CANNOT folio.close (manager+ controls revenue ops)', () => {
		expect(hasPermission('staff', { folio: ['close'] })).toBe(false)
		expect(hasPermission('staff', { folio: ['reopen'] })).toBe(false)
	})

	test('staff CAN folio.create + read + update (walk-in flow)', () => {
		expect(hasPermission('staff', { folio: ['create'] })).toBe(true)
		expect(hasPermission('staff', { folio: ['read'] })).toBe(true)
		expect(hasPermission('staff', { folio: ['update'] })).toBe(true)
	})

	test('staff CANNOT property.create / room.delete / ratePlan.update', () => {
		expect(hasPermission('staff', { property: ['create'] })).toBe(false)
		expect(hasPermission('staff', { room: ['delete'] })).toBe(false)
		expect(hasPermission('staff', { ratePlan: ['update'] })).toBe(false)
	})

	test('staff CAN booking + guest CRU (not delete)', () => {
		expect(hasPermission('staff', { booking: ['create', 'read', 'update'] })).toBe(true)
		expect(hasPermission('staff', { booking: ['delete'] })).toBe(false)
		expect(hasPermission('staff', { guest: ['create', 'read', 'update'] })).toBe(true)
		expect(hasPermission('staff', { guest: ['delete'] })).toBe(false)
	})
})

describe('hasPermission — adversarial paths', () => {
	test('[HP5] unknown resource → false (no implicit allow)', () => {
		expect(hasPermission('owner', { ghostResource: ['anything'] })).toBe(false)
		expect(hasPermission('manager', { admin: ['*'] })).toBe(false)
	})

	test('[HP6] AND-semantics: ANY missing action → false (must satisfy all)', () => {
		// staff can payment.create + payment.read, but NOT refund.create
		expect(
			hasPermission('staff', {
				payment: ['create', 'read'], // both granted
				refund: ['create'], // NOT granted
			}),
		).toBe(false)
	})

	test('[HP7] empty permissions object → true (nothing requested = nothing denied)', () => {
		// Edge case: middleware passes no requirements → permit
		expect(hasPermission('staff', {})).toBe(true)
		expect(hasPermission('owner', {})).toBe(true)
	})

	test('partial-action: staff has payment.create but NOT payment.delete (delete not granted to anyone here)', () => {
		// staff can payment[create, read], NOT payment[delete]
		expect(hasPermission('staff', { payment: ['create'] })).toBe(true)
		expect(hasPermission('staff', { payment: ['delete'] })).toBe(false)
	})

	test('case-sensitive resource + action keys (no implicit normalization)', () => {
		// Strict: 'Refund' !== 'refund', 'Read' !== 'read'
		expect(hasPermission('owner', { Refund: ['create'] })).toBe(false)
		expect(hasPermission('owner', { refund: ['Create'] })).toBe(false)
	})

	test('[HP8] FULL enum sweep: every role × refund.create (smoke for matrix correctness)', () => {
		const refundCreateMatrix: Record<MemberRole, boolean> = {
			owner: true,
			manager: true,
			staff: false,
		}
		for (const role of ALL_ROLES) {
			expect(hasPermission(role, { refund: ['create'] })).toBe(refundCreateMatrix[role])
		}
	})

	test('[HP8] FULL enum sweep: every role × payment.create', () => {
		const matrix: Record<MemberRole, boolean> = {
			owner: true,
			manager: true,
			staff: true, // KEY: staff DOES collect payments
		}
		for (const role of ALL_ROLES) {
			expect(hasPermission(role, { payment: ['create'] })).toBe(matrix[role])
		}
	})

	test('[HP8] FULL enum sweep: every role × billing.manage (owner-only)', () => {
		const matrix: Record<MemberRole, boolean> = {
			owner: true,
			manager: false,
			staff: false,
		}
		for (const role of ALL_ROLES) {
			expect(hasPermission(role, { billing: ['manage'] })).toBe(matrix[role])
		}
	})
})

/**
 * EXHAUSTIVE matrix sweep — kills StringLiteral mutations в data table
 * (M6.5.1 Stryker mutation testing finding 2026-04-25). Каждая (role, resource,
 * action) tuple обязана match expected boolean. Любая мутация permission строки
 * меняет result этого test'а → mutant killed.
 *
 * Reference matrix (mirror packages/shared/src/rbac.ts PERMISSIONS):
 */
describe('hasPermission — EXHAUSTIVE matrix sweep (M6.5.1 mutation gate)', () => {
	const EXPECTED: Record<MemberRole, Record<string, readonly string[]>> = {
		owner: {
			property: ['create', 'read', 'update', 'delete'],
			room: ['create', 'read', 'update', 'delete'],
			ratePlan: ['create', 'read', 'update', 'delete'],
			booking: ['create', 'read', 'update', 'delete'],
			guest: ['create', 'read', 'update', 'delete'],
			folio: ['create', 'read', 'update', 'close', 'reopen'],
			payment: ['create', 'read'],
			refund: ['create', 'read'],
			receipt: ['read', 'resend'],
			report: ['read'],
			notification: ['read', 'retry'],
			billing: ['read', 'manage'],
		},
		manager: {
			property: ['read', 'update'],
			room: ['create', 'read', 'update', 'delete'],
			ratePlan: ['create', 'read', 'update', 'delete'],
			booking: ['create', 'read', 'update', 'delete'],
			guest: ['create', 'read', 'update', 'delete'],
			folio: ['read', 'update', 'close', 'reopen'],
			payment: ['create', 'read'],
			refund: ['create', 'read'],
			receipt: ['read', 'resend'],
			report: ['read'],
			notification: ['read', 'retry'],
			billing: ['read'],
		},
		staff: {
			property: ['read'],
			room: ['read'],
			ratePlan: ['read'],
			booking: ['create', 'read', 'update'],
			guest: ['create', 'read', 'update'],
			folio: ['create', 'read', 'update'],
			payment: ['create', 'read'],
			receipt: ['read', 'resend'],
			// notification: NOT granted to staff (admin-only).
		},
	}

	const ALL_RESOURCES = [
		'property',
		'room',
		'ratePlan',
		'booking',
		'guest',
		'folio',
		'payment',
		'refund',
		'receipt',
		'report',
		'notification',
		'billing',
	] as const
	const ALL_ACTIONS = [
		'create',
		'read',
		'update',
		'delete',
		'close',
		'reopen',
		'manage',
		'resend',
		'retry',
	] as const

	test.each(ALL_ROLES)('every (resource × action) tuple matches matrix for role %s', (role) => {
		for (const resource of ALL_RESOURCES) {
			const expectedActions = EXPECTED[role][resource] ?? []
			for (const action of ALL_ACTIONS) {
				const actual = hasPermission(role, { [resource]: [action] })
				const expected = expectedActions.includes(action)
				expect(
					actual,
					`role=${role}, resource=${resource}, action=${action} expected=${expected} got=${actual}`,
				).toBe(expected)
			}
		}
	})

	test('full action set per resource — granted role passes ALL', () => {
		// Iterate role × resource → assert hasPermission(role, { resource: [allGranted] }) === true
		for (const role of ALL_ROLES) {
			for (const resource of ALL_RESOURCES) {
				const granted = EXPECTED[role][resource]
				if (!granted || granted.length === 0) continue
				expect(hasPermission(role, { [resource]: granted })).toBe(true)
			}
		}
	})

	test('any not-granted action breaks the role check', () => {
		// For each role × resource, find an action NOT in granted set, assert false
		for (const role of ALL_ROLES) {
			for (const resource of ALL_RESOURCES) {
				const granted = EXPECTED[role][resource] ?? []
				const ungranted = ALL_ACTIONS.filter((a) => !granted.includes(a))
				if (ungranted.length === 0) continue
				const action = ungranted[0]
				if (action === undefined) continue
				expect(
					hasPermission(role, { [resource]: [action] }),
					`role=${role} should NOT have ${resource}:${action}`,
				).toBe(false)
			}
		}
	})
})
