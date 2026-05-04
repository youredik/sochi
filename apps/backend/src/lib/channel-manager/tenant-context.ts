/**
 * Per-tenant adapter resolution + LRU cache — M10 / A7.1.fix (D26+D27+D28).
 *
 * Per `plans/m10_canonical.md` §2 D26-D28:
 *   - D26: per-tenant adapter resolution via Hono `contextStorage()`
 *     AsyncLocalStorage (already wired в app.ts:486 globally)
 *   - D27: per-tenant LRU `(organizationId, channelId, adapterVersion)` 500 entries × 15-min TTL
 *   - D28: hot-reload via `organizationProfile.adapterVersion` bump → cache invalidation
 *     on next read (eventual consistency ≤ 15-min TTL acceptable)
 *
 * Backed by `lru-cache@11.3.6` (Isaac Z. Schlueter, latest 2026-05-04). Modern
 * canon: native AbortController, dispose callback, fastest TTL eviction in
 * Node ecosystem. Engine Node 20 || >=22 — matches our Node 22 LTS target.
 *
 * Cache key shape `(organizationId:channelId:adapterVersion)`:
 *   - `adapterVersion` bump invalidates ВСЕ entries для tenant (key changes)
 *   - read miss → factory call → store with current version
 */

import { LRUCache } from 'lru-cache'
import type { ChannelManagerAdapter } from './adapter.ts'

const DEFAULT_MAX_ENTRIES = 500
const DEFAULT_TTL_MS = 15 * 60_000

export interface AdapterCacheOptions {
	readonly maxEntries?: number
	readonly ttlMs?: number
}

export interface AdapterCacheKey {
	readonly organizationId: string
	readonly channelId: string
	readonly adapterVersion: bigint
}

function buildKey(k: AdapterCacheKey): string {
	return `${k.organizationId}:${k.channelId}:${k.adapterVersion.toString()}`
}

/**
 * Per-tenant adapter cache. Single instance per process (factory at startup).
 * Adapter instances may hold OAuth tokens / connection pools — caching avoids
 * per-request handshake cost.
 */
export function createPerTenantAdapterCache(opts: AdapterCacheOptions = {}) {
	const cache = new LRUCache<string, ChannelManagerAdapter>({
		max: opts.maxEntries ?? DEFAULT_MAX_ENTRIES,
		ttl: opts.ttlMs ?? DEFAULT_TTL_MS,
		// Re-set TTL on access — keeps hot adapters alive.
		updateAgeOnGet: true,
		// LRU touch on hit (default behavior, made explicit).
		updateAgeOnHas: false,
		// Allow stale entries momentarily during fetch races (returns stale,
		// kicks off refetch). Safe here because adapter state is opaque to caller.
		allowStale: false,
	})

	return {
		get(key: AdapterCacheKey): ChannelManagerAdapter | null {
			return cache.get(buildKey(key)) ?? null
		},

		set(key: AdapterCacheKey, adapter: ChannelManagerAdapter): void {
			cache.set(buildKey(key), adapter)
		},

		/**
		 * Invalidate ALL entries for a tenant (any channel, any version). Called
		 * on adapter SDK swap (rare). NOT used on adapterVersion bump — that
		 * misses naturally because key embeds version.
		 */
		invalidateTenant(organizationId: string): void {
			const prefix = `${organizationId}:`
			for (const k of cache.keys()) {
				if (k.startsWith(prefix)) cache.delete(k)
			}
		},

		size(): number {
			return cache.size
		},

		/**
		 * Test seam — drains the cache state. NOT for production.
		 */
		__test_drain(): ReadonlyArray<{ readonly key: string }> {
			return Array.from(cache.keys()).map((key) => ({ key }))
		},

		/** Test seam: clears all entries (for test isolation). */
		__test_clear(): void {
			cache.clear()
		},
	}
}

/**
 * Resolver protocol — given (organizationId, channelId), returns the adapter
 * from cache OR builds via factory (cache-miss path).
 *
 * `versionLookup` reads current `organizationProfile.adapterVersion`. Bumped
 * on mode flip (mock ↔ sandbox ↔ live) → next resolve sees new key → cache
 * miss → factory rebuilds.
 */
export interface ResolverDeps {
	readonly cache: ReturnType<typeof createPerTenantAdapterCache>
	readonly versionLookup: (organizationId: string) => Promise<bigint>
	readonly factory: (input: {
		readonly organizationId: string
		readonly channelId: string
	}) => Promise<ChannelManagerAdapter>
}

export async function resolveAdapter(
	deps: ResolverDeps,
	input: { readonly organizationId: string; readonly channelId: string },
): Promise<ChannelManagerAdapter> {
	const adapterVersion = await deps.versionLookup(input.organizationId)
	const key: AdapterCacheKey = {
		organizationId: input.organizationId,
		channelId: input.channelId,
		adapterVersion,
	}
	const cached = deps.cache.get(key)
	if (cached !== null) return cached
	const adapter = await deps.factory(input)
	deps.cache.set(key, adapter)
	return adapter
}
