import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { auth } from './auth.ts'
import { sql } from './db/index.ts'
import { createPropertyFactory } from './domains/property/property.factory.ts'
import { createPropertyRoutes } from './domains/property/property.routes.ts'
import { createRoomFactory } from './domains/room/room.factory.ts'
import { createRoomRoutes } from './domains/room/room.routes.ts'
import { createRoomTypeFactory } from './domains/roomType/roomType.factory.ts'
import { createRoomTypeRoutes } from './domains/roomType/roomType.routes.ts'
import { env } from './env.ts'
import type { AppEnv } from './factory.ts'
import { logger } from './logger.ts'

/**
 * Hono app with method-chained routes for type-safe RPC.
 * Export type `AppType = typeof routes` — NOT `typeof app`.
 */
const app = new Hono<AppEnv>()

// Domain factories (one place to wire sql → repo → service).
const propertyFactory = createPropertyFactory(sql)
const roomTypeFactory = createRoomTypeFactory(sql, propertyFactory.service)
const roomFactory = createRoomFactory(sql, propertyFactory.service, roomTypeFactory.service)

const trustedOrigins = env.BETTER_AUTH_TRUSTED_ORIGINS.split(',')
	.map((o) => o.trim())
	.filter((o) => o.length > 0)

app.use(
	'*',
	cors({
		origin: trustedOrigins.length > 0 ? trustedOrigins : env.BETTER_AUTH_URL,
		credentials: true,
		allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
		allowHeaders: ['Content-Type', 'Authorization'],
		maxAge: 86400,
	}),
)

// Better Auth mounts its own router at /api/auth/** (sign-up/email, sign-in/email,
// sign-out, get-session, organization/create, organization/invite, etc.).
// We proxy all /api/auth/* requests to auth.handler; it handles method and body parsing.
app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))

const routes = app
	.route('/api/v1/properties', createPropertyRoutes(propertyFactory))
	.route('/api/v1', createRoomTypeRoutes(roomTypeFactory))
	.route('/api/v1', createRoomRoutes(roomFactory))
	.get('/health', (c) =>
		c.json(
			{
				status: 'ok' as const,
				service: 'horeca-backend',
				time: new Date().toISOString(),
			},
			200,
		),
	)
	.get('/health/db', async (c) => {
		try {
			const result = await sql<[{ ok: number }]>`SELECT 1 AS ok`
			const ok = result[0]?.[0]?.ok === 1
			return c.json(
				{
					status: ok ? ('ok' as const) : ('degraded' as const),
					ydb: { connected: ok },
					time: new Date().toISOString(),
				},
				ok ? 200 : 503,
			)
		} catch (error) {
			logger.error({ err: error }, 'YDB health check failed')
			return c.json(
				{
					status: 'degraded' as const,
					ydb: { connected: false, error: String(error) },
					time: new Date().toISOString(),
				},
				503,
			)
		}
	})

export type AppType = typeof routes
export { app }
