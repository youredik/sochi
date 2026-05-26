/**
 * Round 13 — regression spec для architectural leapfrog routes mounted в this round:
 *   - GET  /api/openapi.json  — OpenAPI 3.1 spec
 *   - GET  /api/docs          — Swagger UI HTML
 *   - GET  /api/mcp/manifest  — MCP server metadata
 *   - POST /api/mcp/rpc       — JSON-RPC initialize + tools/list + tools/call
 *   - POST /api/oauth/register — RFC 7591 DCR
 *
 * Pins each canon-claim closure with end-to-end wire test. Without this spec,
 * future refactors could silently break the leapfrog claim (как Round 11 broke
 * Round 9 spec — Round 12 self-review SR-1 lesson learned).
 */
import { expect, test } from '@playwright/test'

const API = 'http://localhost:8787'

test.describe('Round 13 — architectural leapfrog regression', () => {
	test.use({ storageState: { cookies: [], origins: [] } })

	test('[R13-1] GET /api/openapi.json returns valid OpenAPI 3.1 spec', async ({ request }) => {
		const res = await request.get(`${API}/api/openapi.json`)
		expect(res.status()).toBe(200)
		const body = (await res.json()) as { openapi: string; info: { title: string } }
		expect(body.openapi).toBe('3.1.0')
		expect(body.info.title).toBe('Sepshn — Integration API')
	})

	test('[R13-2] GET /api/docs renders Swagger UI HTML', async ({ request }) => {
		const res = await request.get(`${API}/api/docs`)
		expect(res.status()).toBe(200)
		const html = await res.text()
		expect(html).toContain('SwaggerUIBundle')
		expect(html).toContain('/api/openapi.json')
	})

	test('[R13-3] GET /api/mcp/manifest returns MCP server metadata', async ({ request }) => {
		const res = await request.get(`${API}/api/mcp/manifest`)
		expect(res.status()).toBe(200)
		const body = (await res.json()) as {
			name: string
			protocolVersion: string
			transport: string
			tools: string[]
		}
		expect(body.name).toBe('sepshn-pms')
		expect(body.transport).toBe('http+json-rpc')
		expect(body.tools).toContain('sepshn.demo.list_demo_routes')
	})

	test('[R13-4] POST /api/mcp/rpc initialize handshake', async ({ request }) => {
		const res = await request.post(`${API}/api/mcp/rpc`, {
			headers: { 'content-type': 'application/json' },
			data: { jsonrpc: '2.0', id: 1, method: 'initialize' },
		})
		expect(res.status()).toBe(200)
		const body = (await res.json()) as {
			jsonrpc: '2.0'
			result: { protocolVersion: string; serverInfo: { name: string } }
		}
		expect(body.jsonrpc).toBe('2.0')
		expect(body.result.protocolVersion).toBe('2025-03-26')
	})

	test('[R13-5] POST /api/mcp/rpc tools/call sepshn.demo.list_demo_routes', async ({ request }) => {
		const res = await request.post(`${API}/api/mcp/rpc`, {
			headers: { 'content-type': 'application/json' },
			data: {
				jsonrpc: '2.0',
				id: 'r13-5',
				method: 'tools/call',
				params: { name: 'sepshn.demo.list_demo_routes', arguments: {} },
			},
		})
		expect(res.status()).toBe(200)
		const body = (await res.json()) as {
			result: { content: Array<{ text: string }> }
		}
		const parsed = JSON.parse(body.result.content[0]?.text ?? '{}') as {
			routes: Array<{ path: string }>
		}
		const paths = parsed.routes.map((r) => r.path)
		expect(paths).toContain('/demo/ota/yandex')
		expect(paths).toContain('/demo/ota/ostrovok')
	})

	test('[R13-6] POST /api/oauth/register valid → 201 + RFC 7591 response', async ({ request }) => {
		const res = await request.post(`${API}/api/oauth/register`, {
			headers: { 'content-type': 'application/json' },
			data: {
				client_name: 'R13 Smoke Test Integration',
				redirect_uris: ['https://r13-smoke.example/callback'],
			},
		})
		expect(res.status()).toBe(201)
		const body = (await res.json()) as { client_id: string; client_secret: string }
		expect(body.client_id).toMatch(/^sclient_/)
		expect(body.client_secret).toMatch(/^whsec_dcr_/)
	})

	test('[R13-7] POST /api/oauth/register reserved name → 403', async ({ request }) => {
		const res = await request.post(`${API}/api/oauth/register`, {
			headers: { 'content-type': 'application/json' },
			data: {
				client_name: 'sepshn',
				redirect_uris: ['https://x.example/cb'],
			},
		})
		expect(res.status()).toBe(403)
	})

	test('[R13-8] no route shadowing — /api/_mock-ota + /health still reachable', async ({
		request,
	}) => {
		// Round 13 mounted `/api` (OpenAPI) at root в routes chain. Hono Trie
		// router MUST keep other `/api/*` paths reachable. Empirical regression
		// guard against accidental shadowing.
		const healthRes = await request.get(`${API}/health`)
		expect(healthRes.status()).toBe(200)
		// Admin endpoint exists (returns 401 без token, но routes correctly).
		const adminRes = await request.post(`${API}/api/_mock-ota/admin/reset`)
		expect([200, 401]).toContain(adminRes.status())
	})

	test('[R13-9] JSON-LD AI markers rendered на demo property page', async ({ page }) => {
		await page.addInitScript(() => {
			window.localStorage.setItem(
				'horeca-cookie-consent',
				JSON.stringify({
					version: '2026-05-24',
					grantedAt: new Date().toISOString(),
					categories: { necessary: true, analytics: false, marketing: false },
				}),
			)
		})
		await page.goto(
			'/demo/ota/ostrovok/property/8473727?checkIn=2027-08-15&checkOut=2027-08-17&adults=2&children=0',
			{ timeout: 30_000 },
		)
		await expect(page.getByTestId('property-total-price')).toBeVisible({ timeout: 15_000 })
		const jsonLd = page.getByTestId('demo-hotel-json-ld')
		await expect(jsonLd).toHaveCount(1)
		const text = await jsonLd.textContent()
		expect(text ?? '').toContain('"@type":"Hotel"')
		expect(text ?? '').toContain('aiCompatibility')
		expect(text ?? '').toContain('alisaSearchable')
		// SearchAction (Lake.com canon prefilled-query bookmark surface)
		expect(text ?? '').toContain('SearchAction')
	})
})
