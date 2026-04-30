/**
 * Public widget booking-create routes (M9.widget.4 / Track A2).
 *
 * Mounted at `/api/public/widget/*` BEFORE auth middleware в app.ts.
 *
 * Route:
 *   POST /api/public/widget/:tenantSlug/booking — anonymous booking commit
 *
 * Middleware chain:
 *   1. CORS — allow embedded widgets от любого origin (no credentials)
 *   2. Strict CSP headers
 *   3. widgetTenantResolverMiddleware — resolves slug → c.var.tenantId
 *      (sets c.var.tenant), 404 timing-safe on unknown
 *   4. idempotencyMiddleware — Idempotency-Key 24h dedup (uses c.var.tenantId
 *      from step 3, platform-first canon, no fork)
 *   5. Rate-limit (in-memory hono-rate-limiter): 10/min/IP + 100/hr/IP per slug
 *   6. zValidator — JSON body schema (Zod)
 *   7. Handler — orchestrate via WidgetBookingCreateService.commit()
 *
 * Per `plans/m9_widget_4_canonical.md` §3:
 *   - Real RU compliance даже на demo (152-ФЗ + 38-ФЗ + ПП РФ 1912 + ст. 10)
 *   - Real anti-abuse (rate-limit + Idempotency-Key)
 *   - Real audit-trail (consentLog persistence)
 *   - Behaviour-faithful Stub provider — same canonical interface as live ЮKassa
 */
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { z } from 'zod'
import type { AppEnv } from '../../factory.ts'
import type { idempotencyMiddleware } from '../../middleware/idempotency.ts'
import { widgetTenantResolverMiddleware } from '../../middleware/widget-tenant-resolver.ts'
import type {
	WidgetBookingCreateInput,
	WidgetBookingCreateService,
} from './booking-create.service.ts'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Body schema for POST /:tenantSlug/booking */
const bookingPostBody = z.object({
	propertyId: z.string().min(1).max(128),
	checkIn: z.string().regex(ISO_DATE, 'checkIn must be YYYY-MM-DD'),
	checkOut: z.string().regex(ISO_DATE, 'checkOut must be YYYY-MM-DD'),
	adults: z.number().int().min(1).max(10),
	children: z.number().int().min(0).max(6),
	roomTypeId: z.string().min(1).max(128),
	ratePlanId: z.string().min(1).max(128),
	expectedTotalKopecks: z.number().int().min(0),
	addons: z
		.array(
			z.object({
				addonId: z.string().min(1).max(128),
				quantity: z.number().int().min(1).max(50),
			}),
		)
		.default([]),
	guest: z.object({
		firstName: z.string().min(1).max(100),
		lastName: z.string().min(1).max(100),
		middleName: z.string().max(100).nullable().optional(),
		email: z.string().email().max(254),
		phone: z.string().min(5).max(30),
		citizenship: z
			.string()
			.length(2)
			.regex(/^[A-Z]{2}$/, 'ISO-3166 alpha-2, uppercase'),
		countryOfResidence: z.string().max(100).nullable().optional(),
		specialRequests: z.string().max(2000).nullable().optional(),
	}),
	consents: z.object({
		acceptedDpa: z.boolean(),
		acceptedMarketing: z.boolean(),
	}),
	consentSnapshot: z.object({
		dpaText: z.string().min(1).max(10_000),
		marketingText: z.string().min(1).max(10_000),
		version: z
			.string()
			.min(1)
			.max(20)
			.regex(/^v\d+\.\d+$/, 'Format: v<major>.<minor> (e.g. v1.0)'),
	}),
	// Restricted к canonical PaymentMethod enum (`packages/shared/src/payment.ts`).
	// RU-specific methods (mir_pay/sber_pay/t_pay/yoo_money) — defer к Track C2
	// when live ЮKassa empirically verifies + canonical schema extended.
	paymentMethod: z.enum(['card', 'sbp']),
})

/**
 * Strict CSP for widget POST. Allows ЮKassa Widget v1 (track C2 swap),
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

export function createWidgetBookingCreateRoutes(deps: {
	service: WidgetBookingCreateService
	idempotency: ReturnType<typeof idempotencyMiddleware>
}) {
	const app = new Hono<AppEnv>()
		// CORS — widgets embedded на любом origin; POST allowed
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
		// Strict CSP + nosniff + Referrer
		.use('*', async (c, next) => {
			await next()
			c.header('Content-Security-Policy', WIDGET_CSP_VALUE)
			c.header('X-Content-Type-Options', 'nosniff')
			c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
		})
		.post(
			'/:tenantSlug/booking',
			widgetTenantResolverMiddleware(),
			deps.idempotency,
			zValidator('json', bookingPostBody),
			async (c) => {
				const slug = c.req.param('tenantSlug')
				const body = c.req.valid('json')

				// Extract IP + UA для consentLog audit-trail (152-ФЗ ст. 22.1).
				// Hono CFs may set forwarded headers; behind YC ALB the
				// X-Forwarded-For leftmost IP is the client.
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
