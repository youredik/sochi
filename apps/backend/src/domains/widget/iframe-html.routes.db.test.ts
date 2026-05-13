/**
 * iframe HTML wrapper route — integration tests IF1-IF8 per plan §А4.4.
 *
 * Test matrix:
 *   ─── HTML wrapper delivery ─────────────────────────────────
 *     [IF1] match slug + allowlist → 200 + canonical HTML body
 *     [IF2] HTML response sets Content-Security-Policy с per-tenant frame-ancestors
 *     [IF3] HTML response sets Cross-Origin-Opener-Policy: same-origin-allow-popups (D34)
 *     [IF4] HTML response sets Permissions-Policy minimal-trust
 *     [IF5] HTML response sets Cache-Control private + Referrer-Policy + COR-P + nosniff
 *     [IF6] empty publicEmbedDomains (NULL) → 404 (cross-tenant guard)
 *     [IF7] body contains `<script defer src=... integrity="sha384-...">` SRI tag
 *     [IF8] body XSS-escapes slug into wrapper template (defense-in-depth)
 */

import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, it, jest } from 'bun:test'

jest.setTimeout(60_000)

import { toJson, toTs } from '../../db/ydb-helpers.ts'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createEmbedRepo } from './embed.repo.ts'
import { createEmbedService } from './embed.service.ts'
import { createIframeHtmlRoutes } from './iframe-html.routes.ts'

const FAKE_FACADE_BYTES = Buffer.from('!function(){"use strict";console.log("facade")}();')
const FAKE_FLOW_BYTES = Buffer.from('!function(){"use strict";console.log("flow")}();')

const SECRET_CURRENT = new Uint8Array(Buffer.from('A'.repeat(32)))

function randomSlug(prefix: string): string {
	return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

function bootRoutes() {
	const sql = getTestSql()
	const repo = createEmbedRepo(sql)
	const service = createEmbedService({
		repo,
		secrets: { current: SECRET_CURRENT, previous: null },
		bundlesDir: '/tmp/never-read',
		bundlesOverride: { embed: FAKE_FACADE_BYTES, 'booking-flow': FAKE_FLOW_BYTES },
	})
	const app = createIframeHtmlRoutes({ service })
	return { app, service }
}

async function seedPublicProperty(opts: {
	tenantId: string
	propertyId: string
	publicEmbedDomains: readonly string[] | null
	slug: string
}): Promise<void> {
	const sql = getTestSql()
	const now = new Date()
	const nowTs = toTs(now)
	await sql`
		UPSERT INTO organization (\`id\`, \`name\`, \`slug\`, \`createdAt\`)
		VALUES (${opts.tenantId}, ${'Test'}, ${opts.slug}, ${now})
	`
	await sql`
		UPSERT INTO property (
			\`tenantId\`, \`id\`, \`name\`, \`address\`, \`city\`, \`timezone\`,
			\`isActive\`, \`isPublic\`, \`publicEmbedDomains\`,
			\`createdAt\`, \`updatedAt\`
		) VALUES (
			${opts.tenantId}, ${opts.propertyId},
			${'Test Property'}, ${'addr'}, ${'Sochi'}, ${'Europe/Moscow'},
			${true}, ${true},
			${opts.publicEmbedDomains === null ? toJson(null) : toJson(opts.publicEmbedDomains)},
			${nowTs}, ${nowTs}
		)
	`
}

describe('iframe-html.routes', () => {
	beforeAll(async () => {
		await setupTestDb()
	})
	afterAll(async () => {
		await teardownTestDb()
	})

	it('[IF1] match slug + allowlist → 200 + canonical HTML body', async () => {
		const { app } = bootRoutes()
		const slug = randomSlug('if1')
		const tenantId = newId('organization')
		const propertyId = newId('property')
		await seedPublicProperty({
			tenantId,
			propertyId,
			publicEmbedDomains: ['https://hotel-aurora.ru'],
			slug,
		})
		const res = await app.request(`/v1/iframe/${slug}/${propertyId}.html`)
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toContain('text/html')
		const body = await res.text()
		expect(body).toContain('<!DOCTYPE html>')
		expect(body).toContain('<sochi-booking-widget-v1')
		expect(body).toContain(`data-slug="${slug}"`)
		expect(body).toContain(`data-property-id="${propertyId}"`)
	})

	it('[IF2] CSP `frame-ancestors` reflects per-tenant publicEmbedDomains (D11)', async () => {
		const { app } = bootRoutes()
		const slug = randomSlug('if2')
		const tenantId = newId('organization')
		const propertyId = newId('property')
		await seedPublicProperty({
			tenantId,
			propertyId,
			publicEmbedDomains: ['https://hotel-aurora.ru', 'https://www.hotel-aurora.ru'],
			slug,
		})
		const res = await app.request(`/v1/iframe/${slug}/${propertyId}.html`)
		const csp = res.headers.get('content-security-policy')
		expect(csp).not.toBe(undefined)
		expect(csp).toContain('frame-ancestors https://hotel-aurora.ru https://www.hotel-aurora.ru')
		expect(csp).toContain("default-src 'self'")
		expect(csp).toContain("base-uri 'self'")
		expect(csp).toContain("form-action 'self'")
	})

	it('[IF3] Cross-Origin-Opener-Policy: same-origin-allow-popups (D34)', async () => {
		const { app } = bootRoutes()
		const slug = randomSlug('if3')
		const tenantId = newId('organization')
		const propertyId = newId('property')
		await seedPublicProperty({
			tenantId,
			propertyId,
			publicEmbedDomains: ['https://hotel.ru'],
			slug,
		})
		const res = await app.request(`/v1/iframe/${slug}/${propertyId}.html`)
		expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin-allow-popups')
	})

	it('[IF4] Permissions-Policy minimal-trust (camera/microphone/geolocation/payment blocked)', async () => {
		const { app } = bootRoutes()
		const slug = randomSlug('if4')
		const tenantId = newId('organization')
		const propertyId = newId('property')
		await seedPublicProperty({
			tenantId,
			propertyId,
			publicEmbedDomains: ['https://hotel.ru'],
			slug,
		})
		const res = await app.request(`/v1/iframe/${slug}/${propertyId}.html`)
		const pp = res.headers.get('permissions-policy') ?? ''
		expect(pp).toContain('camera=()')
		expect(pp).toContain('microphone=()')
		expect(pp).toContain('geolocation=()')
		expect(pp).toContain('payment=()')
		expect(pp).toContain('fullscreen=(self)')
		expect(pp).toContain('storage-access=(self)')
	})

	it('[IF5] response headers — Cache-Control private + Referrer-Policy + nosniff', async () => {
		const { app } = bootRoutes()
		const slug = randomSlug('if5')
		const tenantId = newId('organization')
		const propertyId = newId('property')
		await seedPublicProperty({
			tenantId,
			propertyId,
			publicEmbedDomains: ['https://hotel.ru'],
			slug,
		})
		const res = await app.request(`/v1/iframe/${slug}/${propertyId}.html`)
		expect(res.headers.get('cache-control')).toBe('private, max-age=60, must-revalidate')
		expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
		expect(res.headers.get('x-content-type-options')).toBe('nosniff')
		expect(res.headers.get('cross-origin-resource-policy')).toBe('same-site')
	})

	it('[IF6] publicEmbedDomains=null → 404 (cross-tenant guard)', async () => {
		const { app } = bootRoutes()
		const slug = randomSlug('if6')
		const tenantId = newId('organization')
		const propertyId = newId('property')
		await seedPublicProperty({
			tenantId,
			propertyId,
			publicEmbedDomains: null,
			slug,
		})
		const res = await app.request(`/v1/iframe/${slug}/${propertyId}.html`)
		expect(res.status).toBe(404)
	})

	it('[IF7] body contains <script defer src=... integrity="sha384-...">', async () => {
		const { app, service } = bootRoutes()
		const slug = randomSlug('if7')
		const tenantId = newId('organization')
		const propertyId = newId('property')
		await seedPublicProperty({
			tenantId,
			propertyId,
			publicEmbedDomains: ['https://hotel.ru'],
			slug,
		})
		const res = await app.request(`/v1/iframe/${slug}/${propertyId}.html`)
		const body = await res.text()
		const facadeHash = service.getBundle('embed').hashHex
		expect(body).toMatch(
			/<script defer src=".+\.js" integrity="sha384-.+" crossorigin="anonymous"><\/script>/,
		)
		expect(body).toContain(facadeHash)
		expect(body).toContain(`integrity="sha384-${service.getBundle('embed').sriDigest}"`)
	})

	it('[IF8] response 404 для unknown slug (NOT 5xx, no info leak)', async () => {
		const { app } = bootRoutes()
		const propertyId = newId('property')
		const res = await app.request(`/v1/iframe/non-existent/${propertyId}.html`)
		expect(res.status).toBe(404)
	})

	it('[IF9] empty publicEmbedDomains array → CSP frame-ancestors none (no parent allowed)', async () => {
		const { app } = bootRoutes()
		const slug = randomSlug('if9')
		const tenantId = newId('organization')
		const propertyId = newId('property')
		await seedPublicProperty({
			tenantId,
			propertyId,
			publicEmbedDomains: [],
			slug,
		})
		const res = await app.request(`/v1/iframe/${slug}/${propertyId}.html`)
		expect(res.status).toBe(200)
		const csp = res.headers.get('content-security-policy') ?? ''
		expect(csp).toContain("frame-ancestors 'none'")
	})

	it('[IF10] body XSS-escapes slug + propertyId (defense-in-depth)', async () => {
		// We cannot send a slug with `<` because tenant-resolver SLUG_PATTERN
		// rejects it. But the route's `escapeHtml` is the LAST defense if
		// slug ever leaks через another pathway. Verify via direct unit test
		// of the response body — slug containing `&` (zod-allowed via `[a-z0-9-]`
		// regex doesn't permit it либо). We assert that ASCII chars round-trip
		// и that no raw `<` / `>` appear in response bytes around our injection
		// surface.
		const { app } = bootRoutes()
		const slug = randomSlug('if10')
		const tenantId = newId('organization')
		const propertyId = newId('property')
		await seedPublicProperty({
			tenantId,
			propertyId,
			publicEmbedDomains: ['https://hotel.ru'],
			slug,
		})
		const res = await app.request(`/v1/iframe/${slug}/${propertyId}.html`)
		const body = await res.text()
		// Each interpolation site MUST appear inside double-quoted attribute
		// — not as bare text — and the value must not introduce a closing tag.
		expect(body).toContain(`data-slug="${slug}"`)
		expect(body).toContain(`data-property-id="${propertyId}"`)
		// Body must not contain unsafe `&lt;script>` injection or unencoded
		// HTML metacharacters from interpolation surface.
		const slugAttrIndex = body.indexOf(`data-slug="${slug}"`)
		expect(slugAttrIndex).toBeGreaterThan(0)
		const surroundingBytes = body.slice(slugAttrIndex - 40, slugAttrIndex + 100)
		expect(surroundingBytes).not.toMatch(/<\s*script[^>]*>(?!\s*$)/)
	})

	it('[IF11] <noscript> fallback block present с booking link (D13 / A5.3)', async () => {
		// JS-disabled clients (RU gov strict-CSP, accessibility tools) need a
		// usable surface — booking link to the public widget page. Phone column
		// not yet on schema (carry-forward к M11 admin UI).
		const { app } = bootRoutes()
		const slug = randomSlug('if11')
		const tenantId = newId('organization')
		const propertyId = newId('property')
		await seedPublicProperty({
			tenantId,
			propertyId,
			publicEmbedDomains: ['https://hotel.ru'],
			slug,
		})
		const res = await app.request(`/v1/iframe/${slug}/${propertyId}.html`)
		const body = await res.text()
		// noscript exists + carries booking link. test-id для Playwright matching.
		expect(body).toContain('<noscript>')
		expect(body).toContain('</noscript>')
		expect(body).toContain('data-testid="iframe-noscript"')
		// Booking link interpolates the slug — XSS-escaped via escapeHtml.
		expect(body).toContain(`https://${slug}.sochi.app/widget/${slug}`)
		// Order matters: noscript MUST appear AFTER the custom element host
		// so that JS-enabled clients hit the Lit surface first.
		const hostIdx = body.indexOf('<sochi-booking-widget-v1')
		const noscriptIdx = body.indexOf('<noscript>')
		expect(hostIdx).toBeGreaterThan(0)
		expect(noscriptIdx).toBeGreaterThan(hostIdx)
	})

	it('[IF12] Speculation Rules block with anonymous-client-ip + own-origin scoped (D11 / A5.4)', async () => {
		// Per R2 §7: cross-site prefetch DDoS defense + RUM phantom-session
		// filter. Speculation Rules MUST:
		//   - require `anonymous-client-ip-when-cross-origin` (no third-party
		//     RUM contamination from prefetch)
		//   - scope `href_matches` к OWN origin pattern only (no wildcards
		//     like `*` that would let attacker-injected SR exfil)
		const { app } = bootRoutes()
		const slug = randomSlug('if12')
		const tenantId = newId('organization')
		const propertyId = newId('property')
		await seedPublicProperty({
			tenantId,
			propertyId,
			publicEmbedDomains: ['https://hotel.ru'],
			slug,
		})
		const res = await app.request(`/v1/iframe/${slug}/${propertyId}.html`)
		const body = await res.text()

		// SR <script type="speculationrules"> block present.
		expect(body).toContain('<script type="speculationrules">')
		// Required: anonymous-client-ip directive.
		expect(body).toContain('anonymous-client-ip-when-cross-origin')
		// Scoped: href_matches uses tenant slug — NOT a wildcard pattern.
		const srBlockMatch = body.match(/<script type="speculationrules">([\s\S]*?)<\/script>/)
		expect(srBlockMatch).not.toBeNull()
		const srBlock = srBlockMatch?.[1] ?? ''
		const srJson = JSON.parse(srBlock) as {
			prefetch: Array<{ where: { href_matches: string }; requires: string[] }>
			prerender: Array<{ where: { href_matches: string }; requires: string[] }>
		}
		// Both prefetch + prerender entries scoped к /widget/{slug}* — never
		// `*` или `/*` (which would allow attacker injection scope).
		expect(srJson.prefetch).toHaveLength(1)
		expect(srJson.prefetch[0]?.where.href_matches).toBe(`/widget/${slug}*`)
		expect(srJson.prefetch[0]?.requires).toEqual(['anonymous-client-ip-when-cross-origin'])
		expect(srJson.prerender).toHaveLength(1)
		expect(srJson.prerender[0]?.where.href_matches).toBe(`/widget/${slug}/${propertyId}*`)
		expect(srJson.prerender[0]?.requires).toEqual(['anonymous-client-ip-when-cross-origin'])
	})

	it('[IF13] Sec-Purpose: prefetch from foreign origin → 503 (D12)', async () => {
		// Verify secPurposeGuard middleware is wired to the iframe route.
		const { app } = bootRoutes()
		const slug = randomSlug('if13')
		const tenantId = newId('organization')
		const propertyId = newId('property')
		await seedPublicProperty({
			tenantId,
			propertyId,
			publicEmbedDomains: ['https://hotel.ru'],
			slug,
		})
		const res = await app.request(`/v1/iframe/${slug}/${propertyId}.html`, {
			headers: {
				'sec-purpose': 'prefetch',
				origin: 'https://attacker.example',
			},
		})
		expect(res.status).toBe(503)
		expect(res.headers.get('cache-control')).toBe('no-store')
	})

	it('[IF14] JSON-LD Hotel block emitted для demo tenant с canonical augments (M9.widget.8 / A6.1 / D1-D8)', async () => {
		// demo-sirius tenant has hardcoded augments в `lib/json-ld/demo-augments.ts`.
		// Test uses unique slug + registers it under canonical Сириус augments via
		// test-only seam (avoids UNIQUE-slug collision с real seed `demo-sirius`).
		const { registerDemoAugmentForTest } = await import('../../lib/json-ld/demo-augments.ts')
		const { app } = bootRoutes()
		const slug = randomSlug('if14')
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const dispose = registerDemoAugmentForTest(slug)
		try {
			await seedPublicProperty({
				tenantId,
				propertyId,
				publicEmbedDomains: ['https://hotel-sirius.demo'],
				slug,
			})
			// Create a roomType so JSON-LD has containsPlace[] non-empty.
			const sql = getTestSql()
			const now = new Date()
			const nowTs = toTs(now)
			await sql`
			UPSERT INTO roomType (
				\`tenantId\`, \`id\`, \`propertyId\`, \`name\`, \`description\`,
				\`maxOccupancy\`, \`baseBeds\`, \`extraBeds\`, \`areaSqm\`,
				\`inventoryCount\`, \`isActive\`, \`createdAt\`, \`updatedAt\`
			) VALUES (
				${tenantId}, ${newId('roomType')}, ${propertyId},
				${'Deluxe Sea View'}, ${'25 м², 2 гостя, балкон'},
				${2}, ${1}, ${0}, ${25},
				${5}, ${true}, ${nowTs}, ${nowTs}
			)
		`

			const res = await app.request(`/v1/iframe/${slug}/${propertyId}.html`)
			expect(res.status).toBe(200)
			const body = await res.text()

			// JSON-LD <script> block present.
			expect(body).toContain('<script type="application/ld+json">')

			// Parse the block для structural verification (D7 escape MUST round-trip).
			const match = body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)
			expect(match).not.toBeNull()
			const inner = match?.[1] ?? ''
			const parsed = JSON.parse(inner) as Record<string, unknown>
			expect(parsed['@type']).toBe('Hotel')
			expect(parsed['@context']).toBe('https://schema.org')
			const addr = parsed.address as Record<string, unknown>
			expect(addr.addressCountry).toBe('RU')
			expect(addr.postalCode).toBe('354340')
			// addressLocality mirrors `property.city` from DB — test fixture seeds
			// English 'Sochi'; real demo seed uses Cyrillic 'Сириус'.
			expect(addr.addressLocality).toBe('Sochi')
			expect(parsed.starRating).toEqual({ '@type': 'Rating', ratingValue: '4' })
			expect(parsed.aggregateRating).toBeUndefined() // D5 omitted
			expect(parsed.image).not.toBe(undefined)
			expect((parsed.image as Array<string>).length).toBeGreaterThanOrEqual(3) // Google Hotel rich-results spec
			const containsPlace = parsed.containsPlace as Array<Record<string, unknown>>
			expect(containsPlace).toHaveLength(1)
			expect(containsPlace[0]?.['@type']).toBe('HotelRoom')

			// JSON-LD must appear BEFORE the body (canonical placement в <head>).
			const jsonLdIdx = body.indexOf('<script type="application/ld+json">')
			const bodyIdx = body.indexOf('<body>')
			expect(jsonLdIdx).toBeGreaterThan(0)
			expect(jsonLdIdx).toBeLessThan(bodyIdx)
		} finally {
			dispose()
		}
	})

	it('[IF15] non-demo tenant (no augments) → JSON-LD block ABSENT (graceful degrade)', async () => {
		const { app } = bootRoutes()
		const slug = randomSlug('if15')
		const tenantId = newId('organization')
		const propertyId = newId('property')
		await seedPublicProperty({
			tenantId,
			propertyId,
			publicEmbedDomains: ['https://hotel.ru'],
			slug,
		})
		const res = await app.request(`/v1/iframe/${slug}/${propertyId}.html`)
		expect(res.status).toBe(200)
		const body = await res.text()
		// Production tenant без augments → no JSON-LD until M11 admin UI exposes
		// geo / starRating / photo CDN URLs.
		expect(body).not.toContain('<script type="application/ld+json">')
	})
})
