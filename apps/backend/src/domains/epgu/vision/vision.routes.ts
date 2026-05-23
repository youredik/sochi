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
import { emitPassportScanMetric, passportScanCostKopecks } from '../../../lib/ops-metrics.ts'
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
 * Sprint C+ 2-checkbox consent state per legal-expert audit 2026-05-23d.
 *
 * Round 4 had 3 checkboxes incl. `citizenshipSpecial` ст.10 ч.1 label.
 * Legal-expert REFUTED: ст.10 ч.1 152-ФЗ verbatim covers «расовая, национальная
 * принадлежность» (ethnic origin), NOT citizenship. Citizenship (ISO 3166-1 code)
 * is general ПДн ст.6. Mis-labeling = first РКН-inspection blocker.
 *
 * Canonical 2-checkbox model:
 *   - generalPdn     — ст.6 ч.1 общие ПДн (ФИО, паспорт, гражданство, период)
 *   - biometricPhoto — ст.11 ч.1 фото паспорта как documentary proof
 *
 * Penalty floor (verified consultant.ru cons_doc_LAW_34661, ред. 420-ФЗ от
 * 30.11.2024 вступ. 30.05.2025, NOT 421-ФЗ which is УК): КоАП ст.13.11 ч.17
 * биометрия 15-20 млн ₽ юр.лиц; ч.18 повторно — оборотный 1-3% выручки
 * (min 25 млн, max 500 млн ₽, NOT 25-30).
 *
 * Backward-compat: `citizenshipSpecial` kept as `.optional()` so old clients
 * sending the legacy 3-field payload still pass validation. Server normalizes
 * to 2-field shape before storing.
 */
const separateConsentsSchema = z.object({
	generalPdn: z.literal(true, { message: 'Согласие на общие ПДн обязательно' }),
	biometricPhoto: z.literal(true, { message: 'Согласие на хранение фото обязательно' }),
	/**
	 * Legacy field (Round 4 pre-2026-05-23d): old clients may still send true.
	 * Server ignores value — only generalPdn + biometricPhoto are mandatory.
	 * Schema accepts `true` literal OR omitted; rejects `false` (catch corrupt clients).
	 */
	citizenshipSpecial: z.literal(true).optional(),
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
	consent152fzTextSnapshot: z
		.string()
		.min(1, 'consent text snapshot обязателен (ст.9 ч.4)')
		// Sprint C self-review I5 fix: max-length cap. Canonical consent text
		// ~3.5KB; 8KB = generous (включая operator identity injection до 1KB).
		// Prevents log-poisoning / DoS via 7+MB payloads (body limit catches
		// total, but per-field cap defends в case bodyLimit relaxes downstream).
		.max(8192, 'consent text snapshot >8 KB — подозрительный payload, обратитесь к администратору'),
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
			// Round 4 self-review YDB P0-RL-1 fix: per-IP fallback when tenantId
			// is null. Previous `'anonymous'` sentinel funneled ALL unauthenticated
			// requests в single bucket → first attacker exhausts для everyone.
			// Now per-IP (resolveClientIpSync canon) — separate buckets per source.
			keyGenerator: (c) =>
				c.var.tenantId ?? `ip:${extractClientIpFromContext(c, env.TRUSTED_PROXY_CIDRS)}`,
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

			// (a) Decode base64 — strict validation + guard empty.
			// Round 2 self-review Senior P0-5: Buffer.from(s, 'base64') silently
			// drops invalid characters per RFC 4648 lenient mode. Adversarial
			// `////` decodes к 3 bytes, passes length check, fails magic-sniff
			// — но counts к rate-limit budget. Strict pre-check rejects garbage
			// payloads до decoding.
			if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body.imageBase64)) {
				return c.json(
					{
						error: {
							code: 'BAD_REQUEST',
							message:
								'imageBase64 содержит недопустимые символы (RFC 4648 base64-canonical strict mode)',
						},
					},
					400,
				)
			}
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

			// (c) Reject не-OCR identityMethods early. Sprint C+ legal-expert audit
			// 2026-05-23d: added `mfsoi` (canonical ПП-1912 МФСОИ value, since
			// 2026-05-23d). All three are biometric/QR-style flows that don't pass
			// through Vision OCR — caller must use dedicated biometric/QR route.
			if (
				body.identityMethod === 'ebs' ||
				body.identityMethod === 'digital_id_max' ||
				body.identityMethod === 'mfsoi'
			) {
				return c.json(
					{
						error: {
							code: 'BAD_REQUEST',
							message: `Тип документа '${body.identityMethod}' не сканируется через OCR — используйте biometric/QR flow (ЕБС / Госуслуги-МАХ через МФСОИ)`,
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

			// Sprint C+ legal audit 2026-05-23d: normalize separateConsents to drop
			// optional legacy `citizenshipSpecial` field when undefined. Required because
			// tsconfig.exactOptionalPropertyTypes=true forbids passing `{key: undefined}`
			// to interface with `key?: boolean`. Strips field cleanly when omitted by
			// new clients (2-checkbox model); preserves it when sent by old clients.
			const normalizedSeparateConsents =
				body.separateConsents.citizenshipSpecial === undefined
					? {
							generalPdn: body.separateConsents.generalPdn,
							biometricPhoto: body.separateConsents.biometricPhoto,
						}
					: {
							generalPdn: body.separateConsents.generalPdn,
							biometricPhoto: body.separateConsents.biometricPhoto,
							citizenshipSpecial: body.separateConsents.citizenshipSpecial,
						}

			// (f.5+g) ATOMIC consent + audit write FIRST, upload AFTER (Sprint C+
			// Senior P0-2 fix 2026-05-23d). Round 4 had reverse order — upload before
			// atomic write — which produced this orphan-PII failure mode:
			//   1. upload bytes к S3 → objectKey X
			//   2. atomic consent+audit insert fails (transient YDB error)
			//   3. compensating S3 delete of X attempted
			//   4. compensating delete ALSO fails (e.g. S3 rate-limit)
			//   5. result: S3 object X exists with PII, NO audit row points to it,
			//      RTBF cascade cannot find it. 90-day lifecycle is last-resort backstop
			//      but есть window of 152-ФЗ ст.21 ч.4 forensic gap.
			// Reversed order eliminates this race entirely: NO upload happens until
			// audit row is committed. If subsequent upload fails, audit row stays
			// with inputObjectKey=null — no orphan possible.
			//
			// 152-ФЗ ст.21 ч.4 atomicity: consent + audit MUST be both present OR
			// both absent. Factory's sql.begin guarantees this. Routes don't import
			// db/ directly per depcruise canon.
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
					separateConsents: normalizedSeparateConsents,
				},
				audit: {
					tenantId,
					operatorUserId,
					guestId: body.guestId,
					bookingId: null,
					documentId: null,
					inputMimeType: body.mimeType,
					inputSizeBytes: archive.length,
					// Sprint C+ Senior P0-2: always null initially — set via repo.setObjectKey
					// AFTER successful S3 upload (next step). Prevents orphan PII.
					inputObjectKey: null,
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
					// Round 2 Legal P0-4 fix: persist Vision response shape для ст.21 ч.4
					// «возможность установления содержания обработанных данных».
					rawResponseJson:
						visionResult === null
							? null
							: {
									detectedCountryIso3: visionResult.detectedCountryIso3,
									isCountryWhitelisted: visionResult.isCountryWhitelisted,
									entities: visionResult.entities,
									apiConfidenceRaw: visionResult.apiConfidenceRaw,
									confidenceHeuristic: visionResult.confidenceHeuristic,
									outcome: visionResult.outcome,
									latencyMs: visionResult.latencyMs,
									httpStatus: visionResult.httpStatus,
								},
				},
			})
			const auditWriteFailed = !atomicResult.success
			if (auditWriteFailed) {
				c.var.logger.error(
					{
						event: 'passport_scan.atomic_write_failed',
						tenantId,
						guestId: body.guestId,
						errName: atomicResult.errName,
					},
					'consent+audit atomic write failed — 152-ФЗ ст.21 ч.4 forensic gap',
				)
			}

			// (g.5) Photo storage upload — ONLY after atomic write succeeded.
			// Two failure modes are now safe:
			//   (a) Upload fails → audit row stays with inputObjectKey=null. No orphan
			//       in S3. Operator sees OCR result; logged warning for forensic trail.
			//   (b) Upload succeeds but PATCH `setObjectKey` fails (rare — UPDATE with
			//       `WHERE inputObjectKey IS NULL` is idempotent) → orphan possible.
			//       Mitigation: lifecycle policy 90-day GC catches это. Empirically rare
			//       because PATCH is single-row UPDATE on PK (no contention).
			// Storage mode 'disabled' = skip upload entirely (test/dev fixtures).
			// 90-day retention в Object Storage для МВД-аудита (152-ФЗ ст.21 ч.4 +
			// bucket lifecycle policy native YC).
			let inputObjectKey: string | null = null
			let uploadFailed = false
			if (
				!auditWriteFailed &&
				atomicResult.auditId !== null &&
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
					// PATCH audit row to attach uploaded objectKey. Idempotent via
					// `WHERE inputObjectKey IS NULL` — repeat call cannot mutate.
					await passportScanFactory.auditRepo.setObjectKey(
						tenantId,
						atomicResult.auditId,
						inputObjectKey,
					)
				} catch (err) {
					// Storage failure → audit row stays with inputObjectKey=null. Operator
					// видит OCR result, но photo не retrievable для МВД re-audit. Logged
					// here для forensic trail. No orphan possible (nothing committed pre-fail).
					uploadFailed = true
					c.var.logger.warn(
						{
							event: 'passport_scan.storage_upload_failed',
							tenantId,
							guestId: body.guestId,
							auditId: atomicResult.auditId,
							err: err instanceof Error ? err.message : String(err),
						},
						'photo storage upload failed AFTER audit committed — audit row preserved with null objectKey',
					)
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
					uploadFailed,
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
				// Yandex Vision pricing — model-aware (passport/page/driver-license-* all
				// 0.71 ₽ = 71 копеек per Yandex AI Studio 2026-Q2). Self-review P1.4:
				// hardcoded `71` removed; passportScanCostKopecks() returns null for
				// unknown models so мы don't emit wrong cost.
				if (visionResult.outcome === 'success' || visionResult.outcome === 'low_confidence') {
					const costKop = passportScanCostKopecks(apiModel)
					if (costKop !== null) {
						emitPassportScanMetric({
							kind: 'cost_kopecks',
							outcome: outcomeForMetric,
							identityMethod,
							apiModel,
							value: costKop,
						})
					}
				}
			}
			// Sprint C+ Senior P0-2: replaced `orphan_compensation_failed` metric with
			// `upload_failed`. Reverse-order flow means no compensating delete needed —
			// upload failures don't create orphans (audit row stays valid с null key).
			if (uploadFailed) {
				emitPassportScanMetric({
					kind: 'upload_failed',
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

			// Round 4 self-review Senior P0-1 fix: if atomic consent+audit write
			// failed, operator MUST NOT receive 200 + entities. Otherwise frontend
			// saves данные гостя без consent/audit proof → 152-ФЗ ст.21 ч.4
			// breach + ст.9 ч.4 «оператор обязан доказать получение» violated.
			// Compensating S3 delete already ran (line 419 above). Operator UI
			// will surface 500 → они retry → новый Idempotency-Key → fresh attempt.
			if (auditWriteFailed) {
				return c.json(
					{
						error: {
							code: 'CONSENT_AUDIT_PERSIST_FAILED',
							message:
								'Согласие и аудит записать не удалось. Сканирование отменено. ' +
								'Попробуйте ещё раз; если ошибка повторяется — обратитесь к администратору.',
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
						// Sprint C+ Senior P0-1 fix 2026-05-23d: expose photoConsentLogId
						// so frontend can pass it to POST /guests/:id/documents/from-scan,
						// linking the new guestDocument row для RTBF cascade.
						photoConsentLogId: atomicResult.consentId,
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
