/**
 * Round 13 — OpenAPI 3.1 spec for Sepshn public + integration surface.
 *
 * Canon: `project_2026_grade_architecture_canon_2026_05_25.md` §«OpenAPI 3.1
 * source of truth» day-1 must-have. Round 12 P1 deferred — Round 13 closes.
 *
 * **Scope (v1)** — public/integration routes that 3rd-party developers actually
 * call: channel webhooks (CloudEvents inbound), demo OTA mock-server, ops
 * health/readiness. Internal SPA-backing routes (`/api/booking/*` etc.) are
 * NOT covered — those are first-party + change frequently. OpenAPI sweet spot
 * = stable contract surface.
 *
 * **Maintenance pattern**: manual edit when a public route signature changes.
 * Future P2 — generate via `hono-openapi` / `@asteasolutions/zod-to-openapi`
 * if route count grows beyond hand-maintenance threshold (~20 routes). For
 * Round 13 scope (~10 routes), manual gives tighter docs + zero new deps.
 */

export const SEPSHN_OPENAPI_SPEC = {
	openapi: '3.1.0',
	info: {
		title: 'Sepshn — Integration API',
		description:
			'РФ-ориентированная PMS + Channel Manager для МСП посуточной аренды. Эта спецификация описывает публичные точки интеграции для каналов-партнёров (Yandex.Путешествия, Островок, TravelLine) + demo mock-OTA сервер.',
		version: '1.0.0',
		contact: {
			name: 'Sepshn Engineering',
			url: 'https://demo.sepshn.ru',
		},
		license: {
			name: 'Proprietary',
		},
	},
	servers: [
		{
			url: 'https://demo.sepshn.ru',
			description: 'Always-on демонстрационный сервер (`APP_MODE=sandbox`)',
		},
		{
			url: 'http://localhost:8787',
			description: 'Local dev (backend dev script)',
		},
	],
	tags: [
		{
			name: 'Channel Webhooks',
			description:
				'Inbound CloudEvents v1.0.2 webhooks от партнёров (Yandex Travel, Островок ETG, TravelLine). HMAC-SHA256 signature verify via Standard Webhooks protocol.',
		},
		{
			name: 'Demo OTA (mock)',
			description:
				'Demo OTA mock-server для sales-демо. Mounted при `APP_MODE !== production`. Reserved-test-PII только (RFC 2606 / Россвязь test-block).',
		},
		{
			name: 'Demo Admin',
			description: 'Demo state control endpoints (reset / seed / trigger). Session-token gate.',
		},
		{
			name: 'Health',
			description: 'Health + readiness probes (Yandex Cloud Containers + K8s parity).',
		},
		{
			name: 'OAuth (DCR)',
			description:
				'RFC 7591 Dynamic Client Registration — integration partners self-register without manual ops ticket.',
		},
		{
			name: 'MCP',
			description:
				'Model Context Protocol server (Apaleo Sep 2025 first-mover canon). JSON-RPC 2.0 over HTTP для AI agent integration.',
		},
	],
	paths: {
		'/health': {
			get: {
				tags: ['Health'],
				summary: 'Service health probe',
				description: 'Liveness check — returns 200 если процесс отвечает.',
				responses: {
					'200': {
						description: 'Service alive',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										status: { type: 'string', example: 'ok' },
										service: { type: 'string', example: 'sochi-horeca' },
										version: { type: 'string', example: '0.0.1' },
										time: { type: 'string', format: 'date-time' },
									},
									required: ['status', 'service', 'version', 'time'],
								},
							},
						},
					},
				},
			},
		},
		'/api/channel/webhooks/{channelId}': {
			post: {
				tags: ['Channel Webhooks'],
				summary: 'Inbound webhook from channel partner',
				description:
					'Принимает Standard Webhooks-подписанный CloudEvents v1.0.2 envelope. Verifies signature (multi-kid candidate list) + cross-tenant binding (Round 11 P1-B3) + per-resource sequence monotonicity + idempotency на (source, eventId).',
				parameters: [
					{
						name: 'channelId',
						in: 'path',
						required: true,
						schema: { type: 'string', enum: ['YT', 'ETG', 'TL', 'YK'] },
						description: 'Channel identifier (YT=Yandex, ETG=Островок, TL=TravelLine, YK=ЮKassa)',
					},
					{
						name: 'webhook-id',
						in: 'header',
						required: true,
						schema: { type: 'string' },
						description: 'Standard Webhooks msg ID',
					},
					{
						name: 'webhook-timestamp',
						in: 'header',
						required: true,
						schema: { type: 'string' },
						description: 'Unix seconds — must be within 5min replay window',
					},
					{
						name: 'webhook-signature',
						in: 'header',
						required: true,
						schema: { type: 'string', example: 'v1,abc...' },
						description:
							'Comma-separated `v1,<base64>` signatures (rotation-friendly multi-secret)',
					},
				],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: { $ref: '#/components/schemas/CloudEventEnvelope' },
						},
					},
				},
				responses: {
					'200': {
						description:
							'Accepted OR duplicate (idempotent — same eventId returns cached response)',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										accepted: { type: 'boolean' },
										eventId: { type: 'string' },
										duplicate: { type: 'boolean' },
									},
									required: ['accepted', 'eventId'],
								},
							},
						},
					},
					'400': {
						description:
							'malformed_json | malformed_envelope | malformed_source | missing_* | channel_mismatch | tampered_replay',
					},
					'401': {
						description: 'invalid_signature | no_matching_secret | ip_not_allowed',
					},
					'403': {
						description:
							'replay_window_exceeded | forbidden_tenant_for_channel | webhook_secret_tenant_mismatch',
					},
					'500': {
						description: 'handler_failed (downstream — retry-friendly response)',
					},
				},
			},
		},
		'/api/_mock-ota/yandex/v1/hotels/hotel/offers': {
			get: {
				tags: ['Demo OTA (mock)'],
				summary: 'Yandex demo: search availability',
				description:
					'Returns mock offer with booking_token. Mock auth — any non-empty `Authorization` header.',
				parameters: [
					{
						name: 'hotelId',
						in: 'query',
						required: true,
						schema: { type: 'string', example: 'demo-hotel-sochi' },
					},
					{
						name: 'checkinDate',
						in: 'query',
						required: true,
						schema: { type: 'string', format: 'date' },
					},
					{
						name: 'checkoutDate',
						in: 'query',
						required: true,
						schema: { type: 'string', format: 'date' },
					},
					{ name: 'adults', in: 'query', required: true, schema: { type: 'integer', minimum: 1 } },
					{ name: 'children', in: 'query', schema: { type: 'integer', minimum: 0 } },
				],
				responses: {
					'200': {
						description: 'Single demo offer with booking_token (single-use, 30min TTL)',
						content: {
							'application/json': {
								schema: { $ref: '#/components/schemas/YandexOffersResponse' },
							},
						},
					},
					'400': { description: 'missing_hotel_id | invalid_date_range | invalid_party_size' },
					'401': { description: 'unauthorized (missing Authorization header)' },
				},
			},
		},
		'/api/_mock-ota/yandex/v1/hotels/booking/orders': {
			post: {
				tags: ['Demo OTA (mock)'],
				summary: 'Yandex demo: create order',
				description:
					'Consumes booking_token + reserved-test PII (RFC 2606 emails + Россвязь phones). Fires CloudEvents webhook к own backend before responding.',
				responses: {
					'200': {
						description: 'Order created + webhook delivered',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										order_id: { type: 'string', example: 'yt-order-abc123' },
										status: { type: 'string', example: 'CONFIRMED' },
									},
								},
							},
						},
					},
					'422': {
						description:
							'non_reserved_demo_data — caller provided non-reserved-test email or phone (152-ФЗ legal cover canon)',
					},
				},
			},
		},
		'/api/_mock-ota/ostrovok/v1/search/hp/': {
			post: {
				tags: ['Demo OTA (mock)'],
				summary: 'Островок demo: search hotel offers (ETG-style)',
				description:
					'POST с `{hid, checkin, checkout, adults, children, ...}` body. Returns hotel + rates. Mock Auth: `Basic ZGVtbzpkZW1v` (base64 demo:demo).',
				responses: {
					'200': {
						description: 'Hotel offers',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										status: { type: 'string', const: 'ok' },
										data: {
											type: 'object',
											properties: {
												hotels: { type: 'array' },
											},
										},
									},
								},
							},
						},
					},
				},
			},
		},
		'/api/_mock-ota/ostrovok/v1/hotel/order/booking/form/': {
			post: {
				tags: ['Demo OTA (mock)'],
				summary: 'Островок demo: prebook stage (ETG form)',
				description: 'Stage 2 of 5-stage ETG flow. Requires `partner_order_id` UUIDv4.',
				responses: {
					'200': { description: 'order_id + payment_types' },
					'400': { description: 'invalid_partner_order_id (must be UUIDv4)' },
				},
			},
		},
		'/api/_mock-ota/ostrovok/v1/hotel/order/booking/finish/': {
			post: {
				tags: ['Demo OTA (mock)'],
				summary: 'Островок demo: finish booking (ETG)',
				description: 'Stage 3 of 5-stage ETG flow. Fires CloudEvents webhook before returning.',
				responses: {
					'200': { description: 'ok + null data' },
					'422': { description: 'non_reserved_demo_data' },
				},
			},
		},
		'/api/_mock-ota/admin/reset': {
			post: {
				tags: ['Demo Admin'],
				summary: 'Reset Yandex + Островок in-memory mock state',
				description: 'Idempotent — multiple calls OK. Session-token гate active в prod-mode.',
				parameters: [
					{
						name: 'X-Demo-Session-Token',
						in: 'header',
						schema: { type: 'string' },
						description: 'Per-process random token printed at backend boot',
					},
				],
				responses: {
					'200': {
						description: 'State cleared',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										ok: { type: 'boolean' },
										cleared: {
											type: 'object',
											properties: {
												yandex: { type: 'boolean' },
												ostrovok: { type: 'boolean' },
											},
										},
									},
								},
							},
						},
					},
					'401': { description: 'UNAUTHORIZED — X-Demo-Session-Token mismatch' },
				},
			},
		},
		'/api/_mock-ota/admin/seed': {
			post: {
				tags: ['Demo Admin'],
				summary: 'Pre-populate demo с canonical fixture data',
				responses: {
					'200': { description: 'Property descriptor + 3 availability dates' },
					'401': { description: 'UNAUTHORIZED' },
				},
			},
		},
		'/api/_mock-ota/admin/trigger': {
			post: {
				tags: ['Demo Admin'],
				summary: 'Trigger scenario (overbooking | cancel-late | payment-fail)',
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									scenario: {
										type: 'string',
										enum: ['overbooking', 'cancel-late', 'payment-fail'],
									},
								},
							},
						},
					},
				},
				responses: {
					'200': { description: 'acknowledged' },
					'400': { description: 'invalid_scenario | malformed_json' },
					'401': { description: 'UNAUTHORIZED' },
				},
			},
		},
		'/api/oauth/register': {
			post: {
				tags: ['OAuth (DCR)'],
				summary: 'RFC 7591 Dynamic Client Registration',
				description:
					'Self-register integration client. Returns RFC 7591 §3.2.1 response shape. `contacts` field requires `contacts_consent_152fz: true` flag (152-ФЗ ст.6+ст.18 PII consent).',
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['client_name', 'redirect_uris'],
								properties: {
									client_name: { type: 'string', maxLength: 200 },
									redirect_uris: {
										type: 'array',
										items: { type: 'string', format: 'uri' },
										maxItems: 5,
									},
									grant_types: { type: 'array', items: { type: 'string' } },
									token_endpoint_auth_method: { type: 'string' },
									contacts: { type: 'array', items: { type: 'string', format: 'email' } },
									contacts_consent_152fz: {
										type: 'boolean',
										description:
											'MUST be `true` if `contacts` array non-empty (152-ФЗ informed consent canon)',
									},
								},
							},
						},
					},
				},
				responses: {
					'201': {
						description: 'Registered',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										client_id: { type: 'string', example: 'sclient_abc123' },
										client_secret: { type: 'string', example: 'whsec_dcr_xyz' },
										client_id_issued_at: { type: 'integer' },
										client_secret_expires_at: { type: 'integer' },
										client_name: { type: 'string' },
										redirect_uris: { type: 'array', items: { type: 'string' } },
										grant_types: { type: 'array', items: { type: 'string' } },
										token_endpoint_auth_method: { type: 'string' },
									},
								},
							},
						},
					},
					'400': { description: 'invalid_client_metadata | invalid_redirect_uri' },
					'403': { description: 'reserved client_name | contacts_consent_required' },
				},
			},
		},
		'/api/mcp/manifest': {
			get: {
				tags: ['MCP'],
				summary: 'MCP server manifest (capabilities discovery)',
				responses: {
					'200': {
						description: 'Server metadata + transport + tool names',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										name: { type: 'string' },
										version: { type: 'string' },
										protocolVersion: { type: 'string' },
										transport: { type: 'string', const: 'http+json-rpc' },
										tools: { type: 'array', items: { type: 'string' } },
									},
								},
							},
						},
					},
				},
			},
		},
		'/api/mcp/rpc': {
			post: {
				tags: ['MCP'],
				summary: 'JSON-RPC 2.0 endpoint (initialize | tools/list | tools/call)',
				description:
					'MCP protocol version `2025-03-26`. Supported methods: `initialize`, `tools/list`, `tools/call`. See `/api/mcp/manifest` для available tool names.',
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['jsonrpc', 'method'],
								properties: {
									jsonrpc: { type: 'string', const: '2.0' },
									id: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] },
									method: { type: 'string' },
									params: { type: 'object' },
								},
							},
						},
					},
				},
				responses: {
					'200': { description: 'JSON-RPC response (result OR error)' },
					'400': { description: 'parse error | invalid request' },
				},
			},
		},
	},
	components: {
		schemas: {
			CloudEventEnvelope: {
				type: 'object',
				description:
					'CloudEvents v1.0.2 envelope (`specversion`=«1.0»). `source` URN follows `urn:sochi:channel:{channelCode}:tenant:{organizationId}` shape (Round 10 P1-B1 charset-restricted).',
				required: ['specversion', 'id', 'source', 'type', 'data'],
				properties: {
					specversion: { type: 'string', const: '1.0' },
					id: { type: 'string', description: 'Unique event ID (idempotency key)' },
					source: {
						type: 'string',
						pattern: '^urn:sochi:channel:[A-Za-z0-9_-]{1,64}:tenant:[A-Za-z0-9_-]{1,64}$',
						example: 'urn:sochi:channel:YT:tenant:demo-tenant',
					},
					type: { type: 'string', example: 'app.sochi.channel.booking.created.v1' },
					time: { type: 'string', format: 'date-time' },
					data: { type: 'object', description: 'Event-type-specific payload' },
				},
			},
			YandexOffersResponse: {
				type: 'object',
				properties: {
					offers: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								booking_token: { type: 'string' },
								room_name: { type: 'string' },
								daily_prices: { type: 'array', items: { type: 'integer' } },
								total_price: { type: 'integer' },
								currency: { type: 'string', const: 'RUB' },
								can_send_comment_to_hotel: { type: 'boolean' },
							},
						},
					},
				},
			},
		},
	},
} as const
