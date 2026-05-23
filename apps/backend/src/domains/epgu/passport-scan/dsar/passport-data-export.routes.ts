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
	const { consentRepo, auditRepo, listGuestDocumentsForExport } = passportScanFactory
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

			// Sprint C self-review I9 fix: Promise.allSettled vs all — partial DB
			// failure не cripples весь DSAR (152-ФЗ ст.14 30-day SLA — нельзя
			// systemically fail). Каждый leg fails в isolation, report partial
			// dataset с explicit warnings field так что guest и Roskomnadzor видят
			// что fetch не завершился полностью.
			//
			// Round 2 Legal P0-1 fix: guestDocument leg ADDED — 152-ФЗ ст.14
			// требует «обрабатываемые персональные данные» полный объём, не
			// только consent + audit. До Round 2 guestDocument PII silently
			// dropped из DSAR.
			const [consentsResult, scansResult, documentsResult] = await Promise.allSettled([
				consentRepo.findByGuestId(tenantId, guestId),
				auditRepo.findByGuestId(tenantId, guestId),
				listGuestDocumentsForExport(tenantId, guestId),
			])
			const consents = consentsResult.status === 'fulfilled' ? consentsResult.value : []
			const scans = scansResult.status === 'fulfilled' ? scansResult.value : []
			const documents = documentsResult.status === 'fulfilled' ? documentsResult.value : []
			const warnings: string[] = []
			if (documentsResult.status === 'rejected') {
				warnings.push('Не удалось получить документы гостя — обратитесь к администратору.')
				c.var.logger.error(
					{
						event: 'passport_data_export.documents_fetch_failed',
						tenantId,
						guestId,
						err:
							documentsResult.reason instanceof Error
								? documentsResult.reason.message
								: String(documentsResult.reason),
					},
					'DSAR partial failure — documents leg',
				)
			}
			if (consentsResult.status === 'rejected') {
				warnings.push(
					'Не удалось получить журнал согласий — обратитесь к администратору. ' +
						'Этот частичный экспорт НЕ заменяет полное обращение по ст.14 152-ФЗ.',
				)
				c.var.logger.error(
					{
						event: 'passport_data_export.consents_fetch_failed',
						tenantId,
						guestId,
						err:
							consentsResult.reason instanceof Error
								? consentsResult.reason.message
								: String(consentsResult.reason),
					},
					'DSAR partial failure — consents leg',
				)
			}
			if (scansResult.status === 'rejected') {
				warnings.push('Не удалось получить аудит OCR — обратитесь к администратору.')
				c.var.logger.error(
					{
						event: 'passport_data_export.scans_fetch_failed',
						tenantId,
						guestId,
						err:
							scansResult.reason instanceof Error
								? scansResult.reason.message
								: String(scansResult.reason),
					},
					'DSAR partial failure — scans leg',
				)
			}

			// Self-review I10 fix: truncation warning surfaced explicitly.
			// repo LIMIT 1000 / consent LIMIT 1000 — at limit means возможны more.
			const CONSENT_LIMIT = 1000
			const SCAN_LIMIT = 1000
			const DOCUMENT_LIMIT = 1000
			if (consents.length >= CONSENT_LIMIT) {
				warnings.push(
					`Возвращены последние ${CONSENT_LIMIT} согласий. ` +
						'Для полной выгрузки обратитесь к оператору письменно (152-ФЗ ст.14).',
				)
			}
			if (scans.length >= SCAN_LIMIT) {
				warnings.push(
					`Возвращены последние ${SCAN_LIMIT} сканов. ` +
						'Для полной выгрузки обратитесь к оператору письменно (152-ФЗ ст.14).',
				)
			}
			if (documents.length >= DOCUMENT_LIMIT) {
				warnings.push(
					`Возвращены последние ${DOCUMENT_LIMIT} документов. ` +
						'Для полной выгрузки обратитесь к оператору письменно (152-ФЗ ст.14).',
				)
			}

			const exportPayload = {
				exportedAt: new Date().toISOString(),
				guestId,
				tenantId,
				warnings: warnings.length > 0 ? warnings : undefined,
				dataSubjectRights: {
					article: '152-ФЗ ст.14 (право на ознакомление)',
					revokeUrl: `/api/v1/passport-scan/consent/{consentId}/revoke`,
					retentionPolicy: {
						consentLog: '5 лет (152-ФЗ ст.21 ч.7)',
						scanAudit: '90 дней (миграционное закон-во)',
						photoStorage: '90 дней (lifecycle policy)',
						guestDocument: '5 лет (152-ФЗ + миграц. законодательство)',
					},
				},
				consents: consents.map((consent) => ({
					id: consent.id,
					version: consent.version,
					scope: consent.scope,
					acceptedAt: consent.acceptedAt.toISOString(),
					textSnapshot: consent.textSnapshot, // verbatim text shown
					separateConsents: consent.separateConsents, // ст.10+ст.11 multi-checkbox state
					revokedAt: consent.revokedAt?.toISOString() ?? null,
					revokedReason: consent.revokedReason,
				})),
				scans: scans.map((scan) => ({
					id: scan.id,
					createdAt: scan.createdAt.toISOString(),
					outcome: scan.outcome,
					apiModel: scan.apiModel,
					entities: scan.entities, // nullified if revoked (entitiesAnonymizedAt set)
					confidenceHeuristic: scan.confidenceHeuristic,
					entitiesAnonymizedAt: scan.entitiesAnonymizedAt?.toISOString() ?? null,
				})),
				// Round 2 Legal P0-1 fix: guestDocument PII included per ст.14.
				documents: documents.map((doc) => ({
					id: doc.id,
					identityMethod: doc.identityMethod,
					documentSeries: doc.documentSeries,
					documentNumber: doc.documentNumber,
					documentIssuedBy: doc.documentIssuedBy,
					documentIssuedDate: doc.documentIssuedDate?.toISOString().slice(0, 10) ?? null,
					documentExpiryDate: doc.documentExpiryDate?.toISOString().slice(0, 10) ?? null,
					citizenshipIso3: doc.citizenshipIso3,
					objectStoragePath: doc.objectStoragePath, // structured pointer, не raw PII
					createdAt: doc.createdAt.toISOString(),
					entitiesAnonymizedAt: doc.entitiesAnonymizedAt?.toISOString() ?? null,
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
					documentCount: documents.length,
					warningsCount: warnings.length,
				},
				'152-ФЗ ст.14 DSAR export served',
			)

			// Self-review P0-3 fix: explicit cache + sniff prevention. Self-review
			// P2-6: sanitize filename — guestId already TypeID-formatted (alphanumeric +
			// underscore) per @horeca/shared/newId canon, no path-traversal risk.
			const safeFilename = guestId.replace(/[^a-zA-Z0-9_-]/g, '')
			const datePart = new Date().toISOString().slice(0, 10)
			return c.json({ data: exportPayload }, 200, {
				'Content-Disposition': `attachment; filename="passport-data-${safeFilename}-${datePart}.json"`,
				'Cache-Control': 'no-store, no-cache, must-revalidate, private',
				Pragma: 'no-cache',
				'X-Content-Type-Options': 'nosniff',
				// Defense-in-depth: PII export response must NOT linger в browser cache.
			})
		},
	)
}

export function createPassportDataExportRoutes(deps: PassportDataExportRoutesDeps) {
	return new Hono<AppEnv>()
		.use('*', authMiddleware(), tenantMiddleware())
		.route('/', createPassportDataExportRoutesInner(deps))
}
