/**
 * Right-To-Be-Forgotten (RTBF) endpoint — 152-ФЗ ст.20 (право отзыва) +
 * ст.21 ч.5 (30 дней на уничтожение).
 *
 * POST /api/v1/passport-scan/consent/:consentId/revoke
 *
 * **Timer corrections (Sprint C+ legal-expert audit 2026-05-23d)**:
 *   - ст.20 = право субъекта отозвать согласие (без timer'а — само право).
 *   - ст.21 ч.5 = 30 дней на уничтожение ПДн после отзыва (NOT 10; ст.21 ч.3's
 *     10 рабочих дней относится к «неправомерной обработке» — другой scenario).
 *   - Endpoint выполняет destruction immediately (одна tx + S3 delete), что
 *     ≤≤ 30-дневного SLA — operator не должен ждать deadline.
 *
 * Sprint C 2026-05-22 — закрывает критический legal gap: `consentRepo.revoke()`
 * existed since Sprint B, но zero routes → гость не мог exercise ст.20 →
 * автоматический fail Roskomnadzor inspection (КоАП ч.5 = 100-300к ₽).
 *
 * Self-review fix 2026-05-23 (Sprint C+1):
 *   - **Order inversion**: DB cascade FIRST, then S3 delete. Старый порядок
 *     удалял S3 объекты ДО tx — если cascade throws, audit rows still claim
 *     `inputObjectKey` exist но object уже gone (data inconsistency). New
 *     order: tx commits «scrubbed» state; S3 delete runs only when audit
 *     already nullified.
 *   - **Truthful state**: factory.cascadeRtbfRevoke returns canonical
 *     {revokedAt, alreadyRevoked, revokedReason} вместо always-true lie.
 *     Route returns this verbatim чтобы DSAR + operator API share clock.
 *   - **Idempotency** middleware applied — double-click on revoke button
 *     теперь dedupes на backend per Stripe canon (vision route уже paid).
 *
 * Flow (DB cascade FIRST):
 *   1. Find consent by (tenantId, consentId) → 404 если cross-tenant / not found
 *   2. If already revoked → return existing state (idempotent — повторный
 *      revoke допустим per 152-ФЗ canon).
 *   3. Find inputObjectKeys в audit rows linked к этому consent (BEFORE nullify
 *      because audit.nullify wipes inputObjectKey to NULL too)
 *   4. cascadeRtbfRevoke в sql.begin: nullify audit + revoke consent atomic
 *   5. AFTER tx commits — delete S3 objects (storage не транзакционен с DB)
 *
 * RBAC: requires manager+ permission — operator может revoke consents любого
 * guest в своём tenant; гость sам зайдёт через guest portal (отдельный flow).
 *
 * Architecture (Sprint C 2026-05-23): routes no longer import `sql` directly.
 * `PassportScanFactory` encapsulates DB access — depcruise `no-routes-to-db`
 * compliant.
 */

import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { rateLimiter } from 'hono-rate-limiter'
import { z } from 'zod'
import { env } from '../../../../env.ts'
import type { AppEnv } from '../../../../factory.ts'
import { extractClientIpFromContext } from '../../../../lib/net/client-ip.ts'
import { authMiddleware } from '../../../../middleware/auth.ts'
import type { IdempotencyMiddleware } from '../../../../middleware/idempotency.ts'
import { requirePermission } from '../../../../middleware/require-permission.ts'
import { tenantMiddleware } from '../../../../middleware/tenant.ts'
import type { PassportScanFactory } from '../passport-scan.factory.ts'
import type { PassportPhotoStorage } from '../storage/passport-photo-storage.ts'

/**
 * Round 2 self-review Legal P0-5 fix: removed `gdpr_export` enum value —
 * GDPR неприменимо в РФ jurisdiction. Tinkoff УКБО 2025 precedent — РКН
 * рассматривает GDPR-terminology как «оператор не разбирается в применимом
 * законе» → дополнительные questions при inspection. Replaced с
 * `dsar_152fz` (статья 14, право доступа). `reasonText` required if
 * `reason === 'other'` per Legal P1-9 fix.
 */
const revokeBodySchema = z
	.object({
		reason: z.enum(['user_request', 'dsar_152fz', 'mistake', 'other']).default('user_request'),
		reasonText: z.string().min(10).max(2000).optional(),
	})
	.refine((b) => b.reason !== 'other' || (b.reasonText !== undefined && b.reasonText.length > 0), {
		message:
			'reasonText (10-2000 chars) обязателен когда reason="other" — 152-ФЗ ст.21 ч.4 audit canon',
		path: ['reasonText'],
	})

/**
 * Sprint C Day 3+: rate limit 60 revoke/min/tenant. Even с RBAC, compromised
 * operator account could brute-force consentIds (UUID-like cns_* + tenantId
 * filter = high entropy, но defense-in-depth). 60 = generous для legitimate
 * support workflows (operator revokes 1 per minute = 60/h max realistic).
 */
const REVOKE_RATE_LIMIT_WINDOW_MS = 60_000
const REVOKE_RATE_LIMIT_MAX = 60

export interface ConsentRevokeRoutesDeps {
	readonly passportScanFactory: PassportScanFactory
	readonly photoStorage: PassportPhotoStorage
	/** Sprint C self-review I4 fix: Stripe-style dedup на double-click. */
	readonly idempotency: IdempotencyMiddleware
}

export function createConsentRevokeRoutesInner(deps: ConsentRevokeRoutesDeps) {
	const { passportScanFactory, photoStorage, idempotency } = deps
	const { consentRepo, cascadeRtbfRevoke } = passportScanFactory

	return new Hono<AppEnv>().post(
		'/passport-scan/consent/:consentId/revoke',
		rateLimiter<AppEnv>({
			windowMs: REVOKE_RATE_LIMIT_WINDOW_MS,
			limit: REVOKE_RATE_LIMIT_MAX,
			// Round 4 P0-RL-1 fix: per-IP fallback (resolveClientIpSync canon).
			keyGenerator: (c) =>
				c.var.tenantId ?? `ip:${extractClientIpFromContext(c, env.TRUSTED_PROXY_CIDRS)}`,
			standardHeaders: 'draft-7',
			statusCode: 429,
			message: {
				error: {
					code: 'RATE_LIMITED',
					message: 'Слишком много отзывов согласий в минуту. Лимит = 60/мин на тенант.',
				},
			},
		}),
		idempotency,
		requirePermission({ guest: ['update'] }),
		zValidator('json', revokeBodySchema),
		async (c) => {
			const consentId = c.req.param('consentId')
			const body = c.req.valid('json')
			const tenantId = c.var.tenantId

			// (1) Cross-tenant lookup — 404 если consent не найден или не в нашем tenant.
			// Self-review I8 mitigation: same 404 для not-found AND cross-tenant —
			// caller cannot distinguish (timing attack mitigated by RBAC + rate limit).
			const consent = await consentRepo.findById(tenantId, consentId)
			if (consent === null) {
				return c.json({ error: { code: 'NOT_FOUND', message: 'Согласие не найдено' } }, 404)
			}

			// (2) Idempotent — повторный revoke ОК per canon. factory's cascade
			// also re-checks revokedAt to handle TOCTOU race window.
			if (consent.revokedAt !== null) {
				return c.json(
					{
						data: {
							consentId,
							revokedAt: consent.revokedAt.toISOString(),
							revokedReason: consent.revokedReason,
							alreadyRevoked: true,
							deletedObjects: 0,
						},
					},
					200,
				)
			}

			// (3+4) Atomic DB cascade: audit nullify + guestDocument scrub +
			// consent revoke с shared timestamp. ROUND 2 P0-1 fix: objectKeys
			// collected INSIDE the tx snapshot — race-free vs concurrent scan
			// writing новый inputObjectKey. Throws → 500 + S3 objects still
			// intact (operator can retry, lifecycle 90-day backstop).
			const result = await cascadeRtbfRevoke({
				tenantId,
				consentId,
				reason: body.reason,
			})
			const objectKeys = result.objectKeysToDelete

			// (5) AFTER DB tx commits, delete S3 objects. Storage failures не блокируют —
			// audit rows already scrubbed (no PII linkage). Lifecycle 90d backstop
			// catches stragglers per 152-ФЗ ст.21 ч.7 «не дольше необходимого».
			let deletedObjects = 0
			for (const key of objectKeys) {
				try {
					await photoStorage.delete(key)
					deletedObjects++
				} catch (err) {
					c.var.logger.warn(
						{
							event: 'consent_revoke.storage_delete_failed',
							consentId,
							tenantId,
							objectKey: key,
							err: err instanceof Error ? err.message : String(err),
						},
						'storage delete failed during RTBF cascade — lifecycle 90d backstop',
					)
				}
			}

			// Sprint C: structured log для RTBF audit trail. Roskomnadzor inspection
			// может requested «покажите когда + сколько данных удалено для consent X».
			c.var.logger.info(
				{
					event: 'consent_revoke',
					consentId,
					tenantId,
					operatorUserId: c.var.session?.userId ?? c.var.user?.id ?? 'unknown',
					reason: body.reason,
					alreadyRevoked: result.alreadyRevoked,
					storageObjectsRequested: objectKeys.length,
					storageObjectsDeleted: deletedObjects,
				},
				'152-ФЗ ст.20 RTBF cascade completed',
			)

			return c.json(
				{
					data: {
						consentId,
						// Self-review H3 fix: use factory's canonical timestamp,
						// not fresh new Date() (which drifts из tx commit latency).
						revokedAt: result.revokedAt.toISOString(),
						revokedReason: result.revokedReason,
						alreadyRevoked: result.alreadyRevoked,
						deletedObjects,
					},
				},
				200,
			)
		},
	)
}

export function createConsentRevokeRoutes(deps: ConsentRevokeRoutesDeps) {
	return new Hono<AppEnv>()
		.use('*', authMiddleware(), tenantMiddleware())
		.route('/', createConsentRevokeRoutesInner(deps))
}
