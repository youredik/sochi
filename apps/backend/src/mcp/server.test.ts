/**
 * Round 13 — MCP server skeleton strict tests.
 */

import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createMcpRoutes } from './server.ts'

describe('MCP server skeleton (Round 13)', () => {
	function mount() {
		return new Hono().route('/api/mcp', createMcpRoutes())
	}

	test('[MCP1] GET /api/mcp/manifest returns server metadata + transport', async () => {
		const app = mount()
		const res = await app.request('/api/mcp/manifest')
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			name: string
			version: string
			protocolVersion: string
			transport: string
			tools: string[]
		}
		expect(body.name).toBe('sepshn-pms')
		expect(body.version).toBe('0.1.0')
		expect(body.transport).toBe('http+json-rpc')
		expect(body.tools).toContain('sepshn.demo.list_demo_routes')
	})

	test('[MCP2] POST /api/mcp/rpc initialize returns protocolVersion + capabilities', async () => {
		const app = mount()
		const res = await app.request('/api/mcp/rpc', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			jsonrpc: '2.0'
			id: number
			result: { protocolVersion: string; serverInfo: { name: string } }
		}
		expect(body.jsonrpc).toBe('2.0')
		expect(body.id).toBe(1)
		expect(body.result.protocolVersion).toBe('2025-03-26')
		expect(body.result.serverInfo.name).toBe('sepshn-pms')
	})

	test('[MCP3] POST /api/mcp/rpc tools/list enumerates tools', async () => {
		const app = mount()
		const res = await app.request('/api/mcp/rpc', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 'a', method: 'tools/list' }),
		})
		const body = (await res.json()) as {
			result: { tools: Array<{ name: string; description: string }> }
		}
		expect(body.result.tools.length).toBeGreaterThan(0)
		expect(body.result.tools[0]?.name).toBe('sepshn.demo.list_demo_routes')
	})

	test('[MCP4] POST /api/mcp/rpc tools/call sepshn.demo.list_demo_routes returns route list', async () => {
		const app = mount()
		const res = await app.request('/api/mcp/rpc', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 'call-1',
				method: 'tools/call',
				params: { name: 'sepshn.demo.list_demo_routes', arguments: {} },
			}),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			result: { content: Array<{ type: string; text: string }> }
		}
		expect(body.result.content[0]?.type).toBe('text')
		const parsed = JSON.parse(body.result.content[0]?.text ?? '{}') as {
			routes: Array<{ path: string }>
		}
		const paths = parsed.routes.map((r) => r.path)
		expect(paths).toContain('/demo')
		expect(paths).toContain('/demo/ota/yandex')
		expect(paths).toContain('/demo/ota/ostrovok')
		expect(paths).toContain('/demo/showcase')
	})

	test('[MCP5] POST /api/mcp/rpc unknown method → -32601', async () => {
		const app = mount()
		const res = await app.request('/api/mcp/rpc', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'unknown/method' }),
		})
		const body = (await res.json()) as { error: { code: number; message: string } }
		expect(body.error.code).toBe(-32601)
		expect(body.error.message).toContain('Method not found')
	})

	test('[MCP6] POST /api/mcp/rpc malformed JSON → -32700 parse error', async () => {
		const app = mount()
		const res = await app.request('/api/mcp/rpc', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{not valid json',
		})
		expect(res.status).toBe(400)
		const body = (await res.json()) as { error: { code: number } }
		expect(body.error.code).toBe(-32700)
	})

	test('[MCP-E4-1] tools/call sepshn.demo.get_property_summary', async () => {
		const app = mount()
		const res = await app.request('/api/mcp/rpc', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 'e4-1',
				method: 'tools/call',
				params: { name: 'sepshn.demo.get_property_summary', arguments: {} },
			}),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as { result: { content: Array<{ text: string }> } }
		const parsed = JSON.parse(body.result.content[0]?.text ?? '{}') as {
			property: { id: string; channelIds: string[] }
		}
		expect(parsed.property.id).toBe('demo-hotel-sochi')
		expect(parsed.property.channelIds).toEqual(['YT', 'ETG'])
	})

	test('[MCP-E4-2] tools/call sepshn.demo.list_recent_demo_bookings respects limit', async () => {
		const app = mount()
		const res = await app.request('/api/mcp/rpc', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 'e4-2',
				method: 'tools/call',
				params: {
					name: 'sepshn.demo.list_recent_demo_bookings',
					arguments: { limit: 2 },
				},
			}),
		})
		const body = (await res.json()) as { result: { content: Array<{ text: string }> } }
		const parsed = JSON.parse(body.result.content[0]?.text ?? '{}') as {
			bookings: ReadonlyArray<{ bookingId: string; guest: { email: string } }>
		}
		expect(parsed.bookings.length).toBe(2)
		// All emails are RFC 2606 reserved-test (no real PII)
		for (const b of parsed.bookings) {
			expect(b.guest.email).toMatch(/@example\.com$/)
		}
	})

	test('[MCP-E4-3] manifest exposes all 3 demo tools', async () => {
		const app = mount()
		const res = await app.request('/api/mcp/manifest')
		const body = (await res.json()) as { tools: string[] }
		expect(body.tools).toContain('sepshn.demo.list_demo_routes')
		expect(body.tools).toContain('sepshn.demo.get_property_summary')
		expect(body.tools).toContain('sepshn.demo.list_recent_demo_bookings')
	})

	test('[MCP7] POST /api/mcp/rpc tools/call с unknown tool name → -32601', async () => {
		const app = mount()
		const res = await app.request('/api/mcp/rpc', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 'x',
				method: 'tools/call',
				params: { name: 'fake.tool' },
			}),
		})
		const body = (await res.json()) as { error: { code: number; message: string } }
		expect(body.error.code).toBe(-32601)
		expect(body.error.message).toContain('Unknown tool')
	})
})
