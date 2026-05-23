/**
 * Data Subject Access Request (DSAR) endpoint — 152-ФЗ ст.14 (30 рабочих дней).
 *
 * GET /api/v1/guests/:guestId/passport-data-export
 *
 * Sprint C 2026-05-22 — closes Round 4+5 legal blocker: ст.14 mandates оператор
 * обязан предоставить субъекту ПДн «информация… о наличии ПДн… способах их
 * обработки… сроках хранения». Endpoint returns JSON dump всех consents + scans
 * для гостя в нашем tenant.
 *
 * RBAC: requires `guest:read` permission — operator triggers export от имени
 * гостя (front-desk workflow: гость подходит, просит выдать его данные).
 *
 * Cross-tenant: guestRepo.getById(tenantId, guestId) → 404 если cross-tenant.
 *
 * Response shape (downloadable JSON):
 *   {
 *     exportedAt: ISO timestamp,
 *     guestId, tenantId,
 *     consents: PhotoConsentLogRow[],  // all consent history (active + revoked)
 *     scans: PassportOcrAuditExportRow[], // OCR audit trail (entities nullified after revoke)
 *   }
 */

import { Hono } from 'hono'
import { rateLimiter } from 'hono-rate-limiter'
import type { AppEnv } from '../../../../factory.ts'
import { authMiddleware } from '../../../../middleware/auth.ts'
import { requirePermission } from '../../../../middleware/require-permission.ts'
import { tenantMiddleware } from '../../../../middleware/tenant.ts'
import type { GuestRepo } from '../../../guest/guest.repo.ts'
import type { PassportScanFactory } from '../passport-scan.factory.ts'

/**
 * Sprint C Day 3+: DSAR endpoint rate limit 30/min/tenant. Heavier than
 * revoke (DB aggregation + larger response payload). Realistic operator
 * workflow = 1 DSAR request per minute max.
 */
const DSAR_RATE_LIMIT_WINDOW_MS = 60_000
const DSAR_RATE_LIMIT_MAX = 30

export interface PassportDataExportRoutesDeps {
	readonly passportScanFactory: PassportScanFactory
	readonly guestRepo: GuestRepo
}

export function createPassportDataExportRoutesInner(deps: PassportDataExportRoutesDeps) {
	const { passportScanFactory, guestRepo } = deps
	const { consentRepo, auditRepo } = passportScanFactory
	return new Hono<AppEnv>().get(
		'/guests/:guestId/passport-data-export',
		rateLimiter<AppEnv>({
			windowMs: DSAR_RATE_LIMIT_WINDOW_MS,
			limit: DSAR_RATE_LIMIT_MAX,
			keyGenerator: (c) => c.var.tenantId ?? 'anonymous',
			standardHeaders: 'draft-7',
			statusCode: 429,
			message: {
				error: {
					code: 'RATE_LIMITED',
					message: 'Слишком много DSAR-запросов в минуту. Лимит = 30/мин на тенант.',
				},
			},
		}),
		requirePermission({ guest: ['read'] }),
		async (c) => {
			const guestId = c.req.param('guestId')
			const tenantId = c.var.tenantId

			// Cross-tenant guard — same canon as vision route
			const guest = await guestRepo.getById(tenantId, guestId)
			if (guest === null) {
				return c.json(
					{
						error: {
							code: 'NOT_FOUND',
							message: 'Гость не найден в текущем тенант-контексте',
						},
					},
					404,
				)
			}

			// Aggregate всех consent + audit rows для гостя
			const [consents, scans] = await Promise.all([
				consentRepo.findByGuestId(tenantId, guestId),
				auditRepo.findByGuestId(tenantId, guestId),
			])

			const exportPayload = {
				exportedAt: new Date().toISOString(),
				guestId,
				tenantId,
				dataSubjectRights: {
					article: '152-ФЗ ст.14 (право на ознакомление)',
					revokeUrl: `/api/v1/passport-scan/consent/{consentId}/revoke`,
					retentionPolicy: {
						consentLog: '5 лет (152-ФЗ ст.21 ч.7)',
						scanAudit: '90 дней (миграционное закон-во)',
						photoStorage: '90 дней (lifecycle policy)',
					},
				},
				consents: consents.map((c) => ({
					id: c.id,
					version: c.version,
					scope: c.scope,
					acceptedAt: c.acceptedAt.toISOString(),
					textSnapshot: c.textSnapshot, // verbatim text shown
					separateConsents: c.separateConsents, // ст.10+ст.11 multi-checkbox state
					revokedAt: c.revokedAt?.toISOString() ?? null,
					revokedReason: c.revokedReason,
				})),
				scans: scans.map((s) => ({
					id: s.id,
					createdAt: s.createdAt.toISOString(),
					outcome: s.outcome,
					apiModel: s.apiModel,
					entities: s.entities, // nullified if revoked (entitiesAnonymizedAt set)
					confidenceHeuristic: s.confidenceHeuristic,
					entitiesAnonymizedAt: s.entitiesAnonymizedAt?.toISOString() ?? null,
				})),
			}

			// Sprint C: structured ops log для DSAR access audit trail. Roskomnadzor
			// inspection: «покажите кто и когда выгружал данные для guestId X».
			// Operator user ID + counts — для accountability per 152-ФЗ ст.21 ч.4.
			c.var.logger.info(
				{
					event: 'passport_data_export',
					tenantId,
					guestId,
					operatorUserId: c.var.session?.userId ?? c.var.user?.id ?? 'unknown',
					consentCount: consents.length,
					scanCount: scans.length,
				},
				'152-ФЗ ст.14 DSAR export served',
			)

			// Downloadable JSON — operator может save и передать гостю.
			return c.json({ data: exportPayload }, 200, {
				'Content-Disposition': `attachment; filename="passport-data-${guestId}-${new Date().toISOString().slice(0, 10)}.json"`,
			})
		},
	)
}

export function createPassportDataExportRoutes(deps: PassportDataExportRoutesDeps) {
	return new Hono<AppEnv>()
		.use('*', authMiddleware(), tenantMiddleware())
		.route('/', createPassportDataExportRoutesInner(deps))
}
