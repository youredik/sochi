/**
 * Tests for the StubMediaStorage adapter.
 *
 * Strict per `feedback_strict_tests.md`:
 *   - exact-value asserts on URL shape (URL collisions cost real $ later)
 *   - deterministic seams via `now: () => number` and `ttlSec`
 *   - adversarial: empty key / non-positive maxBytes rejected
 *   - markDerivedReady idempotent + reports unknown-key correctly
 */
import { describe, expect, it } from 'vitest'
import { __resetAdapterRegistry, getAdapter } from '../../lib/adapters/index.ts'
import {
	__resetMediaStorageForTests,
	createStubMediaStorage,
	getStubMediaStorage as getMediaStorage,
} from './media-storage.ts'

describe('StubMediaStorage', () => {
	it('reports mode=mock', () => {
		const s = createStubMediaStorage()
		expect(s.mode).toBe('mock')
	})

	it('getPresignedPut returns deterministic-shape response', async () => {
		const fixedNow = 1_777_300_000_000
		const s = createStubMediaStorage({ now: () => fixedNow, ttlSec: 60 })
		const r = await s.getPresignedPut({
			key: 'media-original/o/p/m.jpg',
			contentType: 'image/jpeg',
			maxBytes: 5_000_000,
		})
		expect(r.url.startsWith('http://stub.media.local/put/')).toBe(true)
		expect(r.url.endsWith('/media-original/o/p/m.jpg')).toBe(true)
		expect(r.headers['Content-Type']).toBe('image/jpeg')
		expect(r.headers['X-Stub-Max-Bytes']).toBe('5000000')
		// expiresAt = now + 60s = 1_777_300_060_000 → ISO 2026-04-27T11:07:40.000Z
		expect(r.expiresAt).toBe(new Date(fixedNow + 60_000).toISOString())
	})

	it('getPresignedPut produces unique URLs across calls (counter)', async () => {
		const s = createStubMediaStorage()
		const r1 = await s.getPresignedPut({
			key: 'a',
			contentType: 'image/jpeg',
			maxBytes: 1,
		})
		const r2 = await s.getPresignedPut({
			key: 'a',
			contentType: 'image/jpeg',
			maxBytes: 1,
		})
		expect(r1.url).not.toBe(r2.url)
	})

	it('getPresignedPut rejects empty key', async () => {
		const s = createStubMediaStorage()
		await expect(
			s.getPresignedPut({ key: '', contentType: 'image/jpeg', maxBytes: 1 }),
		).rejects.toThrow(/key must be non-empty/)
	})

	it('getPresignedPut rejects non-positive maxBytes', async () => {
		const s = createStubMediaStorage()
		await expect(
			s.getPresignedPut({ key: 'k', contentType: 'image/jpeg', maxBytes: 0 }),
		).rejects.toThrow(/maxBytes must be positive/)
		await expect(
			s.getPresignedPut({ key: 'k', contentType: 'image/jpeg', maxBytes: -1 }),
		).rejects.toThrow(/maxBytes must be positive/)
	})

	it('getPublicUrl returns canonical public URL', () => {
		const s = createStubMediaStorage({ baseUrl: 'http://media.test' })
		expect(s.getPublicUrl('media-derived/o/p/m/card.avif')).toBe(
			'http://media.test/public/media-derived/o/p/m/card.avif',
		)
	})

	it('markDerivedReady returns false for unknown key', async () => {
		const s = createStubMediaStorage()
		expect(await s.markDerivedReady('unknown')).toBe(false)
	})

	it('markDerivedReady returns true for previously presigned key + idempotent on second call', async () => {
		const s = createStubMediaStorage()
		await s.getPresignedPut({ key: 'k', contentType: 'image/jpeg', maxBytes: 1 })
		expect(await s.markDerivedReady('k')).toBe(true)
		// Second call still true (idempotent)
		expect(await s.markDerivedReady('k')).toBe(true)
	})

	it('debugUploadCount reflects presigned count', async () => {
		const s = createStubMediaStorage()
		expect(s.debugUploadCount?.()).toBe(0)
		await s.getPresignedPut({ key: 'k1', contentType: 'image/jpeg', maxBytes: 1 })
		await s.getPresignedPut({ key: 'k2', contentType: 'image/jpeg', maxBytes: 1 })
		expect(s.debugUploadCount?.()).toBe(2)
	})

	it('default ttlSec is 300 seconds (matches real S3 short-lived presign)', async () => {
		const fixedNow = 1_777_300_000_000
		const s = createStubMediaStorage({ now: () => fixedNow })
		const r = await s.getPresignedPut({
			key: 'k',
			contentType: 'image/jpeg',
			maxBytes: 1,
		})
		expect(r.expiresAt).toBe(new Date(fixedNow + 300_000).toISOString())
	})

	it('default baseUrl is stub.media.local', async () => {
		const s = createStubMediaStorage()
		expect(s.getPublicUrl('x')).toBe('http://stub.media.local/public/x')
	})
})

describe('getMediaStorage (singleton + adapter registry wiring)', () => {
	it('first call registers media.stub with correct metadata', () => {
		__resetMediaStorageForTests()
		__resetAdapterRegistry()
		getMediaStorage()
		const meta = getAdapter('media.stub')
		expect(meta).not.toBeNull()
		expect(meta?.category).toBe('storage')
		expect(meta?.mode).toBe('mock')
		expect(meta?.description).toContain('M9')
	})

	it('returns the same instance on subsequent calls (singleton)', () => {
		__resetMediaStorageForTests()
		__resetAdapterRegistry()
		const a = getMediaStorage()
		const b = getMediaStorage()
		expect(a).toBe(b)
	})
})
