import { type MemberRole, memberRoleSchema } from '@horeca/shared'
import { sql } from '../db/index.ts'
import { factory } from '../factory.ts'

const VALID_ROLES = new Set<MemberRole>(memberRoleSchema.options)

/**
 * Requires an active organization on the session and that the current user
 * is a member. Sets `tenantId` (= organization id) and `memberRole` in context.
 *
 * Chain AFTER authMiddleware — depends on `c.var.session` and `c.var.user`.
 * Returns 403 if no active org or the user is not a member.
 */
export function tenantMiddleware() {
	return factory.createMiddleware(async (c, next) => {
		const orgId = c.var.session.activeOrganizationId
		if (!orgId) {
			return c.json(
				{ error: { code: 'NO_ORGANIZATION', message: 'Active organization required' } },
				403,
			)
		}

		const userId = c.var.user.id
		const [rows] = await sql<[{ role: string }]>`
			SELECT role FROM member
			WHERE organizationId = ${orgId} AND userId = ${userId}
			LIMIT 1
		`
			.isolation('onlineReadOnly')
			.idempotent(true)

		const role = rows[0]?.role
		if (!role || !VALID_ROLES.has(role as MemberRole)) {
			return c.json(
				{ error: { code: 'FORBIDDEN', message: 'Not a member of this organization' } },
				403,
			)
		}

		c.set('tenantId', orgId)
		c.set('memberRole', role as MemberRole)
		await next()
	})
}
