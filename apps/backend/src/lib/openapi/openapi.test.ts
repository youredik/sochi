/**
 * Round 13 — OpenAPI route smoke tests. Verify spec endpoint returns valid
 * OpenAPI 3.1 document + Swagger UI HTML mounts.
 */

import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createOpenApiRoutes } from './routes.ts'
import { SEPSHN_OPENAPI_SPEC } from './spec.ts'

describe('OpenAPI routes', () => {
	function mount() {
		return new Hono().route('/api', createOpenApiRoutes())
	}

	test('[OAS1] GET /api/openapi.json returns 200 + valid OpenAPI 3.1 document', async () => {
		const app = mount()
		const res = await app.request('/api/openapi.json')
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toContain('application/json')
		const body = (await res.json()) as { openapi: string; info: { title: string } }
		expect(body.openapi).toBe('3.1.0')
		expect(body.info.title).toBe('Sepshn — Integration API')
	})

	test('[OAS2] GET /api/docs returns Swagger UI HTML', async () => {
		const app = mount()
		const res = await app.request('/api/docs')
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toContain('text/html')
		const html = await res.text()
		expect(html).toContain('SwaggerUIBundle')
		expect(html).toContain('/api/openapi.json')
	})

	test('[OAS3] spec includes canonical Channel Webhooks path with security headers', () => {
		expect(SEPSHN_OPENAPI_SPEC.paths).toHaveProperty('/api/channel/webhooks/{channelId}')
		const path = SEPSHN_OPENAPI_SPEC.paths['/api/channel/webhooks/{channelId}']
		expect(path.post.tags).toEqual(['Channel Webhooks'])
		const params = path.post.parameters.map((p) => p.name)
		expect(params).toContain('webhook-id')
		expect(params).toContain('webhook-timestamp')
		expect(params).toContain('webhook-signature')
	})

	test('[OAS4] CloudEventEnvelope schema describes Round 10 charset-restricted URN', () => {
		const schema = SEPSHN_OPENAPI_SPEC.components.schemas.CloudEventEnvelope
		expect(schema.type).toBe('object')
		expect(schema.properties.source.pattern).toContain('[A-Za-z0-9_-]{1,64}')
	})

	test('[OAS5] demo OTA + admin paths tagged correctly', () => {
		expect(
			SEPSHN_OPENAPI_SPEC.paths['/api/_mock-ota/yandex/v1/hotels/hotel/offers'].get.tags,
		).toEqual(['Demo OTA (mock)'])
		expect(SEPSHN_OPENAPI_SPEC.paths['/api/_mock-ota/admin/reset'].post.tags).toEqual([
			'Demo Admin',
		])
	})
})
