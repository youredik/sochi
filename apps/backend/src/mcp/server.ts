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

const MCP_PROTOCOL_VERSION = '2025-03-26' // latest published spec at време написания
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
			'Lists the demo OTA routes mounted by Sepshn (Yandex + Островок mock servers + showcase). Read-only, zero-arg. Useful для AI agents that want to discover the demo surface programmatically.',
		inputSchema: {
			type: 'object',
			properties: {},
		},
		async handler() {
			return {
				routes: [
					{ path: '/demo', kind: 'index', description: 'Tile-based demo landing' },
					{ path: '/demo/ota/yandex', kind: 'demo-ota', brand: 'yandex' },
					{ path: '/demo/ota/ostrovok', kind: 'demo-ota', brand: 'ostrovok' },
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
