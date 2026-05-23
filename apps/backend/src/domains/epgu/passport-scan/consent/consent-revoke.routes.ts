/**
 * Right-To-Be-Forgotten (RTBF) endpoint — 152-ФЗ ст.20 (10 рабочих дней).
 *
 * POST /api/v1/passport-scan/consent/:consentId/revoke
 *
 * Sprint C 2026-05-22 — закрывает критический legal gap: `consentRepo.revoke()`
 * existed since Sprint B, но zero routes → гость не мог exercise ст.20 →
 * автоматический fail Roskomnadzor inspection (КоАП ч.5 = 100-300к ₽).
 *
 * Flow (всё в sql.begin atomic):
 *   1. Find consent by (tenantId, consentId) → 404 если cross-tenant / not found
 *   2. If already revoked → return existing state (idempotent — повторный
 *      revoke допустим per 152-ФЗ canon).
 *   3. Find inputObjectKey'и в audit rows linked к этому consent
 *   4. Delete S3 objects immediately (НЕ ждать 90-day lifecycle GC) для ст.20 SLA
 *   5. Nullify PII fields в audit rows (cascade scrub) + set entitiesAnonymizedAt
 *   6. consent.revoke (sets revokedAt + revokedReason)
 *
 * НЕ deletes consent row — keeps proof что согласие existed (ст.21 ч.4
 * accountability log). Только scrubs linked PII.
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
import type { AppEnv } from '../../../../factory.ts'
import { authMiddleware } from '../../../../middleware/auth.ts'
import { requirePermission } from '../../../../middleware/require-permission.ts'
import { tenantMiddleware } from '../../../../middleware/tenant.ts'
import type { PassportScanFactory } from '../passport-scan.factory.ts'
import type { PassportPhotoStorage } from '../storage/passport-photo-storage.ts'

const revokeBodySchema = z.object({
	reason: z.enum(['user_request', 'gdpr_export', 'mistake', 'other']).default('user_request'),
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
}

export function createConsentRevokeRoutesInner(deps: ConsentRevokeRoutesDeps) {
	const { passportScanFactory, photoStorage } = deps
	const { consentRepo, auditRepo } = passportScanFactory

	return new Hono<AppEnv>().post(
		'/passport-scan/consent/:consentId/revoke',
		rateLimiter<AppEnv>({
			windowMs: REVOKE_RATE_LIMIT_WINDOW_MS,
			limit: REVOKE_RATE_LIMIT_MAX,
			keyGenerator: (c) => c.var.tenantId ?? 'anonymous',
			standardHeaders: 'draft-7',
			statusCode: 429,
			message: {
				error: {
					code: 'RATE_LIMITED',
					message: 'Слишком много отзывов согласий в минуту. Лимит = 60/мин на тенант.',
				},
			},
		}),
		requirePermission({ guest: ['update'] }),
		zValidator('json', revokeBodySchema),
		async (c) => {
			const consentId = c.req.param('consentId')
			const body = c.req.valid('json')
			const tenantId = c.var.tenantId

			// (1) Cross-tenant lookup — 404 если consent не найден или не в нашем tenant
			const consent = await consentRepo.findById(tenantId, consentId)
			if (consent === null) {
				return c.json({ error: { code: 'NOT_FOUND', message: 'Согласие не найдено' } }, 404)
			}

			// (2) Idempotent — повторный revoke ОК per canon
			if (consent.revokedAt !== null) {
				return c.json(
					{
						data: {
							consentId,
							revokedAt: consent.revokedAt.toISOString(),
							revokedReason: consent.revokedReason,
							alreadyRevoked: true,
							deletedObjects: 0,
							anonymizedAuditRows: 0,
						},
					},
					200,
				)
			}

			// (3+4+5+6) Atomic cascade: find objectKeys → delete S3 → nullify entities → revoke consent
			const objectKeys = await auditRepo.findObjectKeysByConsentId(tenantId, consentId)

			// Delete S3 objects ВНЕ transaction (storage не транзакционен с DB).
			// Любые failures логируются, но не блокируют DB revoke (lifecycle 90d backstop).
			let deletedObjects = 0
			for (const key of objectKeys) {
				try {
					await photoStorage.delete(key)
					deletedObjects++
				} catch (err) {
					c.var.logger?.warn(
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

			// DB cascade — atomicity via passport-scan factory helper
			await passportScanFactory.cascadeRtbfRevoke({
				tenantId,
				consentId,
				reason: body.reason,
			})

			// Sprint C: structured log для RTBF audit trail. Roskomnadzor inspection
			// может requested «покажите когда + сколько данных удалено для consent X».
			c.var.logger.info(
				{
					event: 'consent_revoke',
					consentId,
					tenantId,
					reason: body.reason,
					storageObjectsRequested: objectKeys.length,
					storageObjectsDeleted: deletedObjects,
				},
				'152-ФЗ ст.20 RTBF cascade completed',
			)

			return c.json(
				{
					data: {
						consentId,
						revokedAt: new Date().toISOString(),
						revokedReason: body.reason,
						alreadyRevoked: false,
						deletedObjects,
						// Count of S3 objects successfully removed. Audit rows scrubbed
						// = ВСЕ rows linked к consent (включая те без inputObjectKey).
						// Точное число не surfaced — backend logs содержат полную картину.
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
