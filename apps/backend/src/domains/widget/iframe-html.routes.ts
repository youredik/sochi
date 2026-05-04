/**
 * iframe HTML wrapper route — A4.4 fallback path.
 *
 *   GET /api/embed/v1/iframe/:tenantSlug/:propertyId.html  → HTML wrapper
 *
 * Per `plans/m9_widget_6_canonical.md` §A4.4 / D7 / D11 / D34:
 *   - Distinct eTLD+1 in production (`widget-embed.sochi.app`); locally we
 *     accept any host since dev runs single-origin. Production deploy enforces
 *     host assertion via reverse-proxy routing.
 *   - Per-tenant CSP `frame-ancestors` from `publicEmbedDomains` allowlist
 *     (D11). For JS-bundle responses CSP frame-ancestors is silently ignored
 *     (D21) but for THIS HTML response it's the canonical defense.
 *   - `Cross-Origin-Opener-Policy: same-origin-allow-popups` (D34) — allows
 *     ЮKassa popup interactions while preventing `window.opener` cross-origin
 *     reads.
 *   - `Permissions-Policy` blocks camera/microphone/geolocation/payment/usb/
 *     midi/sensors; allows `fullscreen=(self) storage-access=(self)` only.
 *   - HTML wrapper template loads SPA route `/widget/:tenantSlug` inside iframe
 *     itself? No — this route IS the page that the parent's iframe `src` points
 *     to. The HTML body just renders а SPA bootstrap shell that pulls
 *     `apps/frontend` widget chunks via existing public routes.
 *
 * Sandbox attribute set by the EMBED snippet (rendered in tenant page),
 * NOT by us. Our HTML response only controls CSP / COOP / Permissions-Policy.
 */

import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { assertHeaderSafe, assertOriginSafe } from '../../lib/embed/header-safety.ts'
import { resolveTenantBySlug } from '../../lib/tenant-resolver.ts'
import type { EmbedService } from './embed.service.ts'

/**
 * Hono routing struggles to mix `:param` capture + literal `.html` suffix on
 * Node adapter (same caveat as `.js` routes in `embed.routes.ts`). Capture
 * the trailing segment as `:propertyFile` then strip `.html` via regex.
 */
const PROPERTY_FILE_REGEX = /^([a-zA-Z0-9_-]{1,128})\.html$/

const iframeParam = z.object({
	tenantSlug: z.string().min(1).max(64),
	propertyFile: z.string().regex(PROPERTY_FILE_REGEX, 'expected <propertyId>.html'),
})

function extractPropertyId(file: string): string {
	const match = PROPERTY_FILE_REGEX.exec(file)
	if (match === null || match[1] === undefined) {
		throw new Error('iframe-html.routes: propertyFile regex desync — unreachable post-zod')
	}
	return match[1]
}

const PERMISSIONS_POLICY_VALUE = [
	'camera=()',
	'microphone=()',
	'geolocation=()',
	'payment=()',
	'usb=()',
	'midi=()',
	'accelerometer=()',
	'gyroscope=()',
	'magnetometer=()',
	'fullscreen=(self)',
	'storage-access=(self)',
].join(', ')

/**
 * Build per-tenant CSP. `frame-ancestors` lists are derived from the tenant's
 * `publicEmbedDomains` JSON column. Inline `default-src 'self'` keeps the
 * wrapper page tight; widget bundle JS comes from `widget.sochi.app` (or
 * same-origin in dev) via `script-src`.
 *
 * Each origin string passes through `assertOriginSafe` BEFORE concatenation
 * so a malicious operator value cannot CRLF-splice the CSP header (D24).
 */
function buildCspHeader(allowlist: readonly string[], scriptSrcOrigin: string): string {
	const ancestors =
		allowlist.length === 0
			? "'none'"
			: allowlist.map((o) => assertOriginSafe(o, 'CSP frame-ancestors')).join(' ')
	const safeScriptSrc = assertHeaderSafe(scriptSrcOrigin, 'CSP script-src origin')
	void safeScriptSrc
	return [
		"default-src 'self'",
		`script-src 'self' ${scriptSrcOrigin}`,
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: https:",
		"connect-src 'self' https:",
		`frame-ancestors ${ancestors}`,
		"base-uri 'self'",
		"form-action 'self'",
	].join('; ')
}

function escapeHtml(input: string): string {
	return input
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

/**
 * Render the HTML wrapper. Slug + propertyId go through `escapeHtml` BEFORE
 * any string interpolation — defense-in-depth even though zod has already
 * validated to length-bounded ASCII.
 */
function renderIframeHtml(input: {
	tenantSlug: string
	propertyId: string
	bundleUrl: string
	sriDigest: string
	nonce: string
}): string {
	const safeSlug = escapeHtml(input.tenantSlug)
	const safePropertyId = escapeHtml(input.propertyId)
	const safeBundleUrl = escapeHtml(input.bundleUrl)
	const safeSriDigest = escapeHtml(input.sriDigest)
	const safeNonce = escapeHtml(input.nonce)
	return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Бронирование — ${safeSlug}</title>
<style>
html, body { margin: 0; padding: 0; min-height: 100dvh; background: #fff; color: #0a0a0a; font: 16px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.sochi-iframe-shell { display: block; min-height: 100dvh; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
.sochi-iframe-fallback { padding: 1.5rem; text-align: center; }
.sochi-iframe-fallback a { color: #2563eb; text-decoration: underline; }
</style>
</head>
<body>
<main class="sochi-iframe-shell">
  <sochi-booking-widget-v1
    data-testid="iframe-widget-host"
    data-slug="${safeSlug}"
    data-property-id="${safePropertyId}"
    data-iframe-mode="true"
    data-nonce="${safeNonce}">
    <p class="sochi-iframe-fallback">
      Не удалось загрузить виджет.
      <a href="https://${safeSlug}.sochi.app/book" target="_top" rel="noopener">Забронировать на сайте отеля</a>
    </p>
  </sochi-booking-widget-v1>
</main>
<script defer src="${safeBundleUrl}" integrity="sha384-${safeSriDigest}" crossorigin="anonymous"></script>
</body>
</html>
`
}

export interface IframeHtmlRoutesDeps {
	readonly service: EmbedService
	/**
	 * Origin where the embed JS bundle is served (e.g.
	 * `https://widget.sochi.app`). In dev this defaults to the request's own
	 * origin (single-origin local setup). Production wires explicitly.
	 */
	readonly bundleOrigin?: string
}

export function createIframeHtmlRoutes(deps: IframeHtmlRoutesDeps) {
	const { service } = deps
	const app = new Hono().get(
		'/v1/iframe/:tenantSlug/:propertyFile',
		zValidator('param', iframeParam),
		async (c) => {
			const { tenantSlug, propertyFile } = c.req.valid('param')
			const propertyId = extractPropertyId(propertyFile)
			const resolved = await resolveTenantBySlug(tenantSlug)
			if (resolved === null) {
				return c.json({ error: { code: 'NOT_FOUND', message: 'Tenant not found' } }, 404)
			}
			const allowlist = await service.getEmbedAllowlist(resolved.tenantId, propertyId)
			if (allowlist === null) {
				return c.json({ error: { code: 'NOT_FOUND', message: 'Embed not found' } }, 404)
			}

			const facade = service.getBundle('embed')
			const requestUrl = new URL(c.req.url)
			const bundleOrigin = deps.bundleOrigin ?? `${requestUrl.protocol}//${requestUrl.host}`
			const bundleUrl = `${bundleOrigin}/api/embed/v1/${tenantSlug}/${propertyId}/${facade.hashHex}.js`
			const nonce = crypto.randomUUID()

			const cspValue = buildCspHeader(allowlist, bundleOrigin)
			c.header('Content-Type', 'text/html; charset=utf-8')
			c.header('Content-Security-Policy', cspValue)
			c.header('Cross-Origin-Opener-Policy', 'same-origin-allow-popups')
			c.header('Cross-Origin-Resource-Policy', 'same-site')
			c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
			c.header('Permissions-Policy', PERMISSIONS_POLICY_VALUE)
			c.header('X-Content-Type-Options', 'nosniff')
			c.header('Cache-Control', 'private, max-age=60, must-revalidate')

			return c.body(
				renderIframeHtml({
					tenantSlug,
					propertyId,
					bundleUrl,
					sriDigest: facade.sriDigest,
					nonce,
				}),
				200,
			)
		},
	)
	return app
}
