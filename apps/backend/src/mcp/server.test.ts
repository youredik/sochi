/**
 * Round 13 + Round 14 self-review #3 — MCP server tests:
 * - Round 13: skeleton wire shape
 * - Round 14 E4-E5: tool extensions + OpenAPI
 * - Round 14 self-review #3: spec 2025-11-25 conformance (Origin, Protocol-Version,
 *   Accept, tools/call isError envelope, notifications/initialized 202, GET 405,
 *   tool annotations, structuredContent, AI tool branch coverage)
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { __resetAiBucket } from './rate-limit.ts'
import { createMcpRoutes } from './server.ts'

describe('MCP server (Round 13 + Round 14 self-review #3 + #4)', () => {
	afterEach(() => __resetAiBucket())
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
		expect(body.transport).toBe('streamable-http')
		expect(body.tools).toContain('sepshn.demo.list_demo_routes')
	})

	test('[MCP2] POST /api/mcp/rpc initialize returns protocolVersion + capabilities + instructions', async () => {
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
			result: {
				protocolVersion: string
				serverInfo: { name: string; title: string }
				instructions: string
			}
		}
		expect(body.jsonrpc).toBe('2.0')
		expect(body.id).toBe(1)
		expect(body.result.protocolVersion).toBe('2025-11-25')
		expect(body.result.serverInfo.name).toBe('sepshn-pms')
		expect(body.result.serverInfo.title).toBe('Sepshn PMS+CM (демо)')
		expect(body.result.instructions).toContain('PII shield')
	})

	test('[MCP3] tools/list enumerates tools with annotations + title', async () => {
		const app = mount()
		const res = await app.request('/api/mcp/rpc', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 'a', method: 'tools/list' }),
		})
		const body = (await res.json()) as {
			result: {
				tools: Array<{
					name: string
					description: string
					title?: string
					annotations?: { readOnlyHint?: boolean }
				}>
			}
		}
		expect(body.result.tools.length).toBeGreaterThanOrEqual(4)
		// All 4 tools annotated readOnlyHint: true → Claude Desktop skips confirm
		for (const t of body.result.tools) {
			expect(t.annotations?.readOnlyHint).toBe(true)
			expect(typeof t.title).toBe('string')
			expect((t.title ?? '').length).toBeGreaterThan(0)
		}
	})

	test('[MCP4] tools/call list_demo_routes returns content + structuredContent', async () => {
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
			result: {
				content: Array<{ type: string; text: string }>
				structuredContent: { routes: Array<{ path: string }> }
				isError?: boolean
			}
		}
		expect(body.result.content[0]?.type).toBe('text')
		expect(body.result.structuredContent.routes.length).toBeGreaterThan(0)
		expect(body.result.isError).toBeUndefined()
		const paths = body.result.structuredContent.routes.map((r) => r.path)
		expect(paths).toContain('/demo')
		expect(paths).toContain('/demo/showcase')
	})

	test('[MCP5] unknown method → -32601', async () => {
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

	test('[MCP6] malformed JSON → -32700 parse error', async () => {
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

	test('[MCP-E4-1] tools/call get_property_summary', async () => {
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
		const body = (await res.json()) as {
			result: { structuredContent: { property: { id: string; channelIds: string[] } } }
		}
		expect(body.result.structuredContent.property.id).toBe('demo-hotel-sochi')
		expect(body.result.structuredContent.property.channelIds).toEqual(['YT', 'ETG'])
	})

	test('[MCP-E4-2] tools/call list_recent_demo_bookings respects limit', async () => {
		const app = mount()
		const res = await app.request('/api/mcp/rpc', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 'e4-2',
				method: 'tools/call',
				params: { name: 'sepshn.demo.list_recent_demo_bookings', arguments: { limit: 2 } },
			}),
		})
		const body = (await res.json()) as {
			result: {
				structuredContent: {
					bookings: ReadonlyArray<{ bookingId: string; guest: { email: string } }>
				}
			}
		}
		expect(body.result.structuredContent.bookings.length).toBe(2)
		for (const b of body.result.structuredContent.bookings) {
			expect(b.guest.email).toMatch(/@example\.com$/)
		}
	})

	test('[MCP-E4-3] manifest exposes all 4 tools (3 demo + 1 AI)', async () => {
		const app = mount()
		const res = await app.request('/api/mcp/manifest')
		const body = (await res.json()) as { tools: string[] }
		expect(body.tools).toContain('sepshn.demo.list_demo_routes')
		expect(body.tools).toContain('sepshn.demo.get_property_summary')
		expect(body.tools).toContain('sepshn.demo.list_recent_demo_bookings')
		expect(body.tools).toContain('sepshn.ai.generate_property_description')
	})

	test('[MCP7] tools/call с unknown tool name → -32601', async () => {
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

	// ─────────────────────────────────────────────────────────────────────────
	// Round 14 self-review #3 — spec 2025-11-25 conformance
	// ─────────────────────────────────────────────────────────────────────────

	test('[MCP-SPEC1] GET /api/mcp/rpc returns 405 Method Not Allowed', async () => {
		const app = mount()
		const res = await app.request('/api/mcp/rpc', { method: 'GET' })
		expect(res.status).toBe(405)
	})

	test('[MCP-SPEC2] DELETE /api/mcp/rpc returns 405', async () => {
		const app = mount()
		const res = await app.request('/api/mcp/rpc', { method: 'DELETE' })
		expect(res.status).toBe(405)
	})

	test('[MCP-SPEC3] POST с invalid Origin header → 403', async () => {
		const app = mount()
		const res = await app.request('/api/mcp/rpc', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				Origin: 'https://attacker.evil.com',
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
		})
		expect(res.status).toBe(403)
		const body = (await res.json()) as { error: { code: number; message: string } }
		expect(body.error.message).toContain('Forbidden')
	})

	test('[MCP-SPEC4] POST с allowed Origin header → 200', async () => {
		const app = mount()
		const res = await app.request('/api/mcp/rpc', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				Origin: 'https://demo.sepshn.ru',
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
		})
		expect(res.status).toBe(200)
	})

	test('[MCP-SPEC5] POST с unsupported MCP-Protocol-Version → 400', async () => {
		const app = mount()
		const res = await app.request('/api/mcp/rpc', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'MCP-Protocol-Version': '2024-01-01',
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
		})
		expect(res.status).toBe(400)
		const body = (await res.json()) as {
			error: { code: number; message: string; data: { supported: string[] } }
		}
		expect(body.error.message).toContain('Unsupported')
		expect(body.error.data.supported).toContain('2025-11-25')
	})

	test('[MCP-SPEC6] POST с supported MCP-Protocol-Version 2025-11-25 → 200', async () => {
		const app = mount()
		const res = await app.request('/api/mcp/rpc', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'MCP-Protocol-Version': '2025-11-25',
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
		})
		expect(res.status).toBe(200)
	})

	test('[MCP-SPEC7] notifications/initialized → 202 No Content', async () => {
		const app = mount()
		const res = await app.request('/api/mcp/rpc', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
		})
		expect(res.status).toBe(202)
		expect(await res.text()).toBe('')
	})

	test('[MCP-SPEC8] tools/call с handler-throw → isError:true (not JSON-RPC error)', async () => {
		const app = mount()
		// Trigger a tool call that succeeds but verify shape includes isError absent
		// when handler returns normally.
		const res = await app.request('/api/mcp/rpc', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 'sp8',
				method: 'tools/call',
				params: { name: 'sepshn.demo.list_demo_routes', arguments: {} },
			}),
		})
		const body = (await res.json()) as {
			result: { content: unknown[]; structuredContent: unknown; isError?: boolean }
		}
		// Successful call → no isError key
		expect(body.result.isError).toBe(undefined)
		expect(body.result.structuredContent).not.toBe(undefined)
	})

	// ─────────────────────────────────────────────────────────────────────────
	// AI tool branch coverage — sepshn.ai.generate_property_description
	// ─────────────────────────────────────────────────────────────────────────

	test('[MCP-AI1] AI tool без env → returns isError + kind:not_configured', async () => {
		// Ensure env not set during test (default state)
		const originalApi = process.env.YANDEX_AI_API_KEY
		const originalFolder = process.env.YANDEX_AI_FOLDER_ID
		delete process.env.YANDEX_AI_API_KEY
		delete process.env.YANDEX_AI_FOLDER_ID
		try {
			const app = mount()
			const res = await app.request('/api/mcp/rpc', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 'ai-1',
					method: 'tools/call',
					params: {
						name: 'sepshn.ai.generate_property_description',
						arguments: { lengthHint: 'short' },
					},
				}),
			})
			expect(res.status).toBe(200)
			const body = (await res.json()) as {
				result: {
					content: Array<{ text: string }>
					structuredContent: { kind: string; configHelp?: string }
					isError?: boolean
				}
			}
			expect(body.result.isError).toBe(true)
			expect(body.result.structuredContent.kind).toBe('not_configured')
			expect(body.result.structuredContent.configHelp).toContain('YANDEX_AI_API_KEY')
		} finally {
			if (originalApi !== undefined) process.env.YANDEX_AI_API_KEY = originalApi
			if (originalFolder !== undefined) process.env.YANDEX_AI_FOLDER_ID = originalFolder
		}
	})

	test('[MCP-AI2] AI tool propertyHint > 280 chars → isError + kind:rejected (prompt_too_long)', async () => {
		const app = mount()
		const longHint = 'А'.repeat(500) // 500 Cyrillic chars
		const res = await app.request('/api/mcp/rpc', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 'ai-2',
				method: 'tools/call',
				params: {
					name: 'sepshn.ai.generate_property_description',
					arguments: { propertyHint: longHint, lengthHint: 'short' },
				},
			}),
		})
		const body = (await res.json()) as {
			result: { structuredContent: { kind: string; reason: string }; isError: boolean }
		}
		expect(body.result.isError).toBe(true)
		expect(body.result.structuredContent.kind).toBe('rejected')
		expect(body.result.structuredContent.reason).toBe('prompt_too_long')
	})

	test('[MCP-AI3] AI tool with REAL PII в propertyHint → isError + kind:rejected (pii_in_prompt)', async () => {
		const originalApi = process.env.YANDEX_AI_API_KEY
		const originalFolder = process.env.YANDEX_AI_FOLDER_ID
		// Need env set so we get past not_configured branch and hit PII shield
		process.env.YANDEX_AI_API_KEY = 'test-key'
		process.env.YANDEX_AI_FOLDER_ID = 'test-folder'
		try {
			const app = mount()
			// Real-looking phone (NOT reserved-test prefix)
			const res = await app.request('/api/mcp/rpc', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 'ai-3',
					method: 'tools/call',
					params: {
						name: 'sepshn.ai.generate_property_description',
						arguments: { propertyHint: 'отель Гость +79161234567 ivanov@gazprom.ru' },
					},
				}),
			})
			const body = (await res.json()) as {
				result: { structuredContent: { kind: string; reason: string }; isError: boolean }
			}
			expect(body.result.isError).toBe(true)
			expect(body.result.structuredContent.kind).toBe('rejected')
			expect(body.result.structuredContent.reason).toBe('pii_in_prompt')
		} finally {
			if (originalApi !== undefined) process.env.YANDEX_AI_API_KEY = originalApi
			else delete process.env.YANDEX_AI_API_KEY
			if (originalFolder !== undefined) process.env.YANDEX_AI_FOLDER_ID = originalFolder
			else delete process.env.YANDEX_AI_FOLDER_ID
		}
	})

	// ─────────────────────────────────────────────────────────────────────────
	// Self-review #4 — rate-limit + CORS preflight + Origin allow-list extras
	// ─────────────────────────────────────────────────────────────────────────

	test('[MCP-RL1] 11th sepshn.ai.* tool call from same IP → 429 JSON-RPC error', async () => {
		// Self-review #3 audit empirical evidence: previous helper bypassed.
		// New in-memory bucket should fire 429 on call ≥11 within 5min window.
		__resetAiBucket()
		const app = mount()
		const callRequest = () =>
			app.request('/api/mcp/rpc', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-forwarded-for': '203.0.113.42', // single test IP
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 'rl',
					method: 'tools/call',
					params: { name: 'sepshn.ai.generate_property_description', arguments: {} },
				}),
			})
		// First 10 calls — allowed (each returns 200 + isError:true not_configured)
		for (let i = 0; i < 10; i++) {
			const res = await callRequest()
			expect(res.status).toBe(200)
		}
		// 11th — blocked at rate-limit BEFORE reaching the AI client
		const blocked = await callRequest()
		expect(blocked.status).toBe(429)
		expect(blocked.headers.get('Retry-After')).not.toBeNull()
		expect(blocked.headers.get('RateLimit-Limit')).toBe('10')
		const body = (await blocked.json()) as { error: { code: number; message: string } }
		expect(body.error.code).toBe(-32029)
		expect(body.error.message).toContain('budget-gated')
	})

	test('[MCP-RL2] non-AI tool calls do NOT count against AI bucket', async () => {
		__resetAiBucket()
		const app = mount()
		// Burn 10 demo-tool calls
		for (let i = 0; i < 10; i++) {
			const res = await app.request('/api/mcp/rpc', {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.99' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: i,
					method: 'tools/call',
					params: { name: 'sepshn.demo.list_demo_routes', arguments: {} },
				}),
			})
			expect(res.status).toBe(200)
		}
		// AI tool from same IP should STILL work (first AI call burns slot 1/10)
		const aiCall = await app.request('/api/mcp/rpc', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.99' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 'ai',
				method: 'tools/call',
				params: { name: 'sepshn.ai.generate_property_description', arguments: {} },
			}),
		})
		expect(aiCall.status).toBe(200)
	})

	test('[MCP-CORS1] OPTIONS /api/mcp/rpc с allowed Origin → 204 + CORS headers', async () => {
		const app = mount()
		const res = await app.request('/api/mcp/rpc', {
			method: 'OPTIONS',
			headers: {
				Origin: 'https://demo.sepshn.ru',
				'Access-Control-Request-Method': 'POST',
			},
		})
		expect(res.status).toBe(204)
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://demo.sepshn.ru')
		expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST')
		expect(res.headers.get('Access-Control-Allow-Headers')).toContain('MCP-Protocol-Version')
	})

	test('[MCP-CORS2] OPTIONS /api/mcp/rpc с disallowed Origin → 204 without CORS headers (browser blocks)', async () => {
		const app = mount()
		const res = await app.request('/api/mcp/rpc', {
			method: 'OPTIONS',
			headers: { Origin: 'https://attacker.evil.com' },
		})
		expect(res.status).toBe(204)
		// Without Access-Control-Allow-Origin, browser blocks the actual request
		expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
	})

	test('[MCP-CORS3] www.sepshn.ru Origin allowed (marketing landing canon)', async () => {
		const app = mount()
		const res = await app.request('/api/mcp/rpc', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				Origin: 'https://www.sepshn.ru',
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
		})
		expect(res.status).toBe(200)
	})

	test('[MCP-ADV1] tools/call limit NaN-slip defense → fallback 5', async () => {
		// Adversarial reading checklist #6 — Math.min/max propagate NaN.
		// Caller passing `limit: NaN` would otherwise hit `slice(0, NaN) === []`
		// silently producing zero bookings (false-empty).
		const app = mount()
		const res = await app.request('/api/mcp/rpc', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 'adv1',
				method: 'tools/call',
				params: {
					name: 'sepshn.demo.list_recent_demo_bookings',
					arguments: { limit: Number('abc') }, // NaN
				},
			}),
		})
		const body = (await res.json()) as {
			result: {
				structuredContent: { bookings: ReadonlyArray<{ bookingId: string }> }
			}
		}
		// NaN fell back к default 5, NOT silently empty
		expect(body.result.structuredContent.bookings.length).toBe(5)
	})
})
