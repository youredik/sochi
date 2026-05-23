/**
 * Passport photo storage — YC Object Storage (S3-compatible) для 90-дневного
 * audit retention per 152-ФЗ ст.21 ч.4 + ст.21 ч.7.
 *
 * Sprint B 2026-05-22 — закрывает gap из Round 4: предыдущий fix убрал текст
 * консента «storage» полностью, но canon ВСЕГДА планировал 90-day photo
 * retention для МВД-аудиторских проверок и retraining heuristic confidence
 * (per migration 0037 doc § «90-day retention»).
 *
 * NATIVE YC FEATURES applied here:
 *   - YC Object Storage S3-compatible API (existing `@aws-sdk/client-s3` deps)
 *   - Path namespace `tenant/{tenantId}/passport/{uuid}.{ext}` — tenant isolation
 *   - Bucket lifecycle policy 90-дневный auto-delete (configured в Terraform,
 *     не в application code per canon `feedback_yandex_cloud_only`)
 *   - SSE-S3 encryption-at-rest native (без extra config — YC default)
 *
 * Failure mode: if upload fails — audit row still pisется без objectKey.
 * Vision OCR result already extracted → operator может save data. Re-fetch
 * для МВД-аудита будет невозможен для этого scan'а — operational gap,
 * не безопасностный (mitigated by audit log retention 90д).
 */

import type { S3Client as S3ClientType } from '@aws-sdk/client-s3'

export interface PassportPhotoStorageInput {
	readonly tenantId: string
	readonly bytes: Uint8Array
	readonly contentType: 'image/jpeg' | 'image/png' | 'application/pdf'
}

export interface PassportPhotoStorage {
	readonly mode: 'live' | 'mock' | 'disabled'
	/**
	 * Upload photo bytes, return object key (для audit log inputObjectKey field).
	 * Throws on failure — caller wraps в try/catch для graceful degradation.
	 */
	put(input: PassportPhotoStorageInput): Promise<string>
	/**
	 * Delete object by key. Used for:
	 *   1. Compensating delete if audit INSERT fails (orphan PII prevention)
	 *   2. RTBF cascade — 152-ФЗ ст.20 (право отзыва) + ст.21 ч.5 (30-day
	 *      destruction SLA). Our cascade runs immediately << SLA.
	 *
	 * Idempotent — non-existent key returns void (S3 DELETE is idempotent).
	 * Throws на network / auth failure — caller logs but не cascade-fail main flow
	 * (lifecycle policy 90-day GC as last-resort backstop).
	 */
	delete(objectKey: string): Promise<void>
}

export interface YandexS3PassportStorageOptions {
	readonly endpoint: string
	readonly region: string
	readonly accessKeyId: string
	readonly secretAccessKey: string
	readonly bucket: string
	/** UUID generator (injectable для tests). */
	readonly uuid?: () => string
}

/** Map mimeType → file extension для object key. */
function extensionForMime(mime: string): 'jpg' | 'png' | 'pdf' {
	if (mime === 'image/jpeg') return 'jpg'
	if (mime === 'image/png') return 'png'
	return 'pdf'
}

interface AwsBindings {
	readonly client: S3ClientType
	readonly PutObjectCommand: typeof import('@aws-sdk/client-s3').PutObjectCommand
	readonly PutObjectTaggingCommand: typeof import('@aws-sdk/client-s3').PutObjectTaggingCommand
	readonly DeleteObjectCommand: typeof import('@aws-sdk/client-s3').DeleteObjectCommand
}

/**
 * Live YC Object Storage implementation. Lazy import @aws-sdk per pattern
 * `media-storage-yandex-s3.ts` (worker module graph testability).
 */
export function createYandexS3PassportStorage(
	opts: YandexS3PassportStorageOptions,
): PassportPhotoStorage {
	const uuid = opts.uuid ?? (() => crypto.randomUUID())

	let bindingsPromise: Promise<AwsBindings> | null = null
	async function getAwsBindings(): Promise<AwsBindings> {
		if (!bindingsPromise) {
			bindingsPromise = (async () => {
				const { PutObjectCommand, PutObjectTaggingCommand, DeleteObjectCommand, S3Client } =
					await import('@aws-sdk/client-s3')
				const client = new S3Client({
					endpoint: opts.endpoint,
					region: opts.region,
					credentials: {
						accessKeyId: opts.accessKeyId,
						secretAccessKey: opts.secretAccessKey,
					},
					forcePathStyle: true, // YC S3 canon
				})
				return { client, PutObjectCommand, PutObjectTaggingCommand, DeleteObjectCommand }
			})()
		}
		return bindingsPromise
	}

	return {
		mode: 'live',
		async put(input) {
			if (input.bytes.length === 0) throw new Error('bytes empty — нечего uploadить')
			const ext = extensionForMime(input.contentType)
			const objectKey = `tenant/${input.tenantId}/passport/${uuid()}.${ext}`
			const { client, PutObjectCommand, PutObjectTaggingCommand, DeleteObjectCommand } =
				await getAwsBindings()

			// (1) Upload — без inline Tagging (YC ignores `x-amz-tagging` header per
			//     empirical research May 2026 — yandex.cloud/en/docs/storage/s3/api-ref/object/upload
			//     не listing `x-amz-tagging` среди supported headers).
			//     AWS S3 honors inline tagging, но YC silently drops → lifecycle never fires.
			//     Fix: explicit PutObjectTagging call after PUT (XML body, гарантированно works).
			const putCmd = new PutObjectCommand({
				Bucket: opts.bucket,
				Key: objectKey,
				Body: input.bytes,
				ContentType: input.contentType,
				// SSE-S3 encryption-at-rest — YC native default + explicit для audit trail.
				ServerSideEncryption: 'AES256',
				// Inline Tagging — AWS S3 honors, YC silent. Defense-in-depth — explicit
				// PutObjectTagging ниже гарантирует YC compliance.
				Tagging: 'retention=90d&data-class=pii-passport',
			})
			await client.send(putCmd)

			// (2) Explicit PutObjectTagging — гарантирует YC tags set (lifecycle filter
			//     filter.tag matches Tagging API, НЕ Metadata).
			try {
				await client.send(
					new PutObjectTaggingCommand({
						Bucket: opts.bucket,
						Key: objectKey,
						Tagging: {
							TagSet: [
								{ Key: 'retention', Value: '90d' },
								{ Key: 'data-class', Value: 'pii-passport' },
							],
						},
					}),
				)
			} catch (tagErr) {
				// Critical: tagging failed → lifecycle won't catch → manual cleanup needed.
				// Compensating delete to prevent orphan PII без retention tag.
				try {
					await client.send(new DeleteObjectCommand({ Bucket: opts.bucket, Key: objectKey }))
				} catch {
					// Forensic preservation — orphan persists, lifecycle backup в 90d worst-case.
				}
				throw new Error(
					`PII upload aborted: tagging failed (lifecycle would not fire) — ${
						tagErr instanceof Error ? tagErr.message : String(tagErr)
					}`,
				)
			}

			return objectKey
		},
		async delete(objectKey) {
			const { client, DeleteObjectCommand } = await getAwsBindings()
			await client.send(new DeleteObjectCommand({ Bucket: opts.bucket, Key: objectKey }))
		},
	}
}

/**
 * Mock implementation для tests + APP_MODE=sandbox без YC creds. Generates
 * canonical-shape key без actual upload. Production swap = factory binding.
 */
export function createMockPassportPhotoStorage(opts?: {
	readonly uuid?: () => string
}): PassportPhotoStorage {
	const uuid = opts?.uuid ?? (() => crypto.randomUUID())
	const deletedKeys = new Set<string>() // tests can inspect via debug helper if needed
	return {
		mode: 'mock',
		async put(input) {
			if (input.bytes.length === 0) throw new Error('bytes empty')
			const ext = extensionForMime(input.contentType)
			return `tenant/${input.tenantId}/passport/${uuid()}.${ext}`
		},
		async delete(objectKey) {
			deletedKeys.add(objectKey)
		},
	}
}

/**
 * Disabled storage — no-op для APP_MODE с storage feature flag off.
 * Returns sentinel string чтобы audit row показывал явную disabled state vs error.
 */
export function createDisabledPassportPhotoStorage(): PassportPhotoStorage {
	return {
		mode: 'disabled',
		async put() {
			throw new Error('Passport photo storage disabled — set PASSPORT_PHOTO_STORAGE=mock|yandex')
		},
		async delete() {
			// no-op — nothing to delete when storage disabled
		},
	}
}
