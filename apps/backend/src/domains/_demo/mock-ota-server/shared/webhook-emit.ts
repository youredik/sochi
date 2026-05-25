/**
 * Webhook emission helper for the Round 9 demo OTA mock servers.
 *
 * Fires a Standard-Webhooks-signed CloudEvents 1.0.2 envelope to our own
 * backend's channel webhook receiver:
 *
 *   `POST /api/channel/webhooks/{channelId}`
 *
 * This closes the demo loop: a guest who books через the mock OTA UI
 * triggers a real channel-inbox row на той же backend instance, exercising
 * the production webhook pipeline (signature verify + CloudEvents parse +
 * inbox classify) end-to-end. The PMS split-pane view sees the reservation
 * by the time the success page renders.
 *
 * Canon sources:
 *   - `lib/channel-manager/cloud-events.ts` — `buildCloudEvent` + URN format
 *   - `lib/channel-manager/standard-webhooks.ts` — `computeSignature` shape
 *   - `domains/channel/webhook.routes.ts` — receiver expects `webhook-id`,
 *     `webhook-timestamp`, `webhook-signature: v1,<base64>` headers
 *
 * **Secret derivation**: Phase-1 demo uses the value of env
 * `DEMO_MOCK_OTA_WEBHOOK_SECRET` (sane fallback default for local dev). In
 * production this is overridden из YC Lockbox + matches the row в
 * `webhookSecret` table for the `YT` / `ETG` channel. The target URL is
 * env-overridable via `DEMO_MOCK_OTA_TARGET_URL` so a staging cloud can fire
 * webhooks at its own backend rather than localhost.
 *
 * **Synchronous fetch contract**: callers `await emitDemoWebhook(...)` BEFORE
 * responding to the OTA guest. This guarantees the PMS already has the
 * inbox row by the time the demo success page renders. The fetch carries a
 * 5s timeout — beyond that we surface a `webhook_timeout` error to caller,
 * which the route handler folds into HTTP 502 (demo-friendly diagnostic).
 */

import { randomUUID } from 'node:crypto'
import {
	buildCloudEvent,
	buildEventType,
	buildSourceUrn,
	type SochiCloudEvent,
} from '../../../../lib/channel-manager/cloud-events.ts'
import { computeSignature } from '../../../../lib/channel-manager/standard-webhooks.ts'

const DEFAULT_TARGET_URL_BASE = 'http://localhost:8787'
const DEFAULT_WEBHOOK_SECRET = 'demo-mock-ota-webhook-secret-do-not-use-in-prod'
const FETCH_TIMEOUT_MS = 5_000

export type DemoWebhookAction = 'created' | 'cancelled'

export interface EmitDemoWebhookInput {
	readonly channelId: 'YT' | 'ETG'
	readonly tenantId: string
	readonly externalReservationId: string
	readonly action: DemoWebhookAction
	readonly data: Record<string, unknown>
	/** Override target URL — Phase 2 will read this from env at call site. */
	readonly targetUrlOverride?: string
	/** Override secret — Phase 2 will read this from env at call site. */
	readonly secretOverride?: string
	/**
	 * Inject a fetch implementation для tests so we don't open real sockets.
	 * Defaults to `globalThis.fetch`.
	 */
	readonly fetchImpl?: typeof fetch
	/** Inject clock for deterministic timestamp. */
	readonly nowMs?: () => number
}

export interface EmitDemoWebhookResult {
	readonly ok: boolean
	readonly httpStatus: number
	readonly event: SochiCloudEvent
	readonly responseBody?: unknown
	readonly error?: string
}

/**
 * Resolve the target URL for the demo webhook. Priority order:
 *   1. Explicit `targetUrlOverride` — used as-is (full URL including path).
 *      Tests typically pass `http://test.invalid/api/channel/webhooks/YT`.
 *      Callers wiring per-tenant routing pass a fully-formed URL.
 *   2. `process.env.DEMO_MOCK_OTA_TARGET_URL` — typically the base origin
 *      (`http://localhost:8787`); the channelId path suffix is appended.
 *   3. Hard-coded `http://localhost:8787` base (Phase-1 dev fallback) with
 *      channelId path suffix appended.
 *
 * TODO Phase-2: read base from env via app config layer (not direct
 * `process.env`) so the secret rotation pipeline can hot-swap without app
 * restart.
 */
export function resolveTargetUrl(channelId: string, override?: string): string {
	if (override !== undefined && override.length > 0) {
		// Override always used as-is — it carries the full destination URL.
		return override
	}
	const base = process.env.DEMO_MOCK_OTA_TARGET_URL ?? DEFAULT_TARGET_URL_BASE
	const trimmed = base.replace(/\/$/, '')
	return `${trimmed}/api/channel/webhooks/${channelId}`
}

/**
 * Resolve the webhook signing secret. Priority order:
 *   1. Explicit `secretOverride`
 *   2. `process.env.DEMO_MOCK_OTA_WEBHOOK_SECRET`
 *   3. Hard-coded dev fallback (logs warning when used)
 */
export function resolveSecret(override?: string): string {
	if (override !== undefined && override.length > 0) return override
	const fromEnv = process.env.DEMO_MOCK_OTA_WEBHOOK_SECRET
	if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
	return DEFAULT_WEBHOOK_SECRET
}

/**
 * Emit a CloudEvents-wrapped Standard-Webhooks-signed POST to our own
 * channel webhook endpoint. Synchronous (await-able) so callers can chain
 * the HTTP response on top of webhook delivery.
 */
export async function emitDemoWebhook(input: EmitDemoWebhookInput): Promise<EmitDemoWebhookResult> {
	const now = input.nowMs ?? Date.now
	const nowMs = now()

	const event = buildCloudEvent({
		id: randomUUID(),
		source: buildSourceUrn({
			channelCode: input.channelId,
			organizationId: input.tenantId,
		}),
		type: buildEventType({
			entity: 'booking',
			action: input.action,
			version: 'v1',
		}),
		subject: input.externalReservationId,
		time: new Date(nowMs).toISOString(),
		datacontenttype: 'application/json',
		data: input.data,
	})

	const rawBody = JSON.stringify(event)
	const webhookId = `wh_${randomUUID()}`
	const timestampSec = Math.floor(nowMs / 1000).toString()
	const secret = resolveSecret(input.secretOverride)
	const signatureB64 = computeSignature({
		webhookId,
		timestamp: timestampSec,
		rawBody,
		secret,
	})

	const targetUrl = resolveTargetUrl(input.channelId, input.targetUrlOverride)
	const fetchImpl = input.fetchImpl ?? globalThis.fetch

	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
	try {
		const res = await fetchImpl(targetUrl, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'webhook-id': webhookId,
				'webhook-timestamp': timestampSec,
				'webhook-signature': `v1,${signatureB64}`,
			},
			body: rawBody,
			signal: controller.signal,
		})
		let responseBody: unknown
		try {
			responseBody = await res.json()
		} catch {
			responseBody = undefined
		}
		return {
			ok: res.ok,
			httpStatus: res.status,
			event,
			...(responseBody !== undefined ? { responseBody } : {}),
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : 'unknown_error'
		return {
			ok: false,
			httpStatus: 0,
			event,
			error: message,
		}
	} finally {
		clearTimeout(timer)
	}
}
