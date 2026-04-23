import { createFactory } from 'hono/factory'
import type { auth } from './auth.ts'

type BaseSession = (typeof auth.$Infer.Session)['session']

/**
 * Workaround for Better Auth TS inference bug: when organization plugin
 * is loaded, `activeOrganizationId` is populated at runtime via
 * databaseHooks.session.create, but the inferred type of
 * `auth.$Infer.Session.session` does NOT include it (issues #4222, #5909).
 * We intersect explicitly so downstream code is fully typed.
 */
type SessionWithOrg = BaseSession & { activeOrganizationId: string | null }

type AuthUser = (typeof auth.$Infer.Session)['user']
type MemberRole = 'owner' | 'manager' | 'staff'

export type AppEnv = {
	Variables: {
		/** Authenticated user. Set by authMiddleware. */
		user: AuthUser
		/** Current session with organization plugin extension. Set by authMiddleware. */
		session: SessionWithOrg
		/**
		 * Active organization id = tenant id for the whole app.
		 * Set by tenantMiddleware. Guaranteed non-null downstream.
		 */
		tenantId: string
		/** Member's role in the active organization. Set by tenantMiddleware. */
		memberRole: MemberRole
	}
}

/** Pre-typed Hono factory. Use `factory.createMiddleware(...)` / `factory.createHandlers(...)`. */
export const factory = createFactory<AppEnv>()
