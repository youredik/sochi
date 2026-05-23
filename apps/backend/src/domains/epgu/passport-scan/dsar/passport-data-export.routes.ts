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
import type { AppEnv } from '../../../../factory.ts'
import { authMiddleware } from '../../../../middleware/auth.ts'
import { requirePermission } from '../../../../middleware/require-permission.ts'
import { tenantMiddleware } from '../../../../middleware/tenant.ts'
import type { GuestRepo } from '../../../guest/guest.repo.ts'
import type { PassportScanFactory } from '../passport-scan.factory.ts'

export interface PassportDataExportRoutesDeps {
	readonly passportScanFactory: PassportScanFactory
	readonly guestRepo: GuestRepo
}

export function createPassportDataExportRoutesInner(deps: PassportDataExportRoutesDeps) {
	const { passportScanFactory, guestRepo } = deps
	const { consentRepo, auditRepo } = passportScanFactory
	return new Hono<AppEnv>().get(
		'/guests/:guestId/passport-data-export',
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
