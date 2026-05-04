/**
 * Embed widget HTTP routes (M9.widget.6 / А4.3.b) — 4 endpoints:
 *
 *   GET  /api/embed/v1/:tenantSlug/:propertyId/:hash.js    — facade bundle
 *   GET  /api/embed/v1/_chunk/booking-flow/:hash.js        — lazy chunk
 *   POST /api/embed/v1/:tenantSlug/:propertyId/commit-token — issue HMAC token
 *   POST /api/embed/v1/_kill                                — admin kill-switch
 *
 * Per `plans/m9_widget_6_canonical.md`:
 *   * **D21** dynamic CORS reflection from `publicEmbedDomains` allowlist —
 *     CSP `frame-ancestors` does NOT apply to JS responses (silently ignored
 *     per MDN 2026); CORS is the actual access boundary on bundle GETs.
 *   * **D22** `Sec-Fetch-Site` decorative — log for telemetry, NOT enforced.
 *     Hono `csrf()` middleware ONLY on POST routes (legitimate cross-site
 *     fetch on bundle GET).
 *   * **D23** path-segment hash validation — backend computes SHA-384 of
 *     bundle bytes at startup; URL `:hash` must match → 410 Gone otherwise
 *     (forces tenant page to refresh embed snippet on rotation).
 *   * **D24** `assertOriginSafe()` BEFORE every `c.header(...)` splice —
 *     defense-in-depth against header injection via operator-controlled
 *     `publicEmbedDomains`.
 *   * **D25** `clientCommitToken` HMAC sign + verify через `embed.service`.
 *     `nbf=iat+0.8s` enforces minimum-interaction gap (D18 clickjacking).
 *   * **D26** kill-switch writes append-only `widgetReleaseAudit` row
 *     (atomicity inside `sql.begin({ idempotent: true })` — caller passes
 *     the tx, repo joins it).
 *   * **D27** `constantTailLatency` floor on slug GET — bounds enumeration
 *     timing oracle on 404 vs 200 path.
 *   * **D28** `Integrity-Policy` header + `Reporting-Endpoints` emit
 *     unconditionally on both bundle GETs.
 *   * **D29** Hono native `c.body(buffer)` + immutable `Cache-Control`
 *     (no `serveStatic` because bundles are pre-loaded в memory).
 */

import { zValidator } from '@hono/zod-validator'
import { newId } from '@horeca/shared'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { assertHeaderSafe, assertOriginSafe } from '../../lib/embed/header-safety.ts'
import { constantTailLatency } from '../../lib/embed/timing.ts'
import { resolveTenantBySlug } from '../../lib/tenant-resolver.ts'
import { authMiddleware } from '../../middleware/auth.ts'
import { widgetBundleKindSchema, widgetReleaseActionSchema } from './embed.repo.ts'
import type { EmbedService } from './embed.service.ts'

/** Same hex-SHA-384 shape used in `widgetReleaseAudit.hash` schema. */
const HASH_HEX_REGEX = /^[a-f0-9]{96}$/i

/**
 * Hono routing struggles to mix `:param` capture + literal `.js` suffix on
 * Node adapter (capture eats the dot). Instead we capture `<hash>.js` as ONE
 * segment via `:hashfile` and zod-validate с regex that strips `.js`.
 */
const HASH_FILE_REGEX = /^([a-f0-9]{96})\.js$/i

const hashfileSchema = z.string().regex(HASH_FILE_REGEX, 'expected <hex-sha384>.js')

const facadeParam = z.object({
	tenantSlug: z.string().min(1).max(64),
	propertyId: z.string().min(1).max(128),
	hashfile: hashfileSchema,
})

const lazyChunkParam = z.object({
	hashfile: hashfileSchema,
})

function extractHash(hashfile: string): string {
	const match = HASH_FILE_REGEX.exec(hashfile)
	if (match === null || match[1] === undefined) {
		throw new Error('embed.routes: hashfile regex desync — should be unreachable post-zod')
	}
	return match[1]
}

const commitTokenParam = z.object({
	tenantSlug: z.string().min(1).max(64),
	propertyId: z.string().min(1).max(128),
})

const killSwitchBody = z.object({
	hash: z.string().regex(HASH_HEX_REGEX),
	bundleKind: widgetBundleKindSchema,
	action: widgetReleaseActionSchema,
	reason: z.string().min(1).max(500),
	tenantId: z.string().min(1),
})

/**
 * Build CORS origin matcher that reflects against `publicEmbedDomains` per
 * tenant property — `Access-Control-Allow-Origin` only echoed if request
 * `Origin` is in the allowlist. ALL other origins yield no `ACAO` header
 * (browser blocks credentialed/cross-site usage).
 *
 * D24 hardening: `assertOriginSafe(allowed)` AND `assertHeaderSafe(origin)`
 * BEFORE setting the header — closes header-injection regardless of which
 * side controls the bytes.
 */
async function maybeReflectOrigin(
	c: Context,
	service: EmbedService,
	tenantId: string,
	propertyId: string,
): Promise<void> {
	const requestOrigin = c.req.header('origin') ?? null
	if (requestOrigin === null) return
	assertHeaderSafe(requestOrigin, 'CORS request Origin')
	const allowlist = await service.getEmbedAllowlist(tenantId, propertyId)
	if (allowlist === null || allowlist.length === 0) return
	const matched = allowlist.find((o) => o === requestOrigin)
	if (matched === undefined) return
	c.header('Access-Control-Allow-Origin', assertOriginSafe(matched, 'CORS reflection'))
	c.header('Vary', 'Origin')
}

const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable'
const INTEGRITY_POLICY = 'blocked-destinations=(script)'
const REPORTING_ENDPOINTS = 'integrity-endpoint="/api/embed/v1/_report/integrity"'

function attachBundleHeaders(c: Context): void {
	c.header('Content-Type', 'application/javascript; charset=utf-8')
	c.header('Cache-Control', IMMUTABLE_CACHE_CONTROL)
	c.header('Integrity-Policy', INTEGRITY_POLICY)
	c.header('Reporting-Endpoints', REPORTING_ENDPOINTS)
	c.header('X-Content-Type-Options', 'nosniff')
	c.header('Cross-Origin-Resource-Policy', 'cross-origin')
	const sfs = c.req.header('sec-fetch-site')
	if (sfs !== undefined) {
		// D22 — decorative: telemetry only, never gates access.
		c.header('Vary', mergeVary(c.res.headers.get('vary'), 'Sec-Fetch-Site'))
	}
}

function mergeVary(existing: string | null, addition: string): string {
	if (existing === null || existing === '') return addition
	const parts = existing.split(',').map((s) => s.trim().toLowerCase())
	if (parts.includes(addition.toLowerCase())) return existing
	return `${existing}, ${addition}`
}

export interface EmbedRoutesDeps {
	readonly service: EmbedService
}

export function createEmbedRoutes(deps: EmbedRoutesDeps) {
	const { service } = deps

	const app = new Hono()
		// GET lazy chunk FIRST — its URL pattern `/v1/_chunk/booking-flow/<hash>.js`
		// would otherwise be eaten by the more general facade route с
		// :tenantSlug=_chunk, :propertyId=booking-flow. Hono router takes the
		// first matching declaration — order is the resolution.
		.get('/v1/_chunk/booking-flow/:hashfile', zValidator('param', lazyChunkParam), async (c) => {
			const { hashfile } = c.req.valid('param')
			const hash = extractHash(hashfile)
			const bundle = service.matchBundleByHash('booking-flow', hash)
			if (bundle === null) {
				return c.json({ error: { code: 'GONE', message: 'Bundle hash superseded' } }, 410)
			}
			attachBundleHeaders(c)
			c.header('Access-Control-Allow-Origin', '*')
			return c.body(new Uint8Array(bundle.bytes), 200)
		})
		// GET facade: `/v1/:tenantSlug/:propertyId/<hash>.js`
		// Constant-tail-latency wraps lookup so 404 (slug miss) and 200
		// (bundle delivery) take the same wall-clock floor — closes
		// enumeration timing oracle (D27).
		.get('/v1/:tenantSlug/:propertyId/:hashfile', zValidator('param', facadeParam), async (c) => {
			const { tenantSlug, propertyId, hashfile } = c.req.valid('param')
			const hash = extractHash(hashfile)
			const result = await constantTailLatency(async () => {
				const resolved = await resolveTenantBySlug(tenantSlug)
				if (resolved === null) return { kind: 'not-found' as const }
				const allowlist = await service.getEmbedAllowlist(resolved.tenantId, propertyId)
				if (allowlist === null) return { kind: 'not-found' as const }
				return { kind: 'ok' as const, tenantId: resolved.tenantId, allowlist }
			}, 15)
			if (result.kind === 'not-found') {
				return c.json({ error: { code: 'NOT_FOUND', message: 'Embed not found' } }, 404)
			}
			const bundle = service.matchBundleByHash('embed', hash)
			if (bundle === null) {
				return c.json({ error: { code: 'GONE', message: 'Bundle hash superseded' } }, 410)
			}
			const status = await service.getReleaseStatus(result.tenantId, bundle.hashHex)
			if (status === 'revoked') {
				return c.json({ error: { code: 'GONE', message: 'Bundle revoked' } }, 410)
			}
			await maybeReflectOrigin(c, service, result.tenantId, propertyId)
			attachBundleHeaders(c)
			return c.body(new Uint8Array(bundle.bytes), 200)
		})

		// POST commit-token — explicit Origin allowlist check (D22).
		//
		// Note: Hono `csrf()` middleware bypasses requests with
		// `Content-Type: application/json` because the browser preflight
		// already handles cross-origin (canonical CSRF defense relies on
		// preflight). For embed widget our explicit allowlist takes precedence —
		// only origins в `publicEmbedDomains` are allowed; all others 403.
		.post(
			'/v1/:tenantSlug/:propertyId/commit-token',
			zValidator('param', commitTokenParam),
			async (c) => {
				const { tenantSlug, propertyId } = c.req.valid('param')
				const requestOrigin = c.req.header('origin') ?? null
				if (requestOrigin !== null) {
					assertHeaderSafe(requestOrigin, 'commit-token Origin')
				}
				const resolved = await resolveTenantBySlug(tenantSlug)
				if (resolved === null) {
					return c.json({ error: { code: 'NOT_FOUND', message: 'Tenant not found' } }, 404)
				}
				const allowlist = await service.getEmbedAllowlist(resolved.tenantId, propertyId)
				if (allowlist === null || allowlist.length === 0) {
					return c.json({ error: { code: 'NOT_FOUND', message: 'Embed not found' } }, 404)
				}
				if (requestOrigin === null || !allowlist.includes(requestOrigin)) {
					return c.json({ error: { code: 'FORBIDDEN', message: 'Origin not allowed' } }, 403)
				}
				const token = await service.signCommitToken({
					tenantId: resolved.tenantId,
					slug: tenantSlug,
				})
				return c.json({
					token,
					issuedAt: Math.floor(Date.now() / 1000),
				})
			},
		)

		// POST _kill — admin auth + transactional audit row. Only operators
		// who own the tenant can revoke its bundles.
		.use('/v1/_kill', authMiddleware())
		.post('/v1/_kill', zValidator('json', killSwitchBody), async (c) => {
			const session = c.get('session') as { activeOrganizationId: string | null } | undefined
			const user = c.get('user') as { id: string } | undefined
			const body = c.req.valid('json')
			if (!session || !user || session.activeOrganizationId !== body.tenantId) {
				return c.json({ error: { code: 'FORBIDDEN', message: 'Not your tenant' } }, 403)
			}
			await service.recordReleaseEvent({
				tenantId: body.tenantId,
				id: newId('widgetReleaseAudit'),
				hash: body.hash,
				bundleKind: body.bundleKind,
				action: body.action,
				reason: body.reason,
				actorUserId: user.id,
				actorSource: 'admin_ui',
				actionAt: new Date(),
			})
			return c.json({ ok: true })
		})

	return app
}
