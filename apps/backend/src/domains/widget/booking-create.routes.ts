/**
 * Public widget booking-create routes (M9.widget.4 / Track A2).
 *
 * Mounted at `/api/public/widget/*` BEFORE auth middleware в app.ts.
 *
 * Route:
 *   POST /api/public/widget/:tenantSlug/booking — anonymous booking commit
 *
 * Middleware chain (order matters):
 *   1. CORS — allow embedded widgets от любого origin (no credentials)
 *   2. Strict CSP + nosniff + Referrer headers
 *   3. widgetBurstRateLimiter — 10 req/min/(IP+slug); burst-defence FIRST
 *      (cheapest reject before any DB lookup)
 *   4. widgetSteadyRateLimiter — 100 req/hr/(IP+slug); slow-and-low defence
 *   5. widgetTenantResolverMiddleware — slug → c.var.tenantId (404 timing-safe)
 *   6. idempotencyMiddleware — Idempotency-Key 24h dedup (uses c.var.tenantId)
 *   7. zValidator — JSON body schema (shared `widgetBookingCommitWireInputSchema`)
 *   8. Handler — orchestrate via WidgetBookingCreateService.commit()
 *
 * Per `plans/m9_widget_4_canonical.md` §3 + §8 hard-requirements:
 *   - Real RU compliance даже на demo (152-ФЗ + 38-ФЗ + ПП РФ 1912 + ст. 10)
 *   - Real anti-abuse (rate-limit + Idempotency-Key)
 *   - Real audit-trail (consentLog persistence)
 *   - Behaviour-faithful Stub provider — same canonical interface as live ЮKassa
 */
import { zValidator } from '@hono/zod-validator'
import { widgetBookingCommitWireInputSchema } from '@horeca/shared'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { AppEnv } from '../../factory.ts'
import type { idempotencyMiddleware } from '../../middleware/idempotency.ts'
import {
	widgetBurstRateLimiter,
	widgetSteadyRateLimiter,
} from '../../middleware/widget-rate-limit.ts'
import { widgetTenantResolverMiddleware } from '../../middleware/widget-tenant-resolver.ts'
import type {
	WidgetBookingCreateInput,
	WidgetBookingCreateService,
} from './booking-create.service.ts'

/**
 * Strict CSP for widget POST. Allows ЮKassa Widget v1 (Track C2 swap),
 * SmartCaptcha (deferred), Yandex Metrika.
 */
const WIDGET_CSP_VALUE = [
	"default-src 'self'",
	"script-src 'self' https://yookassa.ru https://static.yoomoney.ru https://mc.yandex.ru https://yastatic.net https://smartcaptcha.cloud.yandex.ru",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: https://*.storage.yandexcloud.net https://mc.yandex.ru",
	'frame-src https://yookassa.ru https://smartcaptcha.cloud.yandex.ru',
	"connect-src 'self' https://mc.yandex.ru https://smartcaptcha.cloud.yandex.ru",
	"frame-ancestors 'self'",
].join('; ')

export interface WidgetBookingCreateRoutesDeps {
	readonly service: WidgetBookingCreateService
	readonly idempotency: ReturnType<typeof idempotencyMiddleware>
	/**
	 * Override rate-limit middlewares — used by tests (which inject zero-limit
	 * dummies to disable, or low-cap variants to verify 429 path). Production
	 * defaults to canonical 10/min + 100/hr stack.
	 */
	readonly burstRateLimiter?: typeof widgetBurstRateLimiter
	readonly steadyRateLimiter?: typeof widgetSteadyRateLimiter
}

export function createWidgetBookingCreateRoutes(deps: WidgetBookingCreateRoutesDeps) {
	const burst = deps.burstRateLimiter ?? widgetBurstRateLimiter
	const steady = deps.steadyRateLimiter ?? widgetSteadyRateLimiter

	const app = new Hono<AppEnv>()
		.use(
			'*',
			cors({
				origin: '*',
				allowMethods: ['POST', 'OPTIONS'],
				allowHeaders: [
					'Content-Type',
					'Idempotency-Key',
					'x-request-id',
					'traceparent',
					'tracestate',
				],
				maxAge: 86400,
			}),
		)
		.use('*', async (c, next) => {
			await next()
			c.header('Content-Security-Policy', WIDGET_CSP_VALUE)
			c.header('X-Content-Type-Options', 'nosniff')
			c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
		})
		.post(
			'/:tenantSlug/booking',
			burst,
			steady,
			widgetTenantResolverMiddleware(),
			deps.idempotency,
			zValidator('json', widgetBookingCommitWireInputSchema),
			async (c) => {
				const slug = c.req.param('tenantSlug')
				const body = c.req.valid('json')

				// Extract IP + UA для consentLog audit-trail (152-ФЗ ст. 22.1).
				// Behind YC ALB: leftmost X-Forwarded-For = client; fallback chain.
				const forwardedFor = c.req.header('x-forwarded-for')
				const ipAddress =
					(forwardedFor ? forwardedFor.split(',')[0]?.trim() : null) ??
					c.req.header('x-real-ip') ??
					'unknown'
				const userAgent = c.req.header('user-agent') ?? null
				const idempotencyKey = c.req.header('Idempotency-Key') ?? ''

				const input: WidgetBookingCreateInput = {
					tenantId: c.var.tenantId,
					tenantSlug: slug,
					propertyId: body.propertyId,
					checkIn: body.checkIn,
					checkOut: body.checkOut,
					adults: body.adults,
					children: body.children,
					roomTypeId: body.roomTypeId,
					ratePlanId: body.ratePlanId,
					expectedTotalKopecks: body.expectedTotalKopecks,
					addons: body.addons,
					guest: {
						firstName: body.guest.firstName,
						lastName: body.guest.lastName,
						middleName: body.guest.middleName ?? null,
						email: body.guest.email,
						phone: body.guest.phone,
						citizenship: body.guest.citizenship,
						countryOfResidence: body.guest.countryOfResidence ?? null,
						specialRequests: body.guest.specialRequests ?? null,
					},
					consents: body.consents,
					consentSnapshot: body.consentSnapshot,
					paymentMethod: body.paymentMethod,
					ipAddress,
					userAgent,
					idempotencyKey,
				}

				const result = await deps.service.commit(input)
				return c.json({ data: result }, 200)
			},
		)
	return app
}
