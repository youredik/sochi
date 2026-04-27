// =============================================================================
// Adapter registry + production-mode safety gate
// =============================================================================
//
// Module-level singleton. Each adapter implementation registers its metadata
// at app startup (see `app.ts` wiring). The registry exposes a read-only view
// for `/api/health/adapters` and a `assertProductionReady()` gate that runs
// in `index.ts` before the HTTP server starts listening.
//
// Why a module-level singleton (not DI container):
//   - There's exactly one registry per process — DI doesn't add value.
//   - Tests reset via `__resetAdapterRegistry()` in `beforeEach`.
//   - No cross-test pollution because Vitest runs each file in its own
//     worker (or with `--no-file-parallelism` shares process but resets
//     before every test).
//
// =============================================================================

import type { AdapterMetadata } from './types.ts'

const registrations = new Map<string, AdapterMetadata>()

/**
 * Register an adapter at startup. Idempotent across the same `name`+identical
 * metadata is rejected — we want loud failures on accidental double-wiring,
 * not silent overwrite.
 *
 * @throws if `name` is already registered (regardless of new metadata).
 */
export function registerAdapter(meta: AdapterMetadata): void {
	const existing = registrations.get(meta.name)
	if (existing !== undefined) {
		throw new Error(
			`Adapter already registered: '${meta.name}' (existing mode=${existing.mode}, new mode=${meta.mode}). ` +
				`Each adapter must be registered exactly once at startup.`,
		)
	}
	registrations.set(meta.name, meta)
}

/**
 * Snapshot of all currently registered adapters. Returns a frozen array
 * (callers cannot mutate the registry by reference).
 */
export function listAdapters(): readonly AdapterMetadata[] {
	return Object.freeze(Array.from(registrations.values()))
}

/**
 * Lookup by name. `undefined` if not registered.
 */
export function getAdapter(name: string): AdapterMetadata | undefined {
	return registrations.get(name)
}

/**
 * Production-mode safety gate. Call ONCE in `index.ts` after all adapter
 * factories have registered, before `serve()`.
 *
 * Refuses to proceed if any registered adapter is in `mock` mode, except
 * those explicitly whitelisted via `permittedMockAdapters`. `sandbox` mode
 * is also rejected in production — sandbox in prod is universally a
 * config bug.
 *
 * @param opts.permittedMockAdapters — adapter names allowed to remain in mock
 *   despite production mode. Use sparingly, document each entry. Typical
 *   case: ЕПГУ during the multi-week ОВМ МВД agreement onboarding.
 *
 * @throws if any non-whitelisted adapter is mock-or-sandbox in production.
 */
export function assertProductionReady(
	opts: { readonly permittedMockAdapters?: readonly string[] } = {},
): void {
	const whitelist = new Set(opts.permittedMockAdapters ?? [])
	const offenders = listAdapters().filter(
		(a) => (a.mode === 'mock' || a.mode === 'sandbox') && !whitelist.has(a.name),
	)
	if (offenders.length === 0) return
	const detail = offenders
		.map((a) => `  - ${a.name} (category=${a.category}, mode=${a.mode})`)
		.join('\n')
	throw new Error(
		`Refusing to start in APP_MODE=production: ${offenders.length} adapter(s) not in 'live' mode:\n${detail}\n` +
			`Either switch to live impl or add the adapter name to APP_MODE_PERMITTED_MOCK_ADAPTERS env.`,
	)
}

/**
 * Test-only reset. Clears the global registrations map. Never call from
 * production code — would silently invalidate /api/health/adapters and
 * break the production gate.
 *
 * Usage in tests:
 *   beforeEach(() => __resetAdapterRegistry())
 */
export function __resetAdapterRegistry(): void {
	registrations.clear()
}
