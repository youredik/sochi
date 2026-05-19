/**
 * Inbound payment webhook routes (P1, 2026-05; P2.5 hardening 2026-05-19).
 *
 * Mounted PUBLIC (no auth — sender is the provider, not an authenticated user).
 *
 * Pipeline:
 *   1. IP resolve via `rightMostTrustedProxyResolveClientIp` (P2.5: defense
 *      against CVE-2025-68949-class XFF spoofing — TCP peer + trusted-proxy
 *      walking canon Q2 2026).
 *   2. IP allowlist check against `YOOKASSA_WEBHOOK_IP_CIDRS` (ЮKassa NO HMAC
 *      canon 2026-05-19 — IP allowlist + GET round-trip ONLY).
 *   3. Raw body capture (`c.req.raw.arrayBuffer()`) — verify on opaque bytes.
 *   4. Provider `verifyWebhook` — parses + validates Zod + synthesizes dedupKey
 *      + filters malicious `confirmation_url` host (P2.5 supply-chain defense).
 *   5. Global lookup `findTenantByProviderPaymentId` — derive tenantId without
 *      auth. Returns 200 on miss (event for unknown payment — log + ack).
 *   6. INSERT into `paymentWebhookEvent` — UNIQUE PK conflict → 200 ack
 *      (replay-safe). Race-safety: cross-event concurrent processing на same
 *      payment.id uses version-CAS в applyTransition (loser retries/logs).
 *   7. `service.applyWebhookEvent` — apply state transition (payment subject)
 *      OR record-only (refund subject).
 *   8. `markProcessed` for audit.
 *
 * Returns: HTTP 200 ALWAYS on accepted/duplicate (idempotent ack). 4xx only
 * on truly malformed input or IP-allowlist failure. 5xx on unexpected errors
 * (provider will retry per 24h SLA).
 *
 * ## Multi-tenant V1 scope (P2.5)
 *
 * Currently single global ЮKassa shopId. Per-tenant shopId routing = future
 * phase (canon C2 finding from P2.5 audit). Webhook handler derives tenantId
 * via cross-tenant `findTenantByProviderPaymentId` (UNIQUE constraint guarantees
 * ≤1 row). Cockatiel circuit-breaker also global per-provider — DoS amplification
 * surface; multi-tenant phase = per-tenant bulkhead isolation.
 */

import type { PaymentProviderCode } from '@horeca/shared'
import { Hono } from 'hono'
import type { AppEnv } from '../../factory.ts'
import { YOOKASSA_WEBHOOK_IP_CIDRS } from './provider/yookassa-schemas.ts'
import type { PaymentProvider } from '@horeca/shared'
import type { PaymentService } from './payment.service.ts'
import type { PaymentRepo } from './payment.repo.ts'
import type { PaymentWebhookEventRepo } from './payment-webhook-event.repo.ts'
import { isIpInCidr } from '../../lib/net/cidr.ts'
import {
	resolveClientIp as rightMostTrustedProxyResolveClientIpShared,
	type ResolveClientIpInput as SharedResolveClientIpInput,
} from '../../lib/net/client-ip.ts'

export interface PaymentWebhookRoutesDeps {
	readonly yookassaProvider: PaymentProvider
	readonly paymentRepo: PaymentRepo
	readonly paymentService: PaymentService
	readonly webhookEventRepo: PaymentWebhookEventRepo
	/**
	 * Structured logger (Pino-compatible). Injected via DI rather than read из
	 * `c.var.logger` because public webhook route mounts WITHOUT the global
	 * `pinoLogger` middleware chain that populates `c.var` (would clash with
	 * IP-allowlist 4xx response timing).
	 */
	readonly logger: {
		debug(obj: Record<string, unknown>, msg?: string): void
		info(obj: Record<string, unknown>, msg?: string): void
		warn(obj: Record<string, unknown>, msg?: string): void
		error(obj: Record<string, unknown>, msg?: string): void
	}
	/**
	 * CIDR list of TRUSTED reverse proxies (own infra). Only when the actual
	 * TCP peer matches a CIDR in this list, X-Forwarded-For is parsed; otherwise
	 * XFF is IGNORED and the TCP peer address itself is used. Defense against
	 * IP spoofing where an attacker connects directly to the backend and forges
	 * `X-Forwarded-For: 185.71.76.5` к bypass the ЮKassa allowlist (CVE-2025-68949
	 * n8n precedent).
	 *
	 * Production: configure to actual deployment proxy CIDRs (Yandex Cloud ALB).
	 * Dev/empty array: only direct TCP peers accepted (no XFF trust).
	 */
	readonly trustedProxyCidrs: readonly string[]
	/**
	 * Resolve client IP from request. Default implements right-most-trusted-proxy
	 * walking canon (MDN / OneUptime 2026 / OWASP A10 / CVE-2025-68949 lessons).
	 * Override only для tests.
	 */
	readonly resolveClientIp?: (input: ResolveClientIpInput) => string | null
}

const PROVIDER_YOOKASSA: PaymentProviderCode = 'yookassa'
const SYSTEM_ACTOR = 'payment-webhook'

/**
 * Inputs for `resolveClientIp` — re-export from canonical shared module so
 * tests / downstream consumers can use either alias.
 */
export type ResolveClientIpInput = SharedResolveClientIpInput

/**
 * Right-most-trusted-proxy IP resolution canon (Q2 2026). Re-export of shared
 * `apps/backend/src/lib/net/client-ip.ts` `resolveClientIp` для existing
 * import sites; canon was unified 2026-05-19 B7 refactor (previously inline
 * duplicate here + leftmost variants в widget-rate-limit / RUM).
 */
export const rightMostTrustedProxyResolveClientIp = rightMostTrustedProxyResolveClientIpShared

function isIpAllowed(ip: string, cidrs: readonly string[]): boolean {
	for (const cidr of cidrs) {
		if (isIpInCidr(ip, cidr)) return true
	}
	return false
}

export function createPaymentWebhookRoutes(deps: PaymentWebhookRoutesDeps) {
	const app = new Hono<AppEnv>()
	const resolveClientIp = deps.resolveClientIp ?? rightMostTrustedProxyResolveClientIp

	// POST /api/v1/payments/webhook/yookassa
	app.post('/yookassa', async (c) => {
		// Bun/Node runtime: `c.req.raw` request has no standard `client.address`
		// surface — Hono's `getConnInfo(c)` from `hono/bun` exposes it. Import
		// is dynamic к keep route file framework-portable (тесты mount без бан).
		let tcpRemoteAddress: string | null = null
		try {
			const { getConnInfo } = await import('hono/bun')
			tcpRemoteAddress = getConnInfo(c).remote.address ?? null
		} catch {
			// Test environment без hono/bun runtime — fall back к XFF-only resolution.
			tcpRemoteAddress = null
		}
		const sourceIp = resolveClientIp({
			headers: new Headers(c.req.raw.headers),
			tcpRemoteAddress,
			trustedProxyCidrs: deps.trustedProxyCidrs,
		})

		// Step 1: IP allowlist gate (ЮKassa NO HMAC — IP is sole authenticator).
		if (sourceIp === null) {
			deps.logger.warn({ provider: PROVIDER_YOOKASSA }, 'payment-webhook: missing client IP')
			return c.json({ error: 'missing_client_ip' }, 400)
		}
		if (!isIpAllowed(sourceIp, YOOKASSA_WEBHOOK_IP_CIDRS)) {
			deps.logger.warn(
				{ provider: PROVIDER_YOOKASSA, sourceIp },
				'payment-webhook: IP not in YooKassa allowlist',
			)
			return c.json({ error: 'forbidden' }, 403)
		}

		// Step 2: raw body capture (verifyWebhook works on opaque bytes).
		const rawBuffer = await c.req.raw.arrayBuffer()
		const rawBody = new Uint8Array(rawBuffer)

		// Step 3: provider verify + parse + dedup-key synthesis.
		let verified: Awaited<ReturnType<typeof deps.yookassaProvider.verifyWebhook>>
		try {
			verified = await deps.yookassaProvider.verifyWebhook(c.req.raw.headers, rawBody)
		} catch (err) {
			deps.logger.warn(
				{ provider: PROVIDER_YOOKASSA, sourceIp, err: (err as Error).message },
				'payment-webhook: verifyWebhook failed',
			)
			// Bad payload — caller retry won't help. 400 finalizes.
			return c.json({ error: 'invalid_payload' }, 400)
		}

		// Step 4: derive tenantId via cross-tenant lookup (no auth context).
		const providerPaymentIdForLookup =
			verified.subject.kind === 'payment'
				? verified.subject.snapshot.providerPaymentId
				: verified.subject.parentProviderPaymentId

		const located = await deps.paymentRepo.findTenantByProviderPaymentId(
			PROVIDER_YOOKASSA,
			providerPaymentIdForLookup,
		)
		if (located === null) {
			// Event for unknown payment — could be foreign tenant OR race with
			// INSERT not yet replicated. Log + 200 (ack, do NOT retry). Provider
			// would otherwise pound us with retries for nothing.
			deps.logger.info(
				{
					provider: PROVIDER_YOOKASSA,
					providerPaymentId: providerPaymentIdForLookup,
					event: verified.subject.kind,
				},
				'payment-webhook: no matching payment — ack without action',
			)
			return c.json({ status: 'ok', action: 'no-match' }, 200)
		}

		const tenantId = located.tenantId
		const eventType =
			verified.subject.kind === 'payment'
				? `payment.${verified.subject.snapshot.status}`
				: 'refund.succeeded'

		// Step 5: dedup INSERT into paymentWebhookEvent.
		const inboxResult = await deps.webhookEventRepo.insertOrSkip({
			tenantId,
			providerCode: PROVIDER_YOOKASSA,
			dedupKey: verified.dedupKey,
			eventType,
			providerPaymentId:
				verified.subject.kind === 'payment'
					? verified.subject.snapshot.providerPaymentId
					: verified.subject.parentProviderPaymentId,
			providerRefundId:
				verified.subject.kind === 'refund' ? verified.subject.refund.providerRefundId : null,
			payloadJson: { dedupKey: verified.dedupKey, eventType, subject: verified.subject },
			signatureHeader: null, // ЮKassa NO HMAC (canon)
			sourceIp,
		})

		if (inboxResult.kind === 'duplicate') {
			deps.logger.info(
				{ provider: PROVIDER_YOOKASSA, tenantId, dedupKey: verified.dedupKey },
				'payment-webhook: duplicate event — 200 ack (replay-safe)',
			)
			return c.json({ status: 'ok', action: 'duplicate' }, 200)
		}

		// Step 6: apply transition.
		try {
			const outcome = await deps.paymentService.applyWebhookEvent(tenantId, verified, SYSTEM_ACTOR)
			await deps.webhookEventRepo.markProcessed(
				tenantId,
				PROVIDER_YOOKASSA,
				verified.dedupKey,
				SYSTEM_ACTOR,
			)
			deps.logger.info(
				{
					provider: PROVIDER_YOOKASSA,
					tenantId,
					dedupKey: verified.dedupKey,
					action: outcome.kind,
				},
				'payment-webhook: processed',
			)
			return c.json({ status: 'ok', action: outcome.kind }, 200)
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err)
			deps.logger.error(
				{
					provider: PROVIDER_YOOKASSA,
					tenantId,
					dedupKey: verified.dedupKey,
					err: errMsg,
				},
				'payment-webhook: processing failed — provider will retry',
			)
			await deps.webhookEventRepo.markFailed(tenantId, PROVIDER_YOOKASSA, verified.dedupKey, errMsg)
			// 5xx so provider re-delivers (ЮKassa 24h retry window).
			return c.json({ error: 'processing_failed' }, 500)
		}
	})

	return app
}
