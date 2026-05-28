/**
 * Round 14 self-review #3 — MCP (Model Context Protocol) server mounted at
 * `/api/mcp/*` per spec `2025-11-25` Streamable HTTP transport.
 *
 * Canon: `project_2026_grade_architecture_canon_2026_05_25.md` §«MCP day-1»
 * — Apaleo (Sep 2025), Hospitable (Apr 2026), SiteMinder (Apr 2026) shipped
 * MCP integrations первыми; Sepshn matches the architectural leapfrog window.
 *
 * **Transport — Streamable HTTP** (spec `2025-11-25` § Transports):
 *   - Single MCP endpoint `/api/mcp/rpc` MUST handle POST + GET.
 *   - POST → JSON-RPC request. Response `application/json` (single object) — we
 *     do NOT yet open SSE streams (single-response shape valid per spec).
 *   - GET → SSE stream OR 405 Method Not Allowed (server doesn't yet offer
 *     server-to-client push; we return 405 per spec backwards-compat clause).
 *   - DELETE → 405 (we don't manage explicit sessions yet).
 *
 * **Spec-MUST clauses enforced** (May 2026):
 *   - `Origin` header validation (DNS rebinding defense) → 403 on invalid.
 *   - `MCP-Protocol-Version` header validation on subsequent requests → 400 on
 *     invalid (spec backwards-compat: assume `2025-03-26` if absent).
 *   - `Accept` header MUST list both `application/json` and `text/event-stream`
 *     on POST per spec — we currently only return `application/json`, so we
 *     accept POSTs that list either one (lenient mode допустим до Streamable
 *     HTTP server-push activation).
 *   - Tool execution errors wrapped в `{ content: [...], isError: true }`
 *     spec result envelope, NOT JSON-RPC `error` envelope.
 *   - `notifications/initialized` accepted (returns HTTP 202 No Content).
 *
 * **Methods implemented**:
 *   - `initialize`               — handshake (protocolVersion + capabilities + serverInfo + instructions)
 *   - `notifications/initialized` — client-ready signal (no response, HTTP 202)
 *   - `tools/list`               — enumerate tools
 *   - `tools/call`               — invoke tool (returns content + isError)
 *
 * **Tools (read-only demo scope + AI proof)**:
 *   - `sepshn.demo.list_demo_routes`           — demo OTA routes (8 routes + showcase)
 *   - `sepshn.demo.get_property_summary`       — fictional 3-star property metadata
 *   - `sepshn.demo.list_recent_demo_bookings`  — last 5 fictional bookings (reserved-test PII)
 *   - `sepshn.ai.generate_property_description` — AI-backed (Yandex AI Studio)
 *     All annotated `readOnlyHint: true` → Claude Desktop skips confirm-prompt.
 *
 * **Auth**: read-only demo scope, unauthenticated в this skeleton. Production
 * Phase-2 wraps c OAuth 2.1 + PKCE + RFC 9728 Protected Resource Metadata
 * (`/.well-known/oauth-protected-resource`) per spec `2025-11-25` §Authorization.
 * Round 14 ships DCR at `/api/oauth/register` — orthogonal route, not yet
 * wired к MCP token validation.
 */

import { Hono } from 'hono'
import type { AppEnv } from '../factory.ts'
import { chatCompletion, readConfigFromEnv } from '../lib/ai/yandex-ai-studio.ts'
import { publicBodyCap } from '../middleware/public-body-cap.ts'
import { extractClientIp } from '../middleware/widget-rate-limit.ts'
import { checkAiRateLimit, MCP_AI_RATE_LIMIT_MESSAGE, mcpRpcRateLimit } from './rate-limit.ts'

// MCP spec version pinned к `2025-11-25` (latest stable May 2026 per canon
// `feedback_aggressive_delegacy`). RC `2026-07-28` adds stateless protocol
// core + MCP Apps + Tasks + OAuth-aligned auth — adopt когда RC promotes к stable.
const MCP_PROTOCOL_VERSION = '2025-11-25'
// Spec backwards-compat clause: «if the server does not receive an MCP-Protocol-Version
// header, it SHOULD assume protocol version 2025-03-26». We accept both 2025-03-26
// и 2025-11-25, и any newer dated version (lexicographic compare keeps future-RC
// adoption frictionless).
const ACCEPTED_PROTOCOL_VERSIONS = new Set(['2025-03-26', '2025-06-18', '2025-11-25'])
const SEPSHN_MCP_SERVER_NAME = 'sepshn-pms'
const SEPSHN_MCP_SERVER_VERSION = '0.1.0'

const SEPSHN_MCP_INSTRUCTIONS =
	'Sepshn PMS+CM (демо). Read-only tools exposing fictional RFC-2606 reserved-test PII only — do NOT request real-tenant data. The `sepshn.ai.*` tool calls Yandex AI Studio with PII shield; sending real guest names/emails/phones will be rejected. All demo data is trademark-safe (no real property names / INNs).'

interface JsonRpcRequest {
	readonly jsonrpc: '2.0'
	readonly id?: string | number | null
	readonly method: string
	readonly params?: unknown
}

interface JsonRpcResponse {
	readonly jsonrpc: '2.0'
	readonly id: string | number | null
	readonly result?: unknown
	readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown }
}

interface ToolAnnotations {
	readonly title?: string
	readonly readOnlyHint?: boolean
	readonly destructiveHint?: boolean
	readonly idempotentHint?: boolean
	readonly openWorldHint?: boolean
}

interface ToolDescriptor {
	readonly name: string
	readonly title?: string
	readonly description: string
	readonly inputSchema: {
		readonly type: 'object'
		readonly properties: Record<string, unknown>
		readonly additionalProperties?: boolean
	}
	readonly outputSchema?: { readonly type: 'object'; readonly properties: Record<string, unknown> }
	readonly annotations?: ToolAnnotations
	readonly handler: (args: unknown) => Promise<{ structured: unknown; isError?: boolean }>
}

const TOOLS: ReadonlyArray<ToolDescriptor> = [
	{
		name: 'sepshn.demo.list_demo_routes',
		title: 'List demo OTA routes',
		description:
			'Lists the demo OTA routes mounted by Sepshn (Yandex + Островок mock servers + showcase). Read-only, zero-arg.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
		async handler() {
			return {
				structured: {
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
						{
							path: '/demo/ota/ostrovok/success/{orderId}',
							kind: 'demo-success',
							brand: 'ostrovok',
						},
						{
							path: '/demo/showcase',
							kind: 'split-pane',
							description: 'OTA + PMS side-by-side',
						},
					],
					notes: [
						'Demo data — RFC 2606 + Россвязь reserved-test PII only',
						'Webhook loop fires CloudEvents 1.0.2 к own /api/channel/webhooks/{channel}',
						'Round 13 canon: MCP day-1 mounted (Apaleo first-mover parity)',
					],
				},
			}
		},
	},
	{
		name: 'sepshn.demo.get_property_summary',
		title: 'Demo property metadata',
		description:
			'Returns demo property metadata (Sepshn-демо in Sochi). Read-only, zero-arg, no PII. Useful для AI agents demonstrating «hotel listing» search use case.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
		async handler() {
			// Round 14.6.4 final-sweep (2026-05-29) — slug renamed `demo-hotel-sochi`
			// → `sepshn-fictional-demo` to remove last visible carbon copy of the
			// legacy `LEGACY_DEMO_PROPERTY_ID` literal. MCP tool returns FICTIONAL
			// demo metadata for AI-agent discovery; the slug must never collide
			// с real or anonymous-fallback tenant identity. Disambiguates from
			// `demoprop_<orgId>` (per-tenant synthetic) и `LEGACY_DEMO_PROPERTY_ID`
			// (anonymous-fallback carve-out в `app.ts`). Empirically caught
			// adversarial-audit 2026-05-29 — see `feedback_systematic_halfmeasure_pattern_2026_05_28`.
			return {
				structured: {
					property: {
						id: 'sepshn-fictional-demo',
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
						'`id` is FICTIONAL (`sepshn-fictional-demo`) — does NOT match per-tenant `demoprop_<orgId>` or anonymous-fallback `LEGACY_DEMO_PROPERTY_ID`',
					],
				},
			}
		},
	},
	{
		name: 'sepshn.ai.generate_property_description',
		title: 'Generate property description (Yandex AI Studio)',
		description:
			'Generate a marketing-style property description via Yandex AI Studio (`yandexgpt-lite/latest` default, configurable via `YANDEX_AI_MODEL`). Args: `{ propertyHint?: string, lengthHint?: "short"|"medium"|"long" }`. Returns `{ text, model, usage }` or `{ isError: true }` with `not_configured`/`rejected`/`error` reason. PII shield rejects real guest names/emails/phones — use reserved-test ranges (RFC 2606 + Россвязь) only.',
		inputSchema: {
			type: 'object',
			properties: {
				propertyHint: {
					type: 'string',
					maxLength: 280,
					description:
						'Optional hint about property style (default: «гостевой дом 3*, Сочи, 0.5 км до пляжа»). Max 280 chars. Must NOT contain real PII (guest names/emails/phones) — outbound shield will reject.',
				},
				lengthHint: {
					type: 'string',
					enum: ['short', 'medium', 'long'],
					default: 'short',
				},
			},
			additionalProperties: false,
		},
		outputSchema: {
			type: 'object',
			properties: {
				kind: { type: 'string', enum: ['ok', 'not_configured', 'rejected', 'error'] },
				text: { type: 'string' },
				model: { type: 'string' },
				usage: {
					type: 'object',
					properties: { inputTokens: { type: 'integer' }, outputTokens: { type: 'integer' } },
				},
			},
		},
		annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: false },
		async handler(args: unknown) {
			const a = (args ?? {}) as {
				propertyHint?: string
				lengthHint?: 'short' | 'medium' | 'long'
			}
			const rawHint = a.propertyHint ?? 'гостевой дом 3*, Сочи, 0.5 км до пляжа, 8 номеров'
			// Hard length cap — token-bomb DoS defense. Spec also has maxLength 280 в
			// inputSchema, but JSON-Schema validation is advisory client-side; enforce
			// here too for safety-in-depth.
			if (rawHint.length > 280) {
				return {
					structured: {
						kind: 'rejected',
						reason: 'prompt_too_long',
						message: 'propertyHint must be ≤ 280 chars',
					},
					isError: true,
				}
			}
			const length = a.lengthHint ?? 'short'
			const tokenCap = length === 'long' ? 500 : length === 'medium' ? 250 : 120
			const result = await chatCompletion(
				{
					messages: [
						{
							role: 'system',
							text: 'Ты — копирайтер отелей. Пиши коротко, на русском, с упором на конкретные удобства и расположение. Без emoji.',
						},
						{ role: 'user', text: `Опиши объект для booking-листинга: ${rawHint}` },
					],
					maxTokens: tokenCap,
				},
				readConfigFromEnv(),
			)
			if (result.kind === 'not_configured') {
				return {
					structured: {
						kind: 'not_configured',
						reason: result.reason,
						configHelp:
							'Set YANDEX_AI_API_KEY + YANDEX_AI_FOLDER_ID env vars (Yandex Cloud Lockbox recommended). Model selectable via YANDEX_AI_MODEL (default `yandexgpt-lite/latest`; alternatives: `yandexgpt/latest`, `aliceai-llm`, `qwen3-235b-a22b-fp8`, `qwen3.6-35b-a3b`, `deepseek-v32`, `gpt-oss-120b`, `gpt-oss-20b`).',
					},
					isError: true,
				}
			}
			if (result.kind === 'rejected') {
				return {
					structured: { kind: 'rejected', reason: result.reason, message: result.message },
					isError: true,
				}
			}
			if (result.kind === 'error') {
				return {
					structured: { kind: 'error', status: result.status, message: result.message },
					isError: true,
				}
			}
			return {
				structured: {
					kind: 'ok',
					text: result.text,
					model: result.model,
					usage: result.usage,
				},
			}
		},
	},
	{
		name: 'sepshn.demo.list_recent_demo_bookings',
		title: 'Recent demo bookings (fictional)',
		description:
			'Returns last 5 demo bookings (fictional). All names are RFC 2606-reserved-test (Иванов/Петров example.com). Useful для AI agents demonstrating «recent reservations» dashboard use case. Read-only.',
		inputSchema: {
			type: 'object',
			properties: {
				limit: {
					type: 'integer',
					description: 'Max bookings to return (default 5, max 10).',
					default: 5,
					minimum: 1,
					maximum: 10,
				},
			},
			additionalProperties: false,
		},
		annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
		async handler(args: unknown) {
			// Defensive NaN guard — `Math.min/max` propagate NaN (empirical:
			// `Math.max(1, NaN) === NaN`), so a caller passing `limit: NaN` would
			// result в `slice(0, NaN) === []` silently zero-result.
			const rawLimit = (args as { limit?: number })?.limit
			const requestedLimit = rawLimit !== undefined && Number.isFinite(rawLimit) ? rawLimit : 5
			const limit = Math.min(10, Math.max(1, requestedLimit))
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
				structured: {
					bookings: demoBookings.slice(0, limit),
					meta: {
						tenant: 'demo-tenant',
						generatedAt: new Date().toISOString(),
						notes: [
							'Fictional data — all guests use RFC 2606 reserved-test emails (@example.com)',
							'Real production tool would require auth + tenant scoping (Phase-2)',
						],
					},
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
	return { jsonrpc: '2.0', id: id ?? null, error: err }
}

function rpcResult(id: JsonRpcRequest['id'], result: unknown): JsonRpcResponse {
	return { jsonrpc: '2.0', id: id ?? null, result }
}

/** Origin allow-list для DNS-rebinding defense (spec MUST §Security Warning).
 * Empty / missing `Origin` is allowed (non-browser tools — curl / SDKs). */
const ALLOWED_ORIGINS = new Set([
	'http://localhost:3000',
	'http://localhost:5173',
	'http://127.0.0.1:3000',
	'http://127.0.0.1:5173',
	'https://demo.sepshn.ru',
	'https://app.sepshn.ru',
	'https://sepshn.ru',
	'https://www.sepshn.ru',
])

const CORS_ALLOW_HEADERS = 'Content-Type, MCP-Protocol-Version, Accept, MCP-Session-Id'
const CORS_ALLOW_METHODS = 'POST, GET, DELETE, OPTIONS'
const CORS_MAX_AGE = '600'

function isAllowedOrigin(origin: string | undefined | null): boolean {
	if (origin === undefined || origin === null || origin === '') return true
	return ALLOWED_ORIGINS.has(origin)
}

interface ToolCallResultEnvelope {
	readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>
	readonly structuredContent?: unknown
	readonly isError?: boolean
}

async function handleRpc(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
	switch (req.method) {
		case 'initialize':
			return rpcResult(req.id, {
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: {
					tools: { listChanged: false },
				},
				serverInfo: {
					name: SEPSHN_MCP_SERVER_NAME,
					title: 'Sepshn PMS+CM (демо)',
					version: SEPSHN_MCP_SERVER_VERSION,
				},
				instructions: SEPSHN_MCP_INSTRUCTIONS,
			})
		case 'notifications/initialized':
			// Spec MUST: response is HTTP 202 No Content. Returning `null` signals the
			// route handler к short-circuit с 202 — JSON-RPC notifications (no `id`)
			// MUST NOT produce a JSON-RPC response.
			return null
		case 'tools/list':
			return rpcResult(req.id, {
				tools: TOOLS.map((t) => ({
					name: t.name,
					...(t.title !== undefined && { title: t.title }),
					description: t.description,
					inputSchema: t.inputSchema,
					...(t.outputSchema !== undefined && { outputSchema: t.outputSchema }),
					...(t.annotations !== undefined && { annotations: t.annotations }),
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
				const { structured, isError } = await tool.handler(params.arguments)
				const envelope: ToolCallResultEnvelope = {
					content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
					structuredContent: structured,
					...(isError === true && { isError: true }),
				}
				return rpcResult(req.id, envelope)
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e)
				// Spec §Server Tools: «Tool Execution Errors MUST be reported with
				// isError: true in the result». Use JSON-RPC -32603 ONLY для protocol
				// errors, NOT для tool execution errors.
				const envelope: ToolCallResultEnvelope = {
					content: [{ type: 'text', text: `Tool execution failed: ${msg}` }],
					isError: true,
				}
				return rpcResult(req.id, envelope)
			}
		}
		default:
			return rpcError(req.id, -32601, `Method not found: ${req.method}`)
	}
}

function isNotification(method: string): boolean {
	return method.startsWith('notifications/')
}

export function createMcpRoutes() {
	const app = new Hono<AppEnv>()

	// Round 14.6.4 adversarial-sweep #5 (2026-05-29) — MCP JSON-RPC endpoint
	// publicly reachable per spec (no auth gate в transport layer; auth happens
	// at tool-call level for sensitive tools). Без cap → JSON-bomb DoS на MCP
	// agent traffic. Typical RPC request < 8 KB; 64 KB ≫ realistic envelopes.
	app.use('/*', publicBodyCap())

	// Apply rate-limit на все RPC traffic + extra stricter limit для sepshn.ai.*
	// tools-call branch. Middleware ordering: broad RPC limit first → tool-name
	// inspection happens inside handler, AI-specific limit applied к request
	// after JSON parse via inner check.
	app.use('/rpc', mcpRpcRateLimit)

	app.post('/rpc', async (c) => {
		// Origin validation (DNS rebinding defense) — spec MUST.
		const origin = c.req.header('Origin') ?? c.req.header('origin')
		if (!isAllowedOrigin(origin)) {
			return c.json(rpcError(null, -32000, `Forbidden — origin not allowed: ${origin}`), 403)
		}
		// Accept header check — spec says client MUST list both application/json AND
		// text/event-stream. We're lenient: either is fine because server only
		// returns application/json today (no SSE push yet).
		const accept = c.req.header('Accept') ?? c.req.header('accept') ?? ''
		if (
			accept !== '' &&
			!accept.includes('application/json') &&
			!accept.includes('text/event-stream') &&
			!accept.includes('*/*')
		) {
			return c.json(rpcError(null, -32000, 'Not Acceptable — must accept application/json'), 406)
		}
		// MCP-Protocol-Version header validation. Spec MUST: if header present AND
		// unsupported → 400 Bad Request. Absent header → assume 2025-03-26 (spec
		// backwards-compat).
		const protoHeader = c.req.header('MCP-Protocol-Version') ?? c.req.header('mcp-protocol-version')
		if (protoHeader !== undefined && !ACCEPTED_PROTOCOL_VERSIONS.has(protoHeader)) {
			return c.json(
				rpcError(null, -32000, `Unsupported MCP-Protocol-Version: ${protoHeader}`, {
					supported: Array.from(ACCEPTED_PROTOCOL_VERSIONS).sort(),
				}),
				400,
			)
		}
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
		// Extra rate-limit на AI tool calls — cost runaway defense. Anyone hitting
		// `/api/mcp/rpc` с `tools/call name=sepshn.ai.*` triggers strict bucket
		// (10 calls / 5min / IP). Inlined here AFTER body parse so we can read
		// method + tool name; middleware can't peek into JSON body without
		// consuming the request stream.
		if (body.method === 'tools/call') {
			const callParams = body.params as { name?: string } | undefined
			if (typeof callParams?.name === 'string' && callParams.name.startsWith('sepshn.ai.')) {
				const ip = extractClientIp(c)
				const limitResult = checkAiRateLimit(ip)
				if (!limitResult.allowed) {
					const retrySec = Math.ceil(limitResult.resetMs / 1000)
					c.header('RateLimit-Limit', String(limitResult.limit))
					c.header('RateLimit-Remaining', '0')
					c.header('RateLimit-Reset', String(retrySec))
					c.header('Retry-After', String(retrySec))
					return c.json(MCP_AI_RATE_LIMIT_MESSAGE, 429)
				}
			}
		}
		const response = await handleRpc(body)
		// Notifications (e.g. `notifications/initialized`) → HTTP 202 Accepted, no body.
		if (response === null || (body.id === undefined && isNotification(body.method))) {
			return c.body(null, 202)
		}
		return c.json(response)
	})

	// CORS preflight (OPTIONS) — browser-based MCP clients (web-Claude alternates)
	// preflight cross-origin POSTs. Without this handler, preflight 404s → POST
	// never sent. Origin validation still applies; invalid origin → no CORS
	// headers returned (browser blocks). Allowed origin → 204 с full CORS hdrs.
	app.options('/rpc', (c) => {
		const origin = c.req.header('Origin') ?? c.req.header('origin')
		if (origin !== undefined && origin !== '' && !isAllowedOrigin(origin)) {
			return c.body(null, 204) // No CORS headers → browser blocks
		}
		const headers: Record<string, string> = {
			'Access-Control-Allow-Methods': CORS_ALLOW_METHODS,
			'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
			'Access-Control-Max-Age': CORS_MAX_AGE,
		}
		if (origin !== undefined && origin !== '') headers['Access-Control-Allow-Origin'] = origin
		return c.body(null, 204, headers)
	})

	// Spec §Streamable HTTP «Listening for Messages from the Server»: server MUST
	// either return text/event-stream OR 405 Method Not Allowed for GET. We
	// return 405 — we don't yet open server-to-client SSE streams (no need until
	// tool list mutates or background notifications fire).
	app.get('/rpc', (c) =>
		c.body('Method Not Allowed — Sepshn MCP does not expose server-initiated SSE', 405),
	)

	// DELETE → 405 (we don't manage explicit MCP sessions yet — no MCP-Session-Id
	// returned on initialize, so clients won't send DELETE; but spec allows).
	app.delete('/rpc', (c) => c.body('Method Not Allowed — no session management', 405))

	// Sales-surface discovery (NON-spec — Sepshn convenience endpoint).
	// The canonical MCP discovery is `initialize` itself; this endpoint helps
	// integration partners locate the server без MCP client handshake.
	app.get('/manifest', (c) =>
		c.json({
			name: SEPSHN_MCP_SERVER_NAME,
			title: 'Sepshn PMS+CM (демо)',
			version: SEPSHN_MCP_SERVER_VERSION,
			protocolVersion: MCP_PROTOCOL_VERSION,
			transport: 'streamable-http',
			endpoints: {
				rpc: '/api/mcp/rpc',
				manifest: '/api/mcp/manifest',
			},
			capabilities: ['tools/list', 'tools/call', 'notifications/initialized'],
			tools: TOOLS.map((t) => t.name),
			docs: 'https://demo.sepshn.ru/api/docs',
			notes: [
				'Manifest is a Sepshn sales-surface — NOT canonical MCP discovery (use `initialize`)',
				'Transport: Streamable HTTP per MCP spec 2025-11-25',
				'AI-backed tools (`sepshn.ai.*`) require YANDEX_AI_API_KEY + YANDEX_AI_FOLDER_ID env vars',
			],
		}),
	)

	return app
}
