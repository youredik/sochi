/**
 * Portable RBAC permissions для HoReCa SaaS — shared client + server.
 *
 * Per round-6 web research (Apaleo + Cloudbeds + Mews + 54-ФЗ industry consensus):
 *   - **owner**: full access (founder/ИП, all permissions)
 *   - **manager**: revenue/refund operations, NOT billing/org management
 *   - **staff**: front-desk operations only (collect payments, NOT refund)
 *
 * **Cross-source consensus 2026**:
 *   - Apaleo: "global refund — accounting use cases — should not be regular"
 *   - Cloudbeds: separate `Add Payments` vs `Add Refund` privileges; refund recommended
 *     OFF for Front Desk Agent
 *   - 54-ФЗ: касса operations gate via PMS RBAC; кассир ФИО captured on receipt
 *
 * **Why portable (not @auth ac role objects)**: avoids better-auth dep in shared.
 * Backend AC plugin still registers roles with BA для session-side hasPermission API;
 * этот module — runtime гарант, used by both backend middleware (defence-in-depth) +
 * frontend useCan hook.
 *
 * Mirror всегда manually между этим файлом и `apps/backend/src/access-control.ts`
 * (BA role objects). Lint-style: ✓ small, no drift surface, no dynamic registry.
 */

import { type MemberRole, memberRoleSchema } from './schemas.ts'

export type { MemberRole }

export const ALL_ROLES: readonly MemberRole[] = memberRoleSchema.options

/**
 * Permission matrix per role. Resource key → list of actions granted.
 * Missing resource = no actions on that resource.
 */
const PERMISSIONS: Record<MemberRole, Record<string, readonly string[]>> = {
	owner: {
		// Full access — owner is founder / business operator
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
		// notification: outbox console + manual retry of failed/stuck rows.
		// Not staff-grantable — outbox manipulation is an operator-elevated action
		// (industry canon: Stripe, Inngest, Bull-Board all gate retry behind
		// admin role). See memory `project_mcp_server_strategic.md` (Apr 2026).
		notification: ['read', 'retry'],
		billing: ['read', 'manage'],
	},
	manager: {
		// Revenue + refund + reports; NO billing/manage, NO property delete
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
		// Front-desk operations: collect payments, NOT refund. Read-only org config.
		property: ['read'],
		room: ['read'],
		ratePlan: ['read'],
		booking: ['create', 'read', 'update'],
		guest: ['create', 'read', 'update'],
		// folio: walk-in flow требует create + post charges; close/reopen — manager+
		folio: ['create', 'read', 'update'],
		payment: ['create', 'read'],
		// refund: NOT granted — financial decision, manager+ only
		receipt: ['read', 'resend'],
		// notification: NOT granted — outbox console / retry are admin-only
	},
}

/**
 * Check whether a role grants ALL requested permissions.
 *
 * `permissions` — record of `resource → required actions`. Returns false на первом
 * missing action (no partial-credit semantics — must satisfy all).
 *
 * Usage:
 *   hasPermission('staff', { refund: ['create'] })  // false
 *   hasPermission('manager', { refund: ['create'], folio: ['close'] })  // true
 */
export function hasPermission(
	role: MemberRole,
	permissions: Record<string, readonly string[]>,
): boolean {
	const granted = PERMISSIONS[role]
	for (const [resource, actions] of Object.entries(permissions)) {
		const grantedActions = granted[resource] ?? []
		for (const action of actions) {
			if (!grantedActions.includes(action)) return false
		}
	}
	return true
}
