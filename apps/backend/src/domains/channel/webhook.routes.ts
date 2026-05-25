/**
 * Inbound channel webhook routes — M10 / A7.1.fix (D11+D12+D25).
 *
 * Mounted at `/api/channel/webhooks/:channelId` PUBLIC (no auth — webhook
 * sender is the channel itself, not an authenticated user).
 *
 * Pipeline (per request):
 *   1. Read raw body bytes (Hono `c.req.raw.arrayBuffer()`) — MUST be raw,
 *      never parsed-then-restringified (signature verifies opaque bytes).
 *   2. Verify Standard Webhooks signature with multi-key candidate list
 *      (`webhook-secret.repo.ts.listAccepted`).
 *   3. Optional IP allowlist fallback for non-HMAC channels (ЮKassa parity).
 *   4. Parse CloudEvents 1.0.2 envelope.
 *   5. Classify via inbox repo: `accepted` | `duplicate` (return cached 200) |
 *      `tampered` (400, alert-emit).
 *   6. On `accepted` — emit downstream domain event (А7.5 sync orchestrator
 *      consumes); persist responseJson via `inbox.markProcessed`.
 *
 * Failure surface:
 *   - 400: malformed envelope, malformed signature header, tampered replay
 *   - 401: signature verification failed
 *   - 403: replay window exceeded
 *   - 200: accepted OR duplicate (idempotent return)
 *   - 500: unexpected handler error (logged, retry-friendly response)
 */
import { Hono } from 'hono'
import type { AppEnv } from '../../factory.ts'
import type { SochiCloudEvent } from '../../lib/channel-manager/cloud-events.ts'
import { parseCloudEvent } from '../../lib/channel-manager/cloud-events.ts'
import { computeBodyHash } from '../../lib/channel-manager/inbox.ts'
import {
	type SignatureFailure,
	type VerifyResult,
	verifySignature,
} from '../../lib/channel-manager/standard-webhooks.ts'
import type { createChannelConnectionRepo } from './connection.repo.ts'
import type { createInboxRepo } from './inbox.repo.ts'
import type { createWebhookSecretRepo } from './webhook-secret.repo.ts'

export interface ChannelWebhookHandlerDeps {
	readonly inboxRepo: ReturnType<typeof createInboxRepo>
	readonly secretRepo: ReturnType<typeof createWebhookSecretRepo>
	/**
	 * Round 8 P1-6 (canon `feedback_round_8_strict_sweep_canon_2026_05_25.md`):
	 * required для cross-tenant authorization on inbound webhooks. Without this
	 * a forged `event.source` URN с valid signature for tenant A could be routed
	 * to tenant B's inbox. We validate that (tenantId-from-URN, channelId-from-
	 * route) has an active enabled connection в channelConnection table.
	 */
	readonly connectionRepo: ReturnType<typeof createChannelConnectionRepo>
	readonly nowSeconds?: () => number
	/**
	 * Optional IP-allowlist fallback for channels с no HMAC (e.g. ЮKassa-style).
	 * Map keyed by channelId. Empty/missing → signature is mandatory.
	 */
	readonly ipAllowlist?: ReadonlyMap<string, ReadonlyArray<string>>
	/**
	 * Optional downstream emit hook. Called on `accepted` after inbox persist.
	 * Returns response body to cache for idempotent replay. Failure throws → 500
	 * + inbox row stays status='received' (caller retries).
	 */
	readonly onAccepted?: (input: {
		readonly channelId: string
		readonly event: SochiCloudEvent
	}) => Promise<unknown>
}

/**
 * Map signature failure to HTTP status. Per Standard Webhooks 2026 canon:
 *   - replay_window_exceeded → 403 (forbidden, not auth issue)
 *   - missing_*  / malformed_* → 400 (bad request)
 *   - invalid_signature / no_matching_secret → 401 (unauthorized)
 */
function failureToStatus(reason: SignatureFailure): 400 | 401 | 403 {
	switch (reason) {
		case 'replay_window_exceeded':
			return 403
		case 'invalid_signature':
		case 'no_matching_secret':
			return 401
		case 'missing_id':
		case 'missing_timestamp':
		case 'missing_signature':
		case 'malformed_timestamp':
		case 'malformed_signature':
			return 400
	}
}

export function createChannelWebhookRoutes(deps: ChannelWebhookHandlerDeps) {
	const app = new Hono<AppEnv>()
	const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000))

	app.post('/:channelId', async (c) => {
		const channelId = c.req.param('channelId')
		if (channelId.length === 0) {
			return c.json({ error: 'missing_channel_id' }, 400)
		}

		// Step 1 — raw body bytes (signature verifies opaque bytes; never re-stringify).
		const rawBuffer = await c.req.raw.arrayBuffer()
		const rawBody = new Uint8Array(rawBuffer)

		// Step 2 — signature verification.
		const webhookId = c.req.header('webhook-id') ?? ''
		const timestamp = c.req.header('webhook-timestamp') ?? ''
		const signature = c.req.header('webhook-signature') ?? ''
		const acceptedSecrets = await deps.secretRepo.listAccepted(channelId)

		let verifyResult: VerifyResult | null = null
		let usedIpFallback = false
		if (signature.length > 0) {
			verifyResult = verifySignature(
				{
					webhookId,
					timestamp,
					signature,
					rawBody,
					nowSeconds: nowSeconds(),
				},
				acceptedSecrets,
			)
		} else {
			// Step 3 — IP-allowlist fallback (signature header absent).
			const allow = deps.ipAllowlist?.get(channelId) ?? []
			if (allow.length === 0) {
				return c.json({ error: 'missing_signature' }, 400)
			}
			const xff = c.req.header('x-forwarded-for')
			const chain = (xff ?? '')
				.split(',')
				.map((s) => s.trim())
				.filter((s) => s.length > 0)
			const trustedSourceIp = chain[chain.length - 1]
			if (trustedSourceIp === undefined || !allow.includes(trustedSourceIp)) {
				return c.json({ error: 'ip_not_allowed' }, 401)
			}
			usedIpFallback = true
		}

		if (verifyResult !== null && !verifyResult.ok) {
			return c.json({ error: verifyResult.reason }, failureToStatus(verifyResult.reason))
		}
		const matchedKid = verifyResult?.ok ? verifyResult.kid : null

		// Step 4 — parse CloudEvents envelope.
		const decoder = new TextDecoder('utf-8', { fatal: false })
		let parsedJson: unknown
		try {
			parsedJson = JSON.parse(decoder.decode(rawBody))
		} catch {
			return c.json({ error: 'malformed_json' }, 400)
		}
		const event = parseCloudEvent(parsedJson)
		if (event === null) {
			return c.json({ error: 'malformed_envelope' }, 400)
		}

		// Step 5 — classify.
		const bodyHash = computeBodyHash(rawBody)
		const tenantId = extractTenantId(event.source)
		if (tenantId === null) {
			return c.json({ error: 'malformed_source' }, 400)
		}

		// Round 8 P1-6: verify channelCode in source URN matches route channelId
		// (prevents URN-injection that re-routes to wrong adapter).
		const channelCodeFromSource = extractChannelCode(event.source)
		if (channelCodeFromSource === null) {
			return c.json({ error: 'malformed_source' }, 400)
		}
		if (channelCodeFromSource !== channelId) {
			return c.json(
				{
					error: 'channel_mismatch',
					expectedChannelId: channelId,
					sourceChannelCode: channelCodeFromSource,
				},
				400,
			)
		}

		// Round 8 P1-6: verify (tenantId-from-URN, channelId-from-route) has an
		// active enabled connection. Without this, a forged source URN с valid
		// signature for tenant A could route to tenant B's inbox (cross-tenant
		// attack vector).
		const tenantConnections = await deps.connectionRepo.listByTenant(tenantId)
		const authorizedConnection = tenantConnections.find(
			(conn) => conn.channelId === channelId && conn.isEnabled,
		)
		if (authorizedConnection === undefined) {
			return c.json({ error: 'forbidden_tenant_for_channel', tenantId, channelId }, 403)
		}

		// Round 11 P1-B3 — verify matched-secret's tenantId binding.
		// Round 8 P1-6 alone insufficient: when BOTH attacker + victim have
		// enabled YT connections, channel-shared secret allowed cross-tenant URN
		// forge. Round 11 binds secret к (channelId, tenantId): NULL row =
		// legacy back-compat (any tenant); explicit row must match URN tenantId.
		if (matchedKid !== null) {
			const matched = await deps.secretRepo.getByKid({ channelId, kid: matchedKid })
			if (matched !== null && matched.tenantId !== null && matched.tenantId !== tenantId) {
				return c.json({ error: 'webhook_secret_tenant_mismatch', tenantId, channelId }, 403)
			}
		}

		const classification = await deps.inboxRepo.classifyAndInsert({
			source: event.source,
			eventId: event.id,
			tenantId,
			channelId,
			eventType: event.type,
			bodyHash,
			signatureKid: matchedKid,
		})

		if (classification.kind === 'tampered') {
			return c.json(
				{
					error: 'tampered_replay',
					originalReceivedAt: classification.stored.receivedAt,
				},
				400,
			)
		}

		if (classification.kind === 'duplicate') {
			return c.json(
				{
					accepted: true,
					duplicate: true,
					eventId: event.id,
					ipFallback: usedIpFallback,
					cachedResponse: classification.record.responseJson,
				},
				200,
			)
		}

		// Step 6 — accepted; emit downstream + persist response.
		let response: unknown = { accepted: true, eventId: event.id }
		if (deps.onAccepted) {
			try {
				response = await deps.onAccepted({ channelId, event })
			} catch (err) {
				const message = err instanceof Error ? err.message : 'handler_failed'
				await deps.inboxRepo.markFailed({
					source: event.source,
					eventId: event.id,
					retryCount: 1,
				})
				return c.json({ error: 'handler_failed', detail: message }, 500)
			}
		}
		await deps.inboxRepo.markProcessed({
			source: event.source,
			eventId: event.id,
			responseJson: response,
		})
		return c.json(
			{
				accepted: true,
				eventId: event.id,
				kid: matchedKid,
				ipFallback: usedIpFallback,
				downstream: response,
			},
			200,
		)
	})

	return app
}

/**
 * Round 10 P1-B1 — restricted character class для tenantId + channelCode.
 *
 * `[^:]+` (Round 8 original) accepts ANY character except `:`, including
 * newline, tab, control chars, Unicode. Attacker can submit URN like
 * `urn:sochi:channel:TL:tenant:org\r\nFAKE_LOG_LINE` — extractTenantId
 * returns `'org\r\nFAKE_LOG_LINE'` which then writes multi-line log entries
 * masquerading as separate events (log injection attack).
 *
 * Restricted class `[A-Za-z0-9_-]{1,64}` matches all real tenant/channel
 * identifiers (UUID, slug, org_id prefixed forms) and blocks any control
 * char or whitespace exploit. Length capped at 64 для defense-in-depth
 * (real IDs ≤ 36 chars per UUID format).
 */
const URN_ID_CHARSET = '[A-Za-z0-9_-]{1,64}'

/**
 * Extract tenantId from canonical source URN
 *   `urn:sochi:channel:{channelCode}:tenant:{organizationId}`.
 * Returns null on malformed input OR if components contain forbidden chars.
 */
export function extractTenantId(source: string): string | null {
	const m = source.match(
		new RegExp(`^urn:sochi:channel:${URN_ID_CHARSET}:tenant:(${URN_ID_CHARSET})$`),
	)
	return m ? (m[1] ?? null) : null
}

/**
 * Round 8 P1-6: extract channelCode from canonical source URN
 *   `urn:sochi:channel:{channelCode}:tenant:{organizationId}`.
 * Used to verify URN's claimed channelCode matches route's channelId
 * parameter (prevents URN-injection cross-channel attack). Returns null
 * on malformed input OR if components contain forbidden chars.
 */
export function extractChannelCode(source: string): string | null {
	const m = source.match(
		new RegExp(`^urn:sochi:channel:(${URN_ID_CHARSET}):tenant:${URN_ID_CHARSET}$`),
	)
	return m ? (m[1] ?? null) : null
}
