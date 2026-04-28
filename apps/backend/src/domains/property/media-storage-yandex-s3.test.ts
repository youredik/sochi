/**
 * media-storage-yandex-s3 — strict tests (M9.7).
 *
 * Mocks AWS SDK v3 S3Client + getSignedUrl — verifies adapter contract без
 * touching real Yandex S3. Real-cloud smoke deferred к operator post-deploy
 * (similar pattern as Phase D Touch ID real-device).
 *
 * Pre-done audit:
 *   [Y1] mode === 'live'
 *   [Y2] getPresignedPut с empty key → throws
 *   [Y3] getPresignedPut с zero/negative maxBytes → throws
 *   [Y4] getPresignedPut returns headers + url + expiresAt
 *   [Y5] expiresAt = now() + ttlSec * 1000 (default 300 = 5 min)
 *   [Y6] custom ttlSec respected
 *   [Y7] getPublicUrl returns endpoint/bucket/key path-style
 *   [Y8] markDerivedReady is no-op (returns true) — production cloud function
 *        handles real flag flip
 *   [Y9] putDerivedBytes infers Content-Type from key extension
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const sendMock = vi.fn()
vi.mock('@aws-sdk/client-s3', () => ({
	S3Client: class {
		send = sendMock
	},
	PutObjectCommand: class {
		__cmd = 'put'
		input: unknown
		constructor(input: unknown) {
			this.input = input
		}
	},
	GetObjectCommand: class {
		__cmd = 'get'
		input: unknown
		constructor(input: unknown) {
			this.input = input
		}
	},
}))

const getSignedUrlMock = vi.fn()
vi.mock('@aws-sdk/s3-request-presigner', () => ({
	getSignedUrl: getSignedUrlMock,
}))

const { createYandexS3MediaStorage } = await import('./media-storage-yandex-s3.ts')

const BASE_OPTS = {
	endpoint: 'https://storage.yandexcloud.net',
	region: 'ru-central1',
	accessKeyId: 'test-access',
	secretAccessKey: 'test-secret',
	bucket: 'horeca-media-test',
}

afterEach(() => {
	vi.clearAllMocks()
})

describe('Yandex S3 MediaStorage', () => {
	it('[Y1] mode === "live"', () => {
		const storage = createYandexS3MediaStorage(BASE_OPTS)
		expect(storage.mode).toBe('live')
	})

	it('[Y2] empty key throws', async () => {
		const storage = createYandexS3MediaStorage(BASE_OPTS)
		await expect(
			storage.getPresignedPut({ key: '', contentType: 'image/jpeg', maxBytes: 1024 }),
		).rejects.toThrow(/key must be non-empty/)
	})

	it('[Y3] zero/negative maxBytes throws', async () => {
		const storage = createYandexS3MediaStorage(BASE_OPTS)
		await expect(
			storage.getPresignedPut({ key: 'a/b.jpg', contentType: 'image/jpeg', maxBytes: 0 }),
		).rejects.toThrow(/maxBytes must be positive/)
		await expect(
			storage.getPresignedPut({ key: 'a/b.jpg', contentType: 'image/jpeg', maxBytes: -1 }),
		).rejects.toThrow(/maxBytes must be positive/)
	})

	it('[Y4] returns url + Content-Type header + expiresAt ISO', async () => {
		getSignedUrlMock.mockResolvedValueOnce('https://presigned.example/put/key')
		const storage = createYandexS3MediaStorage({ ...BASE_OPTS, now: () => 1000 })
		const result = await storage.getPresignedPut({
			key: 't/p/m/orig.jpg',
			contentType: 'image/jpeg',
			maxBytes: 5_000_000,
		})
		expect(result.url).toBe('https://presigned.example/put/key')
		expect(result.headers['Content-Type']).toBe('image/jpeg')
		expect(result.expiresAt).toBe(new Date(1000 + 300_000).toISOString())
	})

	it('[Y5] default ttl = 300 sec → expiresAt = now + 300s', async () => {
		getSignedUrlMock.mockResolvedValueOnce('url')
		const storage = createYandexS3MediaStorage({ ...BASE_OPTS, now: () => 0 })
		const result = await storage.getPresignedPut({
			key: 'k',
			contentType: 'image/jpeg',
			maxBytes: 1,
		})
		expect(result.expiresAt).toBe(new Date(300 * 1000).toISOString())
	})

	it('[Y6] custom ttlSec=60 → expiresAt = now + 60s', async () => {
		getSignedUrlMock.mockResolvedValueOnce('url')
		const storage = createYandexS3MediaStorage({ ...BASE_OPTS, ttlSec: 60, now: () => 0 })
		const result = await storage.getPresignedPut({
			key: 'k',
			contentType: 'image/jpeg',
			maxBytes: 1,
		})
		expect(result.expiresAt).toBe(new Date(60_000).toISOString())
	})

	it('[Y7] getPublicUrl returns path-style URL', () => {
		const storage = createYandexS3MediaStorage(BASE_OPTS)
		expect(storage.getPublicUrl('tenant/property/media/orig.jpg')).toBe(
			'https://storage.yandexcloud.net/horeca-media-test/tenant/property/media/orig.jpg',
		)
	})

	it('[Y7.b] getPublicUrl strips trailing slash from endpoint', () => {
		const storage = createYandexS3MediaStorage({
			...BASE_OPTS,
			endpoint: 'https://storage.yandexcloud.net/',
		})
		expect(storage.getPublicUrl('k')).toBe('https://storage.yandexcloud.net/horeca-media-test/k')
	})

	it('[Y8] markDerivedReady is no-op returning true', async () => {
		const storage = createYandexS3MediaStorage(BASE_OPTS)
		const result = await storage.markDerivedReady('any/key.webp')
		expect(result).toBe(true)
	})

	it('[Y9] putDerivedBytes infers Content-Type from key ext', async () => {
		sendMock.mockResolvedValueOnce({})
		const storage = createYandexS3MediaStorage(BASE_OPTS)
		await storage.putDerivedBytes('a/b/c.webp', Buffer.from([1, 2, 3]))
		const cmd = sendMock.mock.calls[0]?.[0] as { __cmd: string; input: { ContentType: string } }
		expect(cmd.input.ContentType).toBe('image/webp')
	})

	it('[Y9.b] putDerivedBytes — unknown ext → octet-stream fallback', async () => {
		sendMock.mockResolvedValueOnce({})
		const storage = createYandexS3MediaStorage(BASE_OPTS)
		await storage.putDerivedBytes('a/no-ext', Buffer.from([1]))
		const cmd = sendMock.mock.calls[0]?.[0] as { input: { ContentType: string } }
		expect(cmd.input.ContentType).toBe('application/octet-stream')
	})
})
