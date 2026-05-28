/**
 * Inbound channel webhook routes — M10 / A7.1.fix (D11+D12+D25).
 *
 * Mounted at `/api/channel/webhooks/:channelId` PUBLIC (no auth — webhook
 * sender is the channel itself, not an authenticated user).
 *
 * Pipeline (per request, **Round 14.6.4 ordering**):
 *   1. Read raw body bytes (Hono `c.req.raw.arrayBuffer()`) — MUST be raw,
 *      never parsed-then-restringified (signature verifies opaque bytes).
 *   2. Parse CloudEvents 1.0.2 envelope FIRST (Round 14.6.4 reorder) so the
 *      tenantId in source URN is known before we narrow accepted secrets.
 *   3. Extract tenantId + channelCode from source URN; reject URN-injection
 *      attempts (newline/control chars per Round 10 P1-B1).
 *   4. Verify Standard Webhooks signature against `listAccepted(channelId,
 *      tenantId)` — tenant-narrowed multi-key candidate list. Prevents
 *      per-tenant demo OTA cross-match silent break (Round 14.6.4 fix —
 *      см. middle-of-handler comment block).
 *   5. Optional IP allowlist fallback for non-HMAC channels (ЮKassa parity).
 *   6. Classify via inbox repo: `accepted` | `duplicate` (return cached 200) |
 *      `tampered` (400, alert-emit).
 *   7. On `accepted` — emit downstream domain event (А7.5 sync orchestrator
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
import { validateWebhookData } from '../../lib/channel-manager/webhook-data-schemas.ts'
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

		// Step 2 — parse CloudEvents envelope FIRST so we can extract tenantId
		// from source URN BEFORE narrowing accepted secrets. Round 14.6.4 fix
		// (2026-05-28) per `feedback_round_14_6_per_tenant_demo_canon`: the
		// previous order called `listAccepted(channelId)` UNFILTERED, so the
		// verifier saw every tenant's `kid_demo_<orgId>` row. With N per-tenant
		// demo orgs all sharing `env.DEMO_WEBHOOK_SECRET` value, multiple slots
		// matched the same signature → first-match wins (newest activatedAt) →
		// matched.kid belonged to a DIFFERENT tenant → Round 11 P1-B3 binding
		// check fired 403 `webhook_secret_tenant_mismatch` for legitimate
		// per-tenant demos. Empirically caught browser walk на demo.sepshn.ru
		// after 2+ orgs signed up — wow-effect silently broken (booking returned
		// 200 to OTA frontend but inbox row never landed → PMS grid stayed empty).
		//
		// Narrowing `listAccepted(channelId, tenantId)` to (tenantId OR NULL) at
		// step 6 below ensures the verifier ONLY considers candidates bound к the
		// claimed source-URN tenant. Cross-tenant URN forgery still rejected, but
		// status surfaces as 401 `no_matching_secret` (verifier never saw a
		// candidate to match) — стрictly safer than the prior 403 path.
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

		// Step 3 — extract tenantId + channelCode from source URN.
		const tenantId = extractTenantId(event.source)
		if (tenantId === null) {
			return c.json({ error: 'malformed_source' }, 400)
		}
		const channelCodeFromSource = extractChannelCode(event.source)
		if (channelCodeFromSource === null) {
			return c.json({ error: 'malformed_source' }, 400)
		}
		// Round 8 P1-6 — channelCode-vs-route guard (URN-injection defense).
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

		// Step 4 — signature verification, tenant-scoped.
		const webhookId = c.req.header('webhook-id') ?? ''
		const timestamp = c.req.header('webhook-timestamp') ?? ''
		const signature = c.req.header('webhook-signature') ?? ''
		// Round 14.6.4 — narrow к tenantId so per-tenant demo OTA's
		// kid_demo_<orgId> rows (all sharing the same secret VALUE via
		// `env.DEMO_WEBHOOK_SECRET`) don't cross-match each other. NULL-tenantId
		// rows (legacy back-compat — pre-Round-11) remain candidates per
		// listAccepted semantics, preserving WHR14 contract.
		const acceptedSecrets = await deps.secretRepo.listAccepted(channelId, tenantId)

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
			// Step 4.b — IP-allowlist fallback (signature header absent).
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

		// Step 5 — classify-prep + body-hash.
		const bodyHash = computeBodyHash(rawBody)

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

		// Round 14 Phase E3 — per-channel `data` field zod validation. Unknown
		// event-type+channel combinations pass-through (forward-compat); known
		// schemas reject malformed `data` с structured 400 error.
		const dataValidation = validateWebhookData({
			eventType: event.type,
			channelId,
			data: event.data,
		})
		if (dataValidation.kind === 'invalid') {
			return c.json(
				{
					error: 'invalid_webhook_data',
					eventType: event.type,
					channelId,
					details: dataValidation.errors,
				},
				400,
			)
		}

		// Round 11 P1-B3 — verify matched-secret's tenantId binding. Defense-
		// in-depth: после Round 14.6.4 listAccepted уже narrows к tenantId so
		// этот check теоретически redundant для non-NULL rows; kept as belt-and-
		// suspenders against `listAccepted` regression. NULL tenantId guard
		// preserves WHR14 legacy back-compat path.
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
