/**
 * Per-tenant adapter cache + resolver — strict tests TC1-TC10 (M10 / A7.1.fix).
 *
 * Pure-function level (no DB). Verifies:
 *   - LRU TTL eviction
 *   - LRU max-entries eviction (least-recently-used)
 *   - adapterVersion bump → key change → cache miss
 *   - invalidateTenant prefix scan
 *   - resolveAdapter cache-hit / cache-miss / factory-once-per-miss
 *
 * Per `feedback_strict_tests.md`: exact-value asserts + adversarial paths.
 */

import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, it, mock } from 'bun:test'
import type { ChannelManagerAdapter } from './adapter.ts'
import { createPerTenantAdapterCache, resolveAdapter } from './tenant-context.ts'

function buildStubAdapter(channelId: string): ChannelManagerAdapter {
	return {
		metadata: { channelId, mode: 'mock', role: 'processor_with_dpa', displayName: channelId },
	} as unknown as ChannelManagerAdapter
}

describe('createPerTenantAdapterCache — LRU + TTL semantics (TC1-TC5)', () => {
	it('[TC1] cache miss returns null', () => {
		const cache = createPerTenantAdapterCache({ maxEntries: 10, ttlMs: 1000 })
		expect(cache.get({ organizationId: 'org_a', channelId: 'TL', adapterVersion: 1n })).toBeNull()
	})

	it('[TC2] cache hit returns same adapter instance', () => {
		const cache = createPerTenantAdapterCache({ maxEntries: 10, ttlMs: 60_000 })
		const a = buildStubAdapter('TL')
		cache.set({ organizationId: 'org_a', channelId: 'TL', adapterVersion: 1n }, a)
		const got = cache.get({ organizationId: 'org_a', channelId: 'TL', adapterVersion: 1n })
		expect(got).toBe(a)
	})

	it('[TC3] adapterVersion bump → cache MISS (different key)', () => {
		const cache = createPerTenantAdapterCache({ maxEntries: 10, ttlMs: 60_000 })
		const a1 = buildStubAdapter('TL')
		cache.set({ organizationId: 'org_a', channelId: 'TL', adapterVersion: 1n }, a1)
		expect(cache.get({ organizationId: 'org_a', channelId: 'TL', adapterVersion: 2n })).toBeNull()
		// v1 still cached.
		expect(cache.get({ organizationId: 'org_a', channelId: 'TL', adapterVersion: 1n })).toBe(a1)
	})

	it('[TC4] LRU eviction at max capacity', () => {
		const cache = createPerTenantAdapterCache({ maxEntries: 2, ttlMs: 60_000 })
		const a = buildStubAdapter('TL-1')
		const b = buildStubAdapter('TL-2')
		const c = buildStubAdapter('TL-3')
		cache.set({ organizationId: 'org_a', channelId: 'a', adapterVersion: 1n }, a)
		cache.set({ organizationId: 'org_a', channelId: 'b', adapterVersion: 1n }, b)
		// Touch 'a' to push it to MRU.
		cache.get({ organizationId: 'org_a', channelId: 'a', adapterVersion: 1n })
		cache.set({ organizationId: 'org_a', channelId: 'c', adapterVersion: 1n }, c)
		// 'b' should be evicted (it's LRU after the touch).
		expect(cache.get({ organizationId: 'org_a', channelId: 'b', adapterVersion: 1n })).toBeNull()
		expect(cache.get({ organizationId: 'org_a', channelId: 'a', adapterVersion: 1n })).toBe(a)
		expect(cache.get({ organizationId: 'org_a', channelId: 'c', adapterVersion: 1n })).toBe(c)
	})

	it('[TC5] TTL expiry returns null after window passes (real-clock — lru-cache@11 uses performance.now)', async () => {
		const cache = createPerTenantAdapterCache({ maxEntries: 10, ttlMs: 30 })
		const a = buildStubAdapter('TL')
		cache.set({ organizationId: 'org_a', channelId: 'TL', adapterVersion: 1n }, a)
		expect(cache.get({ organizationId: 'org_a', channelId: 'TL', adapterVersion: 1n })).toBe(a)
		await sleep(80)
		expect(cache.get({ organizationId: 'org_a', channelId: 'TL', adapterVersion: 1n })).toBeNull()
	})
})

describe('invalidateTenant — prefix scan (TC6)', () => {
	it('[TC6] invalidateTenant clears all entries для tenant + leaves others', () => {
		const cache = createPerTenantAdapterCache({ maxEntries: 100, ttlMs: 60_000 })
		const aTl = buildStubAdapter('TL')
		const aYt = buildStubAdapter('YT')
		const bTl = buildStubAdapter('TL')
		cache.set({ organizationId: 'org_a', channelId: 'TL', adapterVersion: 1n }, aTl)
		cache.set({ organizationId: 'org_a', channelId: 'YT', adapterVersion: 1n }, aYt)
		cache.set({ organizationId: 'org_b', channelId: 'TL', adapterVersion: 1n }, bTl)
		cache.invalidateTenant('org_a')
		expect(cache.get({ organizationId: 'org_a', channelId: 'TL', adapterVersion: 1n })).toBeNull()
		expect(cache.get({ organizationId: 'org_a', channelId: 'YT', adapterVersion: 1n })).toBeNull()
		// org_b untouched.
		expect(cache.get({ organizationId: 'org_b', channelId: 'TL', adapterVersion: 1n })).toBe(bTl)
	})
})

describe('resolveAdapter — cache-hit / miss / factory-once (TC7-TC10)', () => {
	it('[TC7] miss: factory invoked, adapter cached for next read', async () => {
		const cache = createPerTenantAdapterCache({ maxEntries: 10, ttlMs: 60_000 })
		const factory = mock(async () => buildStubAdapter('TL'))
		const versionLookup = mock(async () => 1n)
		await resolveAdapter(
			{ cache, factory, versionLookup },
			{ organizationId: 'org_a', channelId: 'TL' },
		)
		await resolveAdapter(
			{ cache, factory, versionLookup },
			{ organizationId: 'org_a', channelId: 'TL' },
		)
		expect(factory).toHaveBeenCalledTimes(1)
		expect(versionLookup).toHaveBeenCalledTimes(2)
	})

	it('[TC8] adapterVersion bump → factory invoked again (hot reload)', async () => {
		const cache = createPerTenantAdapterCache({ maxEntries: 10, ttlMs: 60_000 })
		const factory = mock(async () => buildStubAdapter('TL'))
		let v = 1n
		const versionLookup = mock(async () => v)
		await resolveAdapter(
			{ cache, factory, versionLookup },
			{ organizationId: 'org_a', channelId: 'TL' },
		)
		v = 2n
		await resolveAdapter(
			{ cache, factory, versionLookup },
			{ organizationId: 'org_a', channelId: 'TL' },
		)
		expect(factory).toHaveBeenCalledTimes(2)
	})

	it('[TC9] different tenants do NOT share cache (cross-tenant isolation)', async () => {
		const cache = createPerTenantAdapterCache({ maxEntries: 10, ttlMs: 60_000 })
		const factory = mock(async (input: { organizationId: string; channelId: string }) =>
			buildStubAdapter(`${input.organizationId}:${input.channelId}`),
		)
		const versionLookup = mock(async () => 1n)
		const a = await resolveAdapter(
			{ cache, factory, versionLookup },
			{ organizationId: 'org_a', channelId: 'TL' },
		)
		const b = await resolveAdapter(
			{ cache, factory, versionLookup },
			{ organizationId: 'org_b', channelId: 'TL' },
		)
		expect(a).not.toBe(b)
		expect(a.metadata.channelId).toBe('org_a:TL')
		expect(b.metadata.channelId).toBe('org_b:TL')
	})

	it('[TC10] different channels на same tenant produce different cache entries', async () => {
		const cache = createPerTenantAdapterCache({ maxEntries: 10, ttlMs: 60_000 })
		const factory = mock(async (input: { organizationId: string; channelId: string }) =>
			buildStubAdapter(input.channelId),
		)
		const versionLookup = mock(async () => 1n)
		const tl = await resolveAdapter(
			{ cache, factory, versionLookup },
			{ organizationId: 'org_a', channelId: 'TL' },
		)
		const yt = await resolveAdapter(
			{ cache, factory, versionLookup },
			{ organizationId: 'org_a', channelId: 'YT' },
		)
		expect(tl.metadata.channelId).toBe('TL')
		expect(yt.metadata.channelId).toBe('YT')
		expect(factory).toHaveBeenCalledTimes(2)
	})
})
