/**
 * `MediaStorage` adapter interface.
 *
 * Real implementation: Yandex Object Storage (S3-compatible) — deferred to
 * M9 deploy phase per `project_demo_strategy.md`. For now we register a
 * Stub adapter so the upload flow round-trips locally (tests + e2e):
 *
 *   1. Operator UI calls `getPresignedPut(key, contentType)`.
 *   2. Stub returns a fake URL pointing at a local in-memory bucket.
 *   3. Browser PUTs to URL — Stub stores bytes in memory.
 *   4. Backend records metadata in `propertyMedia`.
 *   5. (Real impl only) Cloud Function trigger generates derived variants;
 *      Stub flips `derivedReady=true` synchronously on `markDerivedReady`.
 *
 * Wired into `lib/adapters/registry.ts` as `media.stub` (mock-mode) so
 * production startup gate refuses launch without an explicit allow-list
 * entry — see M8.0 prep canon.
 */

import { registerAdapter } from '../../lib/adapters/index.ts'

/**
 * Pre-signed PUT URL response. `expiresAt` lets the operator UI decide
 * whether to re-request before kicking off the upload.
 */
export interface PresignedPut {
	readonly url: string
	/** Headers the browser MUST include with the PUT (Content-Type, etc.). */
	readonly headers: Readonly<Record<string, string>>
	readonly expiresAt: string
}

export interface MediaStorage {
	readonly mode: 'mock' | 'sandbox' | 'live'
	getPresignedPut(opts: {
		readonly key: string
		readonly contentType: string
		readonly maxBytes: number
	}): Promise<PresignedPut>
	getPublicUrl(key: string): string
	/**
	 * Mark derived variants ready (in real impl this is the Cloud Function
	 * callback handler; in stub this is a synchronous helper for tests).
	 *
	 * Returns true if the original existed (and the marker was applied),
	 * false if no upload was registered for this key.
	 */
	markDerivedReady(key: string): Promise<boolean>
	/** Test seam: count of in-memory uploads (Stub only — real impl returns -1). */
	debugUploadCount?(): number
}

// ─── In-memory Stub ──────────────────────────────────────────────────────

interface StubUploadRecord {
	readonly contentType: string
	readonly maxBytes: number
	readonly putUrl: string
	derivedReady: boolean
}

export interface StubMediaStorageOptions {
	/** Base URL that pre-signed URLs are anchored to. */
	readonly baseUrl?: string
	/** Test seam — controls the `expiresAt` returned in presigned response. */
	readonly now?: () => number
	/** Test seam — pre-signed URL TTL in seconds. */
	readonly ttlSec?: number
}

/**
 * Local in-process Stub. Behaves like a real S3 enough for service-layer
 * tests + e2e: each PUT URL is unique, derived-ready marker can be flipped,
 * counts are observable via `debugUploadCount`.
 *
 * NOT thread-safe across processes — each process gets its own Map.
 */
export function createStubMediaStorage(opts: StubMediaStorageOptions = {}): MediaStorage {
	const baseUrl = opts.baseUrl ?? 'http://stub.media.local'
	const now = opts.now ?? Date.now
	const ttlSec = opts.ttlSec ?? 300 // 5 min default — matches real S3 short-lived presign

	const uploads = new Map<string, StubUploadRecord>()
	let presignCounter = 0

	return {
		mode: 'mock',
		async getPresignedPut(input) {
			if (input.key.length === 0) throw new Error('key must be non-empty')
			if (input.maxBytes <= 0) throw new Error('maxBytes must be positive')
			presignCounter += 1
			const putUrl = `${baseUrl}/put/${presignCounter}/${input.key}`
			uploads.set(input.key, {
				contentType: input.contentType,
				maxBytes: input.maxBytes,
				putUrl,
				derivedReady: false,
			})
			const expiresAt = new Date(now() + ttlSec * 1000).toISOString()
			return {
				url: putUrl,
				headers: {
					'Content-Type': input.contentType,
					'X-Stub-Max-Bytes': String(input.maxBytes),
				},
				expiresAt,
			}
		},
		getPublicUrl(key) {
			return `${baseUrl}/public/${key}`
		},
		async markDerivedReady(key) {
			const rec = uploads.get(key)
			if (!rec) return false
			rec.derivedReady = true
			return true
		},
		debugUploadCount() {
			return uploads.size
		},
	}
}

let registered: MediaStorage | null = null

/**
 * Lazy singleton. The first call creates the Stub and registers it in the
 * adapter registry; subsequent calls return the same instance. Tests that
 * need isolation should call `__resetMediaStorageForTests`.
 */
export function getMediaStorage(): MediaStorage {
	if (registered) return registered
	registered = createStubMediaStorage()
	registerAdapter({
		name: 'media.stub',
		category: 'storage',
		mode: 'mock',
		description:
			'In-process media storage stub (presigned PUT + getPublicUrl). Replace with media.yandex-s3 in M9 deploy.',
	})
	return registered
}

/** Test-only helper. Resets the singleton; the next `getMediaStorage()`
 *  call creates a fresh stub WITHOUT re-registering (registry already has it). */
export function __resetMediaStorageForTests(replacement?: MediaStorage): void {
	registered = replacement ?? null
}
