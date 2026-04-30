/**
 * Public widget routes — NO auth middleware, NO tenant middleware.
 *
 * Mounted at `/api/public/widget/*` BEFORE auth middleware в app.ts so
 * anonymous clients (booking widget on hotel website) могут читать
 * public surface. Tenant resolution = URL slug → `tenant-resolver.ts`.
 *
 * Per `plans/m9_widget_canonical.md` §M9.widget.1-3:
 *   GET  /api/public/widget/:tenantSlug/properties                          — list public properties
 *   GET  /api/public/widget/:tenantSlug/properties/:propId                  — property detail + room types
 *   GET  /api/public/widget/:tenantSlug/properties/:propId/availability     — Screen 1 search & pick
 *   GET  /api/public/widget/:tenantSlug/properties/:propId/addons           — Screen 2 extras
 *
 * Mutating endpoints (POST booking, magic-link consumption) — М9.widget.4
 * + М9.widget.5, separate routes file.
 *
 * Security baseline:
 *   - 404 on unknown slug / non-public property (timing-safe — same shape)
 *   - Strict CSP header set on EVERY response (shadow widget hosts, no nonce
 *     here — nonce wired в M9.widget.4 для script-src 'strict-dynamic')
 *   - CORS preflight allows `*` for read endpoints (no credentials)
 */
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { z } from 'zod'
import {
	InvalidAvailabilityInputError,
	PublicPropertyNotFoundError,
	TenantNotFoundError,
	type WidgetService,
} from './widget.service.ts'

const tenantSlugParam = z.object({
	tenantSlug: z.string().min(1).max(64),
})

const propertyParam = z.object({
	tenantSlug: z.string().min(1).max(64),
	propertyId: z.string().min(1).max(128),
})

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const availabilityQuery = z.object({
	checkIn: z.string().regex(ISO_DATE, 'checkIn must be YYYY-MM-DD'),
	checkOut: z.string().regex(ISO_DATE, 'checkOut must be YYYY-MM-DD'),
	adults: z.coerce.number().int().min(1).max(10),
	children: z.coerce.number().int().min(0).max(6).default(0),
})

/**
 * Strict CSP for widget pages. Allows ЮKassa Checkout Widget v1, Yandex
 * Metrika, Yandex SmartCaptcha (M9.widget.4 wires those). 'strict-dynamic'
 * + nonce — defer M9.widget.4 (server-rendered nonce per request).
 */
const WIDGET_CSP_VALUE = [
	"default-src 'self'",
	"script-src 'self' https://yookassa.ru https://mc.yandex.ru https://yastatic.net https://captcha.yandex.com",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: https://*.storage.yandexcloud.net https://mc.yandex.ru",
	'frame-src https://yookassa.ru https://captcha.yandex.com',
	"connect-src 'self' https://mc.yandex.ru",
	"frame-ancestors 'self'",
].join('; ')

export function createWidgetRoutes(service: WidgetService) {
	const app = new Hono()
		// Read-only public endpoints: CORS allows any origin (no credentials).
		// Mutating endpoints (POST booking) get separate per-tenant allow-list
		// в М9.widget.4.
		.use(
			'*',
			cors({
				origin: '*',
				allowMethods: ['GET', 'OPTIONS'],
				allowHeaders: ['Content-Type', 'x-request-id', 'traceparent', 'tracestate'],
				maxAge: 86400,
			}),
		)
		// Set strict CSP on every response (defence-in-depth).
		.use('*', async (c, next) => {
			await next()
			c.header('Content-Security-Policy', WIDGET_CSP_VALUE)
			c.header('X-Content-Type-Options', 'nosniff')
			c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
		})
		.get('/:tenantSlug/properties', zValidator('param', tenantSlugParam), async (c) => {
			const { tenantSlug } = c.req.valid('param')
			try {
				const view = await service.listProperties(tenantSlug)
				return c.json({ data: view }, 200)
			} catch (err) {
				if (err instanceof TenantNotFoundError) {
					return c.json({ error: { code: 'NOT_FOUND', message: 'Tenant not found' } }, 404)
				}
				throw err
			}
		})
		.get('/:tenantSlug/properties/:propertyId', zValidator('param', propertyParam), async (c) => {
			const { tenantSlug, propertyId } = c.req.valid('param')
			try {
				const detail = await service.getPropertyDetail(tenantSlug, propertyId)
				return c.json({ data: detail }, 200)
			} catch (err) {
				if (err instanceof TenantNotFoundError || err instanceof PublicPropertyNotFoundError) {
					// Same response shape для tenant-not-found and property-not-found —
					// timing-safe, не утекает существование tenant'а.
					return c.json({ error: { code: 'NOT_FOUND', message: 'Resource not found' } }, 404)
				}
				throw err
			}
		})
		.get(
			'/:tenantSlug/properties/:propertyId/addons',
			zValidator('param', propertyParam),
			async (c) => {
				const { tenantSlug, propertyId } = c.req.valid('param')
				try {
					const view = await service.listAddons(tenantSlug, propertyId)
					return c.json({ data: view }, 200)
				} catch (err) {
					if (err instanceof TenantNotFoundError || err instanceof PublicPropertyNotFoundError) {
						return c.json({ error: { code: 'NOT_FOUND', message: 'Resource not found' } }, 404)
					}
					throw err
				}
			},
		)
		.get(
			'/:tenantSlug/properties/:propertyId/availability',
			zValidator('param', propertyParam),
			zValidator('query', availabilityQuery),
			async (c) => {
				const { tenantSlug, propertyId } = c.req.valid('param')
				const { checkIn, checkOut, adults, children } = c.req.valid('query')
				try {
					const availability = await service.getAvailability({
						tenantSlug,
						propertyId,
						checkIn,
						checkOut,
						adults,
						children,
					})
					// Wire format: bigint amounts already converted to kopecks (number)
					// в service layer. JSON-safe.
					return c.json({ data: availability }, 200)
				} catch (err) {
					if (err instanceof InvalidAvailabilityInputError) {
						return c.json({ error: { code: 'INVALID_INPUT', message: err.reason } }, 422)
					}
					if (err instanceof TenantNotFoundError || err instanceof PublicPropertyNotFoundError) {
						return c.json({ error: { code: 'NOT_FOUND', message: 'Resource not found' } }, 404)
					}
					throw err
				}
			},
		)
	return app
}
