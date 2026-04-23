import { createAccessControl } from 'better-auth/plugins/access'
import { adminAc, defaultStatements, memberAc } from 'better-auth/plugins/organization/access'

/**
 * Role-based access control for organizations.
 *
 * Three roles on MVP:
 *   - owner   — founder / ИП / юрлицо. All permissions.
 *   - manager — property manager. Everything except billing / deleting org.
 *   - staff   — reception. Create/update bookings and guests only.
 *
 * Statements extend Better Auth's defaults (`organization`, `member`,
 * `invitation`) with our domain resources. Each resource lists allowed actions.
 */
const statement = {
	...defaultStatements,
	property: ['create', 'read', 'update', 'delete'],
	room: ['create', 'read', 'update', 'delete'],
	ratePlan: ['create', 'read', 'update', 'delete'],
	booking: ['create', 'read', 'update', 'delete'],
	guest: ['create', 'read', 'update', 'delete'],
	report: ['read'],
	billing: ['read', 'manage'],
} as const

export const ac = createAccessControl(statement)

export const owner = ac.newRole({
	...adminAc.statements,
	property: ['create', 'read', 'update', 'delete'],
	room: ['create', 'read', 'update', 'delete'],
	ratePlan: ['create', 'read', 'update', 'delete'],
	booking: ['create', 'read', 'update', 'delete'],
	guest: ['create', 'read', 'update', 'delete'],
	report: ['read'],
	billing: ['read', 'manage'],
})

export const manager = ac.newRole({
	...adminAc.statements,
	property: ['read', 'update'],
	room: ['create', 'read', 'update', 'delete'],
	ratePlan: ['create', 'read', 'update', 'delete'],
	booking: ['create', 'read', 'update', 'delete'],
	guest: ['create', 'read', 'update', 'delete'],
	report: ['read'],
	billing: ['read'],
})

export const staff = ac.newRole({
	...memberAc.statements,
	property: ['read'],
	room: ['read'],
	ratePlan: ['read'],
	booking: ['create', 'read', 'update'],
	guest: ['create', 'read', 'update'],
})
