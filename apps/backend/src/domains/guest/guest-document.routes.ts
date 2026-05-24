/**
 * Guest document routes — POST /api/v1/guests/:guestId/documents/from-scan.
 *
 * **Sprint C+ Senior P0-1 fix 2026-05-23d**: closes dead-code gap exposed by
 * 5-parallel-expert audit. Round 4 had RTBF cascade UPDATE + DSAR list helper
 * defensively wired для guestDocument, but NO production route INSERTed rows.
 * This endpoint is the missing INSERT site.
 *
 * Flow:
 *   1. Frontend operator scans passport via /api/v1/passport/scan (Vision OCR
 *      + 152-ФЗ consent + audit).
 *   2. Operator confirms/edits extracted entities в confirm-form.
 *   3. Operator clicks Save → frontend POSTs operator-confirmed entities + the
 *      photoConsentLogId received from scan response к /api/v1/guests/:guestId/
 *      documents/from-scan.
 *   4. This endpoint INSERTs guestDocument linked via photoConsentLogId.
 *   5. RTBF cascade now has a real row to scrub when consent revoked.
 *
 * RBAC: requires `guest:update` — same permission as scan.
 * Cross-tenant: guestRepo.getById ensures guestId belongs к current tenant.
 *
 * Validation:
 *   - documentNumber: required (NOT NULL в schema)
 *   - citizenshipIso3: required (ISO 3166-1 alpha-3, lowercase canon)
 *   - identityMethod: enum from PassportScanDialog
 *   - photoConsentLogId: required + format `cns_*` (TypeID canon)
 *   - dates: YYYY-MM-DD ISO format or null
 */

import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../../factory.ts'
import { authMiddleware } from '../../middleware/auth.ts'
import { requirePermission } from '../../middleware/require-permission.ts'
import { tenantMiddleware } from '../../middleware/tenant.ts'
import type { GuestDocumentRepo } from './guest-document.repo.ts'
import type { GuestRepo } from './guest.repo.ts'

const isoDateOrNull = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата должна быть в формате YYYY-MM-DD')
	.nullable()
	.optional()

const fromScanBodySchema = z.object({
	identityMethod: z.enum(['passport_paper', 'passport_zagran', 'driver_license']),
	documentSeries: z.string().min(1).max(20).nullable().optional(),
	documentNumber: z.string().min(1, 'documentNumber обязателен').max(50),
	documentIssuedBy: z.string().min(1).max(300).nullable().optional(),
	documentIssuedDate: isoDateOrNull,
	documentExpiryDate: isoDateOrNull,
	citizenshipIso3: z
		.string()
		.regex(/^[a-z]{3}$/, 'citizenshipIso3 должен быть 3-буквенный ISO 3166-1 alpha-3 lowercase'),
	objectStoragePath: z.string().min(1).max(500).nullable().optional(),
	objectMimeType: z.enum(['image/jpeg', 'image/png', 'application/pdf']).nullable().optional(),
	objectSizeBytes: z
		.number()
		.int()
		.min(0)
		.max(30 * 1024 * 1024)
		.nullable()
		.optional(),
	ocrConfidenceHeuristic: z.number().min(0).max(1).nullable().optional(),
	/** Source of OCR data — defaults к 'yandex_vision' for scan-initiated flows. */
	ocrSource: z.enum(['yandex_vision', 'manual']).default('yandex_vision'),
	/** REQUIRED for RTBF cascade — photoConsentLog.id from preceding scan call. */
	photoConsentLogId: z.string().regex(/^cns_[A-Za-z0-9]+$/, 'photoConsentLogId формата cns_*'),
})

export interface GuestDocumentRoutesDeps {
	readonly guestRepo: GuestRepo
	readonly documentRepo: GuestDocumentRepo
}

/**
 * Inner router без auth/tenant middleware — для testing inject c.var.tenantId.
 * Production wrapper `createGuestDocumentRoutes` adds the chain.
 */
export function createGuestDocumentRoutesInner(deps: GuestDocumentRoutesDeps) {
	const { guestRepo, documentRepo } = deps
	return (
		new Hono<AppEnv>()
			.post(
				'/guests/:guestId/documents/from-scan',
				requirePermission({ guest: ['update'] }),
				zValidator('json', fromScanBodySchema),
				async (c) => {
					const guestId = c.req.param('guestId')
					const tenantId = c.var.tenantId
					const body = c.req.valid('json')
					const operatorUserId = c.var.session?.userId ?? c.var.user?.id ?? 'unknown'

					// Cross-tenant ownership — 404 если guest не в текущем тенант-контексте.
					const guest = await guestRepo.getById(tenantId, guestId)
					if (guest === null) {
						return c.json(
							{
								error: { code: 'NOT_FOUND', message: 'Гость не найден в текущем тенант-контексте' },
							},
							404,
						)
					}

					const documentId = await documentRepo.createFromScan({
						tenantId,
						guestId,
						identityMethod: body.identityMethod,
						documentSeries: body.documentSeries ?? null,
						documentNumber: body.documentNumber,
						documentIssuedBy: body.documentIssuedBy ?? null,
						documentIssuedDate: body.documentIssuedDate ?? null,
						documentExpiryDate: body.documentExpiryDate ?? null,
						citizenshipIso3: body.citizenshipIso3,
						objectStoragePath: body.objectStoragePath ?? null,
						objectMimeType: body.objectMimeType ?? null,
						objectSizeBytes: body.objectSizeBytes ?? null,
						ocrConfidenceHeuristic: body.ocrConfidenceHeuristic ?? null,
						ocrSource: body.ocrSource,
						photoConsentLogId: body.photoConsentLogId,
						createdBy: operatorUserId,
					})

					c.var.logger.info(
						{
							event: 'guest_document.from_scan_created',
							tenantId,
							guestId,
							documentId,
							identityMethod: body.identityMethod,
							photoConsentLogId: body.photoConsentLogId,
							operatorUserId,
							hasObjectStoragePath:
								body.objectStoragePath !== null && body.objectStoragePath !== undefined,
						},
						'guestDocument INSERTed from scan — RTBF cascade now linkable',
					)

					return c.json({ data: { documentId } }, 201)
				},
			)
			/**
			 * **2026-05-24** — Active guest-document lookup endpoint.
			 *
			 * Powers booking-edit-sheet hard-gate Заезд CTA per canonical May 2026 PMS
			 * UX (Stayntouch / Mews / Cloudbeds): check-in button is **disabled** when
			 * foreign-citizen guest lacks scanned passport row (ПП-1912 от 27.11.2025
			 * 24-hour МВД-учёт deadline + до 500k₽ КоАП — soft-warning = legal
			 * exposure).
			 *
			 * Returns ONLY presence indicator + last-4 of documentNumber +
			 * identityMethod badge. **No full PII** в response — operator UI doesn't
			 * need it для gating decision, and 152-ФЗ ст.18 minimization canon forbids
			 * over-fetch. Full document data flows via separate authenticated paths
			 * (DSAR export, scan dialog confirm-form re-entry).
			 *
			 * RBAC: `guest:read` (lighter than `update` since this is read-only).
			 *
			 * Returns `{ data: null }` when no active document exists — каноничный
			 * 200-with-null shape (НЕ 404, чтобы UI мог отличить «нет документа» от
			 * «guest не существует» — последнее = 404 cross-tenant guard).
			 */
			.get(
				'/guests/:guestId/documents/active',
				requirePermission({ guest: ['read'] }),
				async (c) => {
					const guestId = c.req.param('guestId')
					const tenantId = c.var.tenantId

					const guest = await guestRepo.getById(tenantId, guestId)
					if (guest === null) {
						return c.json(
							{
								error: { code: 'NOT_FOUND', message: 'Гость не найден в текущем тенант-контексте' },
							},
							404,
						)
					}

					const row = await documentRepo.findActiveForGuest(tenantId, guestId)
					if (row === null) {
						return c.json({ data: null }, 200)
					}

					// 152-ФЗ ст.18 minimization — repo уже masked документ; handler
					// никогда не видит full PII (defence-in-depth). scannedAt =
					// photoConsentLog.acceptedAt per ПП РФ № 9 audit canon — 24-hour
					// countdown стартует от оператор-clicked consent, NOT INSERT.
					return c.json(
						{
							data: {
								id: row.id,
								identityMethod: row.identityMethod,
								documentNumberMaskedTail: row.documentNumberMaskedTail,
								citizenshipIso3: row.citizenshipIso3,
								scannedAt: row.scannedAt.toISOString(),
							},
						},
						200,
					)
				},
			)
	)
}

export function createGuestDocumentRoutes(deps: GuestDocumentRoutesDeps) {
	return new Hono<AppEnv>()
		.use('*', authMiddleware(), tenantMiddleware())
		.route('/', createGuestDocumentRoutesInner(deps))
}
