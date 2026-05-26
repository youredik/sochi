/**
 * Round 13 — MCP (Model Context Protocol) server skeleton mounted at `/api/mcp/*`.
 *
 * Canon: `project_2026_grade_architecture_canon_2026_05_25.md` §«MCP day-1»
 * — Apaleo (Sep 2025), Hospitable (Apr 2026), SiteMinder (Apr 2026) shipped
 * MCP integrations первыми; Sepshn matches the architectural leapfrog window.
 *
 * **Scope (skeleton)** — JSON-RPC 2.0 over HTTP per MCP transport spec:
 *   - `POST /api/mcp/rpc`     — JSON-RPC 2.0 endpoint
 *   - `GET  /api/mcp/manifest` — capabilities discovery (non-spec, sales surface)
 *
 * **Methods implemented**:
 *   - `initialize`      — MCP handshake (protocolVersion, capabilities)
 *   - `tools/list`      — enumerate available tools
 *   - `tools/call`      — invoke tool by name (1 read-only tool в skeleton)
 *
 * **Tools (v1 = 1 read-only proof)**:
 *   - `sepshn.demo.list_demo_routes` — lists the 8 demo OTA routes + showcase.
 *     Zero-arg, no PII, idempotent. Proves the MCP wire works end-to-end.
 *     Future Phase-2: `search-properties`, `view-booking`, `create-booking`
 *     wired через existing domain services с 152-ФЗ PII-redaction.
 *
 * **Security**:
 *   - Unauthenticated в Round 13 scope (read-only demo data).
 *   - Phase-2 wraps c X-Sepshn-MCP-Token or RFC 7591 DCR-issued bearer.
 *   - Each tool call MUST be wrapped with PII-redaction transformer pre-return
 *     (canon `feedback_outbound_side_effect_discipline`).
 */

import { Hono } from 'hono'
import type { AppEnv } from '../factory.ts'
import { chatCompletion, readConfigFromEnv } from '../lib/ai/yandex-ai-studio.ts'

// MCP spec version pinned к `2025-11-25` (latest stable May 2026 per canon
// `feedback_aggressive_delegacy`). RC `2026-07-28` adds stateless protocol
// core + MCP Apps + Tasks + OAuth-aligned auth — adopt когда RC promotes к stable.
const MCP_PROTOCOL_VERSION = '2025-11-25'
const SEPSHN_MCP_SERVER_NAME = 'sepshn-pms'
const SEPSHN_MCP_SERVER_VERSION = '0.1.0'

interface JsonRpcRequest {
	readonly jsonrpc: '2.0'
	readonly id: string | number | null
	readonly method: string
	readonly params?: unknown
}

interface JsonRpcResponse {
	readonly jsonrpc: '2.0'
	readonly id: string | number | null
	readonly result?: unknown
	readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown }
}

interface ToolDescriptor {
	readonly name: string
	readonly description: string
	readonly inputSchema: { readonly type: 'object'; readonly properties: Record<string, unknown> }
	readonly handler: (args: unknown) => Promise<unknown>
}

const TOOLS: ReadonlyArray<ToolDescriptor> = [
	{
		name: 'sepshn.demo.list_demo_routes',
		description:
			'Lists the demo OTA routes mounted by Sepshn (Yandex + Островок mock servers + showcase). Read-only, zero-arg.',
		inputSchema: {
			type: 'object',
			properties: {},
		},
		async handler() {
			return {
				routes: [
					{ path: '/demo', kind: 'index', description: 'Tile-based demo landing' },
					{ path: '/demo/ota/yandex', kind: 'demo-ota', brand: 'yandex' },
					{
						path: '/demo/ota/yandex/property/{hotelId}',
						kind: 'demo-property',
						brand: 'yandex',
					},
					{
						path: '/demo/ota/yandex/booking/{bookingToken}',
						kind: 'demo-booking',
						brand: 'yandex',
					},
					{ path: '/demo/ota/yandex/success/{orderId}', kind: 'demo-success', brand: 'yandex' },
					{ path: '/demo/ota/ostrovok', kind: 'demo-ota', brand: 'ostrovok' },
					{
						path: '/demo/ota/ostrovok/property/{hid}',
						kind: 'demo-property',
						brand: 'ostrovok',
					},
					{
						path: '/demo/ota/ostrovok/booking/{partnerOrderId}',
						kind: 'demo-booking',
						brand: 'ostrovok',
					},
					{ path: '/demo/ota/ostrovok/success/{orderId}', kind: 'demo-success', brand: 'ostrovok' },
					{ path: '/demo/showcase', kind: 'split-pane', description: 'OTA + PMS side-by-side' },
				],
				notes: [
					'Demo data — RFC 2606 + Россвязь reserved-test PII only',
					'Webhook loop fires CloudEvents 1.0.2 к own /api/channel/webhooks/{channel}',
					'Round 13 canon: MCP day-1 mounted (Apaleo first-mover parity)',
				],
			}
		},
	},
	{
		name: 'sepshn.demo.get_property_summary',
		description:
			'Returns demo property metadata (Sepshn-демо in Sochi). Read-only, zero-arg, no PII. Useful для AI agents demonstrating «hotel listing» search use case.',
		inputSchema: {
			type: 'object',
			properties: {},
		},
		async handler() {
			return {
				property: {
					id: 'demo-hotel-sochi',
					name: 'Гостевой дом «Сэпшн-демо» в Сочи',
					starRating: 3,
					address: {
						country: 'RU',
						city: 'Сочи',
						region: 'Краснодарский край',
					},
					amenities: ['Wi-Fi бесплатно', 'Завтрак включён', 'Парковка', 'Кондиционер'],
					numberOfRooms: 8,
					priceRangeRubPerNight: { min: 6000, max: 14000 },
					channelIds: ['YT', 'ETG'],
				},
				notes: [
					'Demo / trademark-safe — fictional property, не real Sochi hotel',
					'JSON-LD schema rendered на /demo/ota/{brand}/property/{id} (Lake.com canon)',
				],
			}
		},
	},
	{
		name: 'sepshn.ai.generate_property_description',
		description:
			'Generate a marketing-style property description via Yandex AI Studio (`yandexgpt-lite` default, configurable via `YANDEX_AI_MODEL`). Args: `{ propertyHint?: string, lengthHint?: "short"|"medium"|"long" }`. Returns `{ text, model, tokensUsed }` or `not_configured` if `YANDEX_AI_API_KEY` env not set. Replaces «multi-day external blocker» Round 13 framing — Yandex AI Studio OpenAI-compat REST endpoint, без on-prem GPU.',
		inputSchema: {
			type: 'object',
			properties: {
				propertyHint: {
					type: 'string',
					description:
						'Optional hint about property style (default: «гостевой дом 3*, Сочи, 0.5 км до пляжа»)',
				},
				lengthHint: {
					type: 'string',
					enum: ['short', 'medium', 'long'],
					default: 'short',
				},
			},
		},
		async handler(args: unknown) {
			const a = (args ?? {}) as { propertyHint?: string; lengthHint?: 'short' | 'medium' | 'long' }
			const hint = a.propertyHint ?? 'гостевой дом 3*, Сочи, 0.5 км до пляжа, 8 номеров'
			const length = a.lengthHint ?? 'short'
			const tokenCap = length === 'long' ? 500 : length === 'medium' ? 250 : 120
			const result = await chatCompletion(
				{
					messages: [
						{
							role: 'system',
							text: 'Ты — копирайтер отелей. Пиши коротко, на русском, с упором на конкретные удобства и расположение. Без emoji.',
						},
						{
							role: 'user',
							text: `Опиши объект для booking-листинга: ${hint}`,
						},
					],
					maxTokens: tokenCap,
				},
				readConfigFromEnv(),
			)
			if (result.kind === 'not_configured') {
				return {
					kind: 'not_configured',
					reason: result.reason,
					configHelp:
						'Set YANDEX_AI_API_KEY + YANDEX_AI_FOLDER_ID env vars (Yandex Cloud Lockbox recommended in production). Model selectable via YANDEX_AI_MODEL (default `yandexgpt-lite/latest`; alternatives: `yandexgpt/latest`, `alice-ai-llm/latest`, `qwen-3/latest`, `deepseek-v3/latest`).',
				}
			}
			if (result.kind === 'error') {
				return {
					kind: 'error',
					status: result.status,
					message: result.message,
				}
			}
			return {
				kind: 'ok',
				text: result.text,
				usage: result.usage,
			}
		},
	},
	{
		name: 'sepshn.demo.list_recent_demo_bookings',
		description:
			'Returns last 5 demo bookings (fictional). All names are RFC 2606-reserved-test (Иванов/Петров example.com). Useful для AI agents demonstrating «recent reservations» dashboard use case. Read-only.',
		inputSchema: {
			type: 'object',
			properties: {
				limit: {
					type: 'integer',
					description: 'Max bookings to return (default 5, max 10).',
					default: 5,
				},
			},
		},
		async handler(args: unknown) {
			const limit = Math.min(10, Math.max(1, (args as { limit?: number })?.limit ?? 5))
			// Synthetic fictional data — no real-tenant data. PII shape is reserved-test ranges.
			const demoBookings = [
				{
					bookingId: 'demo-bk-001',
					channelId: 'YT',
					guest: { firstName: 'Иван', lastName: 'Иванов', email: 'ivan@example.com' },
					checkIn: '2027-08-15',
					checkOut: '2027-08-17',
					totalRub: 12000,
					status: 'confirmed',
				},
				{
					bookingId: 'demo-bk-002',
					channelId: 'ETG',
					guest: { firstName: 'Пётр', lastName: 'Петров', email: 'petr@example.com' },
					checkIn: '2027-08-18',
					checkOut: '2027-08-20',
					totalRub: 14000,
					status: 'confirmed',
				},
				{
					bookingId: 'demo-bk-003',
					channelId: 'YT',
					guest: { firstName: 'Анна', lastName: 'Сидорова', email: 'anna@example.com' },
					checkIn: '2027-08-22',
					checkOut: '2027-08-25',
					totalRub: 21000,
					status: 'pending',
				},
				{
					bookingId: 'demo-bk-004',
					channelId: 'TL',
					guest: { firstName: 'Сергей', lastName: 'Кузнецов', email: 'sergey@example.com' },
					checkIn: '2027-09-01',
					checkOut: '2027-09-03',
					totalRub: 13000,
					status: 'confirmed',
				},
				{
					bookingId: 'demo-bk-005',
					channelId: 'ETG',
					guest: { firstName: 'Елена', lastName: 'Смирнова', email: 'elena@example.com' },
					checkIn: '2027-09-10',
					checkOut: '2027-09-12',
					totalRub: 14000,
					status: 'cancelled',
				},
			]
			return {
				bookings: demoBookings.slice(0, limit),
				meta: {
					tenant: 'demo-tenant',
					generatedAt: new Date().toISOString(),
					notes: [
						'Fictional data — all guests use RFC 2606 reserved-test emails (@example.com)',
						'Real production tool would require auth + tenant scoping (Phase-2)',
					],
				},
			}
		},
	},
]

function rpcError(
	id: JsonRpcRequest['id'],
	code: number,
	message: string,
	data?: unknown,
): JsonRpcResponse {
	const err: { code: number; message: string; data?: unknown } = { code, message }
	if (data !== undefined) err.data = data
	return { jsonrpc: '2.0', id, error: err }
}

function rpcResult(id: JsonRpcRequest['id'], result: unknown): JsonRpcResponse {
	return { jsonrpc: '2.0', id, result }
}

async function handleRpc(req: JsonRpcRequest): Promise<JsonRpcResponse> {
	switch (req.method) {
		case 'initialize':
			return rpcResult(req.id, {
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: {
					tools: { listChanged: false },
				},
				serverInfo: {
					name: SEPSHN_MCP_SERVER_NAME,
					version: SEPSHN_MCP_SERVER_VERSION,
				},
			})
		case 'tools/list':
			return rpcResult(req.id, {
				tools: TOOLS.map((t) => ({
					name: t.name,
					description: t.description,
					inputSchema: t.inputSchema,
				})),
			})
		case 'tools/call': {
			const params = req.params as { name?: string; arguments?: unknown } | undefined
			if (params === undefined || typeof params.name !== 'string') {
				return rpcError(req.id, -32602, 'Invalid params — `name` required (string)')
			}
			const tool = TOOLS.find((t) => t.name === params.name)
			if (tool === undefined) {
				return rpcError(req.id, -32601, `Unknown tool: ${params.name}`)
			}
			try {
				const result = await tool.handler(params.arguments)
				return rpcResult(req.id, {
					content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
				})
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e)
				return rpcError(req.id, -32603, `Tool handler error: ${msg}`)
			}
		}
		default:
			return rpcError(req.id, -32601, `Method not found: ${req.method}`)
	}
}

export function createMcpRoutes() {
	const app = new Hono<AppEnv>()

	app.post('/rpc', async (c) => {
		let body: JsonRpcRequest
		try {
			body = (await c.req.json()) as JsonRpcRequest
		} catch {
			return c.json(rpcError(null, -32700, 'Parse error — invalid JSON'), 400)
		}
		if (body.jsonrpc !== '2.0') {
			return c.json(
				rpcError(body.id ?? null, -32600, 'Invalid Request — jsonrpc must be "2.0"'),
				400,
			)
		}
		const response = await handleRpc(body)
		return c.json(response)
	})

	app.get('/manifest', (c) =>
		c.json({
			name: SEPSHN_MCP_SERVER_NAME,
			version: SEPSHN_MCP_SERVER_VERSION,
			protocolVersion: MCP_PROTOCOL_VERSION,
			transport: 'http+json-rpc',
			endpoints: {
				rpc: '/api/mcp/rpc',
				manifest: '/api/mcp/manifest',
			},
			capabilities: ['tools/list', 'tools/call'],
			tools: TOOLS.map((t) => t.name),
			docs: 'https://demo.sepshn.ru/api/docs',
		}),
	)

	return app
}
