/**
 * Route-test helpers. Used by `*.routes.test.ts` suites to build a tiny Hono
 * app with pre-seeded `c.var` — bypasses real Better Auth + tenantMiddleware
 * so we can exercise individual route handlers in isolation.
 *
 * Two modes (mirroring stankoff-v2):
 *   1. Unit: `createTestRouter(ctx)` with fake in-memory repos.
 *   2. Integration: wire real `sql` + factories, stub only auth/tenant.
 *
 * Patterns for writing route tests sit on `expectJson` / `expectError` so
 * each test explicitly declares the expected response shape and status.
 */
import { Hono } from 'hono'
import type { PinoLogger } from 'hono-pino'
import pino from 'pino'
import type { AppEnv } from '../factory.ts'

type AuthUser = AppEnv['Variables']['user']
type AuthSession = AppEnv['Variables']['session']
type MemberRole = AppEnv['Variables']['memberRole']

export interface TestContext {
	user: AuthUser
	session: AuthSession
	tenantId: string
	memberRole: MemberRole
	/** Override the default `crypto.randomUUID()` request id for deterministic assertions. */
	requestId?: string
}

/**
 * Silent pino instance (writes to /dev/null) so tests don't pollute stdout.
 * Route handlers expect `c.var.logger` to exist — don't leave it undefined.
 */
const silentPino = pino({ level: 'silent' }) as unknown as PinoLogger

/**
 * Stub middleware for auth + tenant + requestId + logger. Sets every variable
 * `AppEnv` declares so handlers can use them exactly like in production.
 */
export function stubAuthMiddleware(ctx: TestContext) {
	const reqId = ctx.requestId ?? 'test-req-id'
	return async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
		c.set('requestId', reqId)
		c.set('logger', silentPino)
		c.set('user', ctx.user)
		c.set('session', ctx.session)
		c.set('tenantId', ctx.tenantId)
		c.set('memberRole', ctx.memberRole)
		await next()
	}
}

/**
 * Build a minimal Hono app with stubbed auth/tenant, ready for `.route(...)`
 * of the domain router under test.
 */
export function createTestRouter(ctx: TestContext) {
	return new Hono<AppEnv>().use(stubAuthMiddleware(ctx))
}

/** Shape of the error envelope produced by `app.onError`. */
export interface ApiErrorBody {
	error: { code: string; message: string; details?: unknown }
}

export async function expectError(res: Response): Promise<ApiErrorBody> {
	return (await res.json()) as ApiErrorBody
}

export async function expectJson<T = Record<string, unknown>>(res: Response): Promise<T> {
	return (await res.json()) as T
}
