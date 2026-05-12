/**
 * `media-storage-yandex-s3.ts` — production `MediaStorage` impl backed by
 * Yandex Object Storage (S3-compatible).
 *
 * **2026/2027 modern stack:**
 *   - `@aws-sdk/client-s3@3.10xx` — latest April 2026 release
 *   - `@aws-sdk/s3-request-presigner@3.10xx` — V4 signature pre-signing
 *   - Yandex S3 endpoint `https://storage.yandexcloud.net`, region `ru-central1`
 *   - Pre-signed PUT URLs с короткой TTL (5 min default — phishing-resistant)
 *   - V4 signature with explicit `Content-Type` + `Content-Length` constraints
 *     server-side (browser MUST send matching headers, иначе подпись недействительна)
 *
 * **Security guarantees:**
 *   - URL TTL 5 min → window для replay attacks мал
 *   - Signed Content-Type → browser cannot upload mismatched MIME
 *   - Bucket-only ACL (no public-read) → derived URLs go through CDN с auth-check
 *
 * **Cost optimization (per `project_deferred_deploy_plan.md`):**
 *   - Yandex Object Storage cold-tier для originals (low ~150₽/TB/mo)
 *   - Standard tier для derived variants (faster reads)
 *   - Lifecycle rules: original → cold-storage after 30 days
 *
 * Wired через `getMediaStorage()` lazy singleton — flip via APP_MODE / env.
 */
import { registerAdapter } from '../../lib/adapters/index.ts'
import type { MediaStorage } from './media-storage.ts'

// `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` are lazy-imported inside
// `getAwsBindings()` below (instead of top-level `import`). Two wins:
//
//   1. Backend boot in stub mode (default dev / test) avoids the ~50 ms cold load
//      of the AWS SDK + 200+ transitive dependencies; we only pay when the live
//      Yandex S3 adapter is actually instantiated in `APP_MODE=production`.
//
//   2. Vitest #9492 mitigation: with `isolate: false`, eager top-level imports
//      of `@aws-sdk/client-s3` from any other test file polluted the shared
//      worker module graph, so `vi.mock('@aws-sdk/client-s3', …)` in
//      `media-storage-yandex-s3.test.ts` was no-op — its hoisted interceptor
//      could not retroactively replace the already-resolved module. Lazy
//      `await import('@aws-sdk/client-s3')` resolves *inside* the test's worker
//      context where the mock is registered, restoring deterministic mocking.

export interface YandexS3StorageOptions {
	readonly endpoint: string
	readonly region: string
	readonly accessKeyId: string
	readonly secretAccessKey: string
	readonly bucket: string
	/** TTL для presigned URL (default 300 sec — 5 min). */
	readonly ttlSec?: number
	/** Test seam — override Date.now для deterministic expiresAt. */
	readonly now?: () => number
}

/**
 * Build production `MediaStorage` impl using AWS SDK v3 + Yandex S3.
 *
 * Per Yandex Object Storage docs (2026):
 *   - `forcePathStyle: true` обязательно (Yandex S3 не supports virtual-host
 *     style yet, в отличие от AWS S3)
 *   - Region must be `ru-central1` (other Yandex regions reject S3 v4 signature)
 */
interface AwsBindings {
	readonly client: import('@aws-sdk/client-s3').S3Client
	readonly PutObjectCommand: typeof import('@aws-sdk/client-s3').PutObjectCommand
	readonly GetObjectCommand: typeof import('@aws-sdk/client-s3').GetObjectCommand
	readonly getSignedUrl: typeof import('@aws-sdk/s3-request-presigner').getSignedUrl
}

export function createYandexS3MediaStorage(opts: YandexS3StorageOptions): MediaStorage {
	const ttlSec = opts.ttlSec ?? 300
	const bucket = opts.bucket
	const now = opts.now ?? Date.now

	let bindingsPromise: Promise<AwsBindings> | null = null
	async function getAwsBindings(): Promise<AwsBindings> {
		if (!bindingsPromise) {
			bindingsPromise = (async () => {
				const [{ GetObjectCommand, PutObjectCommand, S3Client }, { getSignedUrl }] =
					await Promise.all([import('@aws-sdk/client-s3'), import('@aws-sdk/s3-request-presigner')])
				const client = new S3Client({
					endpoint: opts.endpoint,
					region: opts.region,
					credentials: {
						accessKeyId: opts.accessKeyId,
						secretAccessKey: opts.secretAccessKey,
					},
					forcePathStyle: true,
				})
				return { client, PutObjectCommand, GetObjectCommand, getSignedUrl }
			})()
		}
		return bindingsPromise
	}

	return {
		mode: 'live',
		async getPresignedPut(input) {
			if (input.key.length === 0) throw new Error('key must be non-empty')
			if (input.maxBytes <= 0) throw new Error('maxBytes must be positive')
			const { client, PutObjectCommand, getSignedUrl } = await getAwsBindings()
			const cmd = new PutObjectCommand({
				Bucket: bucket,
				Key: input.key,
				ContentType: input.contentType,
				ContentLength: input.maxBytes,
			})
			const url = await getSignedUrl(client, cmd, { expiresIn: ttlSec })
			const expiresAt = new Date(now() + ttlSec * 1000).toISOString()
			return {
				url,
				headers: {
					'Content-Type': input.contentType,
				},
				expiresAt,
			}
		},
		getPublicUrl(key) {
			// Yandex Object Storage path-style URL. Bucket public-read ACL
			// disabled на старте — derived URL goes through CDN с auth-check.
			return `${opts.endpoint.replace(/\/$/, '')}/${bucket}/${key}`
		},
		async markDerivedReady(_key) {
			// In production this is no-op — Cloud Function trigger handles
			// derived processing async. The `propertyMedia.derivedReady`
			// column flips через CDC consumer when Cloud Function POSTs к
			// /media/:id/derived-ready endpoint. Returning true preserves
			// `MediaStorage` interface contract.
			return true
		},
		async getOriginalBytes(key) {
			const { client, GetObjectCommand } = await getAwsBindings()
			try {
				const cmd = new GetObjectCommand({ Bucket: bucket, Key: key })
				const res = await client.send(cmd)
				if (!res.Body) return null
				const chunks: Buffer[] = []
				for await (const chunk of res.Body as AsyncIterable<Buffer | string>) {
					chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
				}
				return Buffer.concat(chunks)
			} catch (err) {
				if (err instanceof Error && err.name === 'NoSuchKey') return null
				throw err
			}
		},
		async putDerivedBytes(key, bytes) {
			const { client, PutObjectCommand } = await getAwsBindings()
			const cmd = new PutObjectCommand({
				Bucket: bucket,
				Key: key,
				Body: bytes,
				ContentType: contentTypeFromKey(key),
			})
			await client.send(cmd)
		},
	}
}

function contentTypeFromKey(key: string): string {
	const ext = key.split('.').pop()?.toLowerCase()
	switch (ext) {
		case 'webp':
			return 'image/webp'
		case 'avif':
			return 'image/avif'
		case 'jpeg':
		case 'jpg':
			return 'image/jpeg'
		case 'png':
			return 'image/png'
		default:
			return 'application/octet-stream'
	}
}

let registered: MediaStorage | null = null

/**
 * Build + register the Yandex S3 adapter. Call once at boot when APP_MODE
 * is `production`. Subsequent calls return the same singleton.
 */
export function getYandexS3MediaStorage(opts: YandexS3StorageOptions): MediaStorage {
	if (registered) return registered
	registered = createYandexS3MediaStorage(opts)
	registerAdapter({
		name: 'media.yandex-s3',
		category: 'storage',
		mode: 'live',
		description:
			'Yandex Object Storage (S3-compat) — production media adapter via AWS SDK v3 + presigned-URL flow.',
	})
	return registered
}
