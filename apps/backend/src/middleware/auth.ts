import { auth } from '../auth.ts'
import { factory } from '../factory.ts'

/**
 * Requires a valid Better Auth session. Returns 401 if missing/expired.
 * Sets `user` and `session` in context for downstream handlers.
 */
export function authMiddleware() {
	return factory.createMiddleware(async (c, next) => {
		const result = await auth.api.getSession({ headers: c.req.raw.headers })
		if (!result) {
			return c.json(
				{ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
				401,
			)
		}
		c.set('user', result.user)
		// The organization plugin adds `activeOrganizationId` at runtime.
		// See factory.ts for the type intersection rationale.
		c.set('session', result.session as (typeof result.session) & { activeOrganizationId: string | null })
		await next()
	})
}
