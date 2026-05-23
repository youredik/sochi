/**
 * Yandex Vision passport OCR route — Sprint B 2026-05-22 hardened.
 *
 * POST /api/v1/passport/scan
 *
 * Middleware chain (order critical):
 *   1. auth — session validation
 *   2. tenant — c.var.tenantId resolution
 *   3. bodyLimit — reject oversize до allocation (DoS defense)
 *   4. rateLimiter — 30 scans/min/tenant (cost + DoS defense)
 *   5. idempotency — Stripe-style Idempotency-Key dedup
 *   6. requirePermission('guest:update')
 *   7. zValidator — schema check
 *   8. handler
 *
 * Handler flow:
 *   a. Decode base64 → reject empty.
 *   b. Magic-byte sniff → reject MIME spoof / HEIC (400).
 *   c. Reject ebs/digital_id_max identityMethod (не OCR-flow, 400).
 *   d. INSERT photoConsentLog row (server-resolved IP + UA, ст.9 ч.4).
 *   e. Vision.recognizePassport() с try/catch (graceful).
 *   f. evaluateRklForScan() для non-RU (graceful — check_failed не throw).
 *   g. ALWAYS INSERT passportOcrAudit row (success OR failure, ст.21 ч.4).
 *   h. Response — visionResult + rklStatus + rklRegistryRevision.
 *
 * 152-ФЗ defenses:
 *   - Bytes never logged (Pino redact `*.imageBase64`, `*.bytes`, `*.content`).
 *   - Entities redacted in logs (`*.entities.*` paths).
 *   - Server clock + server-resolved IP — НЕ verbatim от client (forgeable).
 *   - Consent text accurately reflects что storage НЕ происходит.
 */

import { identityMethodSchema } from '@horeca/shared'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { rateLimiter } from 'hono-rate-limiter'
import { z } from 'zod'
import { env } from '../../../env.ts'
import type { AppEnv } from '../../../factory.ts'
import { extractClientIpFromContext } from '../../../lib/net/client-ip.ts'
import { assertMimeMatchesBytes } from '../../../lib/magic-byte-sniff.ts'
import { emitPassportScanMetric } from '../../../lib/ops-metrics.ts'
import { authMiddleware } from '../../../middleware/auth.ts'
import type { IdempotencyMiddleware } from '../../../middleware/idempotency.ts'
import { requirePermission } from '../../../middleware/require-permission.ts'
import { tenantMiddleware } from '../../../middleware/tenant.ts'
import type { GuestRepo } from '../../guest/guest.repo.ts'
import type { PassportScanFactory } from '../passport-scan/passport-scan.factory.ts'
import { evaluateRklForScan } from '../passport-scan/rkl/evaluate-rkl-for-scan.ts'
import type { PassportPhotoStorage } from '../passport-scan/storage/passport-photo-storage.ts'
import type { RklCheckAdapter } from '../rkl/types.ts'
import type { VisionOcrAdapter } from './types.ts'

/** Body size cap. 8MB — generous (frontend transcodes до ≤2MB JPEG обычно), Vision API limit 10MB. */
const BODY_LIMIT_BYTES = 8 * 1024 * 1024

/** Rate limit: 30 scans/min/tenant. Industry норма ~10 check-ins/час; 30/min cap covers группового заезда + retries без проблем. */
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 30

/** Vision API endpoint (для audit log). */
const VISION_API_ENDPOINT = 'https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText'

/**
 * Sprint C: 3-checkbox consent state per 152-ФЗ ст.10 + ст.11 defensive over-consent.
 * Per Roskomnadzor 2022 guidance (legalacts.ru/doc/razjasnenija-roskomnadzora), passport
 * scan storage-only ≠ biometric, BUT defensive 3-checkbox UI buys insurance против 2026
 * enforcement-year surprises (КоАП ч.16-17 биометрия = 3-18 млн ₽).
 *
 *   - generalPdn         — ст.6 общие ПДн (ФИО, паспорт, гражданство для миграц. учёта)
 *   - citizenshipSpecial — ст.10 ч.2 национальность beyond миграц. учёт purpose
 *   - biometricPhoto     — ст.11 ч.1 photo storage as documentary proof (defensive)
 */
const separateConsentsSchema = z.object({
	generalPdn: z.literal(true, { message: 'Согласие на общие ПДн обязательно' }),
	citizenshipSpecial: z.literal(true, {
		message: 'Согласие на спецкатегорию (национальность) обязательно',
	}),
	biometricPhoto: z.literal(true, { message: 'Согласие на хранение фото обязательно' }),
})

const scanPassportSchema = z.object({
	imageBase64: z.string().min(1, 'imageBase64 не может быть пустым'),
	mimeType: z.enum(['image/jpeg', 'image/png', 'application/pdf']),
	countryHint: z.string().min(2).max(3).nullable().optional(),
	identityMethod: identityMethodSchema.optional(),
	/** Soft FK guest.id — для photoConsentLog linkage. */
	guestId: z.string().min(1, 'guestId обязателен для consent linkage'),
	/** Frontend version snapshot — для аудита (что согласие версии X было shown). */
	consent152fzVersion: z.string().min(1),
	/**
	 * Sprint C: verbatim consent text shown to user в момент клика.
	 * Stored в photoConsentLog.textSnapshot для tamper-proof Roskomnadzor inspection
	 * (152-ФЗ ст.9 ч.4 «оператор обязан доказать получение»). Git history ≠ proof.
	 */
	consent152fzTextSnapshot: z.string().min(1, 'consent text snapshot обязателен (ст.9 ч.4)'),
	/** Sprint C: 3-checkbox state per ст.10 + ст.11 defensive over-consent. */
	separateConsents: separateConsentsSchema,
	consent152fzAccepted: z.literal(true, {
		message:
			'Согласие на обработку персональных данных по 152-ФЗ обязательно (separate document, 2025-09-01)',
	}),
})

export interface VisionRoutesDeps {
	readonly visionAdapter: VisionOcrAdapter
	readonly rklAdapter: RklCheckAdapter
	readonly idempotency: IdempotencyMiddleware
	/** Cross-tenant guestId ownership check. Без него audit log poisoned. */
	readonly guestRepo: GuestRepo
	/**
	 * Optional photo storage. 'disabled' mode пропускает upload — inputObjectKey
	 * остаётся null в audit. 'mock'/'yandex' uploads bytes for 90-day МВД-аудит
	 * retention (lifecycle policy native YC). Per Round 4 + Sprint C — two-stage
	 * PUT (PutObject + PutObjectTagging) для YC compatibility.
	 */
	readonly photoStorage: PassportPhotoStorage
	/**
	 * Sprint C: passport-scan factory — owns consent + audit repos + atomic
	 * write helper. Routes don't import `sql` directly (depcruise
	 * `no-routes-to-db` enforcement); factory layer encapsulates DB access.
	 */
	readonly passportScanFactory: PassportScanFactory
}

const rateLimitMessage = {
	error: {
		code: 'RATE_LIMITED',
		message:
			'Слишком много сканов в минуту. Подождите и попробуйте снова. Лимит = 30 сканов/мин на тенант.',
	},
} as const

/**
 * Inner router без auth/tenant middleware — для testing inject c.var.tenantId.
 * Production routes use createVisionRoutes() (wraps с auth+tenant).
 */
export function createVisionRoutesInner(deps: VisionRoutesDeps) {
	const { visionAdapter, rklAdapter, idempotency, guestRepo, photoStorage, passportScanFactory } =
		deps

	return new Hono<AppEnv>().post(
		'/passport/scan',
		bodyLimit({
			maxSize: BODY_LIMIT_BYTES,
			onError: (c) =>
				c.json(
					{
						error: {
							code: 'PAYLOAD_TOO_LARGE',
							message: `Файл превышает лимит ${Math.floor(BODY_LIMIT_BYTES / 1024 / 1024)} МБ. Используйте client-side compression (PWA автоматически перекодирует).`,
						},
					},
					413,
				),
		}),
		rateLimiter<AppEnv>({
			windowMs: RATE_LIMIT_WINDOW_MS,
			limit: RATE_LIMIT_MAX,
			// keyGenerator: c.var.tenantId set by tenantMiddleware ДО этого
			// middleware. Fallback к 'anonymous' graceful degrade.
			keyGenerator: (c) => c.var.tenantId ?? 'anonymous',
			standardHeaders: 'draft-7',
			statusCode: 429,
			message: rateLimitMessage,
		}),
		idempotency,
		requirePermission({ guest: ['update'] }),
		zValidator('json', scanPassportSchema),
		async (c) => {
			// Sprint C: 428 Precondition Required per IETF draft-ietf-httpapi-idempotency-
			// key-header-07 + Stripe canon (НЕ 400 — 400 = bad body shape, 428 = client must
			// add precondition header). Closes multi-instance rate-limit gap: idempotency
			// middleware writes к YDB глобально → даже multi-instance Serverless deduplicates.
			if (!c.req.header('Idempotency-Key')) {
				return c.json(
					{
						error: {
							code: 'IDEMPOTENCY_KEY_REQUIRED',
							message: 'Header `Idempotency-Key` обязателен для /passport/scan',
						},
					},
					428,
				)
			}

			const body = c.req.valid('json')
			const tenantId = c.var.tenantId
			const operatorUserId = c.var.session?.userId ?? c.var.user?.id ?? 'unknown'

			// (a) Decode base64 — guard empty.
			const archive = Uint8Array.from(Buffer.from(body.imageBase64, 'base64'))
			if (archive.length === 0) {
				return c.json(
					{
						error: {
							code: 'BAD_REQUEST',
							message: 'imageBase64 декодируется в пустой массив',
						},
					},
					400,
				)
			}

			// (b) Magic-byte sniffing — reject MIME spoof / HEIC.
			const mimeCheck = assertMimeMatchesBytes(body.mimeType, archive)
			if (!mimeCheck.ok) {
				return c.json(
					{
						error: {
							code: 'BAD_REQUEST',
							message: mimeCheck.reason,
						},
					},
					400,
				)
			}

			// (c) Reject не-OCR identityMethods early.
			if (body.identityMethod === 'ebs' || body.identityMethod === 'digital_id_max') {
				return c.json(
					{
						error: {
							code: 'BAD_REQUEST',
							message: `Тип документа '${body.identityMethod}' не сканируется через OCR — используйте biometric/QR flow`,
						},
					},
					400,
				)
			}

			// (c.5) Cross-tenant guestId ownership check. Round 3 finding —
			// operator из tenant A мог scan guest из tenant B, audit log
			// заражается cross-tenant references. Strict 404 если guest не
			// найден в текущем tenant context.
			const guest = await guestRepo.getById(tenantId, body.guestId)
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

			// (d) Server-clock + server-resolved IP + UA для consent audit trail.
			const ipAddress = extractClientIpFromContext(c, env.TRUSTED_PROXY_CIDRS)
			const userAgent = c.req.header('user-agent') ?? 'unknown'

			// (e) Vision call — wrap audit-ensuring try/catch.
			const identityMethod = body.identityMethod ?? 'passport_paper'
			const apiModel =
				identityMethod === 'passport_zagran'
					? 'page'
					: identityMethod === 'driver_license'
						? 'driver-license-front'
						: 'passport'

			let visionResult: Awaited<ReturnType<VisionOcrAdapter['recognizePassport']>> | null = null
			let visionError: Error | null = null
			try {
				visionResult = await visionAdapter.recognizePassport({
					bytes: archive,
					mimeType: body.mimeType,
					countryHint: body.countryHint ?? null,
					identityMethod,
				})
			} catch (err) {
				visionError = err instanceof Error ? err : new Error(String(err))
			}

			// (f) RKL check — graceful (не throw'ает).
			const rklEval = visionResult
				? await evaluateRklForScan(rklAdapter, {
						detectedCountryIso3: visionResult.detectedCountryIso3,
						entities: visionResult.entities,
						identityMethod,
					})
				: {
						status: 'check_failed' as const,
						matchType: null,
						registryRevision: null,
						latencyMs: 0,
					}

			// (f.5) Photo storage upload — ТОЛЬКО для successful Vision results.
			// 90-day retention в Object Storage для МВД-аудита (152-ФЗ ст.21 ч.4 +
			// bucket lifecycle policy native YC). Failure НЕ блокирует scan —
			// audit row пишется с inputObjectKey=null.
			let inputObjectKey: string | null = null
			if (
				photoStorage.mode !== 'disabled' &&
				visionResult !== null &&
				visionResult.outcome !== 'api_error'
			) {
				try {
					inputObjectKey = await photoStorage.put({
						tenantId,
						bytes: archive,
						contentType: body.mimeType,
					})
				} catch {
					// Storage failure — audit row пишется без objectKey. Operator
					// видит OCR result, но photo не retrieved для МВД re-audit.
					// Logged через handler ниже (audit log captures inputObjectKey=null).
					inputObjectKey = null
				}
			}

			// (g) ATOMIC consent + audit write per Sprint C — sql.begin canon
			// (18+ existing call sites: booking, compliance, magic-link, payment).
			// Если audit INSERT fails → consent INSERT rolls back → нет orphan
			// rows. Plus compensating delete для S3 object below.
			//
			// 152-ФЗ ст.21 ч.4 atomicity: consent + audit MUST be both present OR
			// both absent. До Sprint C — non-transactional → orphan consent
			// possible на audit DB failure (worst-case compliance scenario).
			//
			// Factory layer encapsulates sql.begin — routes don't import db/ directly.
			const atomicResult = await passportScanFactory.recordConsentAndAuditAtomic({
				consent: {
					tenantId,
					guestId: body.guestId,
					version: body.consent152fzVersion,
					scope: 'passport_ocr',
					acceptedAt: new Date(), // server clock — НЕ от frontend (clock skew)
					ipAddress,
					userAgent,
					textSnapshot: body.consent152fzTextSnapshot,
					separateConsents: body.separateConsents,
				},
				audit: {
					tenantId,
					operatorUserId,
					guestId: body.guestId,
					bookingId: null,
					documentId: null,
					inputMimeType: body.mimeType,
					inputSizeBytes: archive.length,
					inputObjectKey,
					apiEndpoint: VISION_API_ENDPOINT,
					apiModel,
					httpStatus: visionResult?.httpStatus ?? 0,
					latencyMs: visionResult?.latencyMs ?? 0,
					entities: visionResult?.entities ?? null,
					detectedCountryIso3: visionResult?.detectedCountryIso3 ?? null,
					isCountryWhitelisted: visionResult?.isCountryWhitelisted ?? false,
					apiConfidenceRaw: visionResult?.apiConfidenceRaw ?? null,
					confidenceHeuristic: visionResult?.confidenceHeuristic ?? null,
					outcome: visionResult?.outcome ?? 'api_error',
					rawResponseJson: null,
				},
			})
			const auditWriteFailed = !atomicResult.success

			// (g.5) Compensating delete для S3 object если audit/consent write failed —
			// иначе orphan PII в bucket без audit row (152-ФЗ ст.21 ч.4 violation).
			// Lifecycle policy 90-day GC = last-resort backstop, но мы delete immediately.
			let compensationFailed = false
			if (auditWriteFailed && inputObjectKey !== null) {
				try {
					await photoStorage.delete(inputObjectKey)
				} catch {
					// Forensic preservation — orphan persists, lifecycle 90d backstop.
					compensationFailed = true
				}
			}

			// (h.5) Sprint C: structured ops observability — single canonical log line
			// для YC Cloud Logging dashboards. PII fields НЕ логируются (redact paths
			// в logger.ts защищают defense-in-depth, плюс мы здесь явно НЕ передаём
			// entities/imageBase64/raw response). Pino redact list catches accidents.
			//
			// Канонические dashboards (YC Cloud Logging filter examples):
			//   - "passport_scan.outcome=api_error" — Vision API regression / cost spike
			//   - "passport_scan.rklStatus=match" — РКЛ blocks / fraud signal
			//   - "passport_scan.atomicWriteFailed=true" — 152-ФЗ ст.21 ч.4 breach risk
			//   - p99 of "passport_scan.latencyMs" — Yandex Vision SLA monitoring
			c.var.logger.info(
				{
					event: 'passport_scan',
					tenantId,
					guestId: body.guestId,
					identityMethod,
					apiModel,
					mimeType: body.mimeType,
					inputSizeBytes: archive.length,
					httpStatus: visionResult?.httpStatus ?? 0,
					latencyMs: visionResult?.latencyMs ?? 0,
					outcome: visionResult?.outcome ?? 'api_error',
					confidenceHeuristic: visionResult?.confidenceHeuristic ?? null,
					isCountryWhitelisted: visionResult?.isCountryWhitelisted ?? false,
					rklStatus: rklEval.status,
					rklMatchType: rklEval.matchType,
					inputObjectKeySet: inputObjectKey !== null,
					atomicWriteFailed: auditWriteFailed,
					compensationFailed,
					visionError: visionError === null ? null : visionError.name,
				},
				'passport_scan',
			)

			// (h.6) Sprint C: ops-metrics emission для future YC Monitoring exporter.
			// Buffer drained M11+. Labels low-cardinality (no tenantId/guestId).
			const outcomeForMetric = visionResult?.outcome ?? 'api_error'
			emitPassportScanMetric({
				kind: 'attempts',
				outcome: outcomeForMetric,
				identityMethod,
				apiModel,
				rklStatus: rklEval.status,
				value: 1,
			})
			if (visionResult !== null) {
				emitPassportScanMetric({
					kind: 'duration_ms',
					outcome: outcomeForMetric,
					identityMethod,
					apiModel,
					rklStatus: rklEval.status,
					value: visionResult.latencyMs,
				})
				// Yandex Vision pricing 0.71 ₽/call → 71 копеек (verified 2026-05-22 research).
				// passport model только если successful — failed calls не billed per Yandex docs.
				if (visionResult.outcome === 'success' || visionResult.outcome === 'low_confidence') {
					emitPassportScanMetric({
						kind: 'cost_kopecks',
						outcome: outcomeForMetric,
						identityMethod,
						apiModel,
						value: 71,
					})
				}
			}
			if (auditWriteFailed && compensationFailed) {
				emitPassportScanMetric({
					kind: 'orphan_compensation_failed',
					outcome: outcomeForMetric,
					identityMethod,
					apiModel,
					value: 1,
				})
			}

			// (h) Response. Если vision throw'нул — surface as 500 с generic message
			// (НЕ leak error.message что может содержать bytes/PII).
			if (visionError !== null || visionResult === null) {
				return c.json(
					{
						error: {
							code: 'VISION_API_ERROR',
							message: 'Сканирование документа временно недоступно. Попробуйте позже.',
						},
					},
					500,
				)
			}

			return c.json(
				{
					data: {
						...visionResult,
						rklStatus: rklEval.status,
						rklMatchType: rklEval.matchType,
						rklRegistryRevision: rklEval.registryRevision,
					},
				},
				200,
			)
		},
	)
}

export function createVisionRoutes(deps: VisionRoutesDeps) {
	return new Hono<AppEnv>()
		.use('*', authMiddleware(), tenantMiddleware())
		.route('/', createVisionRoutesInner(deps))
}
