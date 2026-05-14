/**
 * Per-worker authenticated Playwright fixture (Phase 16 closure 2026-05-13).
 *
 * Replaces the single shared `tests/.auth/owner.json` storageState with a
 * per-worker variant so `fullyParallel: true` + `workers: 4` is safe.
 * Each worker gets its own tenant (e2e-owner-{ts}-w{workerIdx}@sochi.local)
 * + storage state file (`tests/.auth/owner-w{workerIdx}.json`), eliminating
 * cross-worker booking/state contention.
 *
 * Setup project (`auth.setup.ts`) creates ALL per-worker tenants on first
 * run (one signup + wizard per worker slot). The custom `test` extends the
 * standard Playwright `test` with a worker-scoped `workerStorageState`
 * derived fixture, then overrides the built-in test-scoped `storageState`
 * to flow through it. Each spec automatically picks up the right per-worker
 * file via `storageState`.
 *
 * **Playwright 1.61.0-alpha API note**: direct worker-scope override of
 * `storageState` is rejected with «Fixture has already been registered as
 * a test fixture». The official 1.61+ pattern (playwright.dev/docs/auth
 * #moderate-multiple-signed-in-roles, verified 2026-05-13) is the
 * indirection through a worker-scoped derived fixture and a test-scoped
 * override that reads it — exactly what we do below.
 *
 * Migration: replace `import { test } from '@playwright/test'` →
 * `import { test } from './_fixtures.ts'`. `expect` continues to come
 * from '@playwright/test' (no change needed). Underscore-prefix on file
 * name keeps `testMatch: /.*\.spec\.ts/` from picking it up as a test.
 */

import { existsSync } from 'node:fs'
import { test as base } from '@playwright/test'

/**
 * Per-worker storage path with fallback. `auth.setup.ts` ALWAYS writes
 * `owner-w0.json` (its own `setupInfo.workerIndex` is 0). When chromium tests
 * start in a separate worker pool, Playwright sometimes assigns workerIndex=1
 * (or higher) — locally `workers:1` doesn't guarantee project pools share
 * indices. Falling back to `owner-w0.json` if the per-worker file isn't found
 * keeps tests green в the single-worker local config while still using
 * per-worker tenants when setup ran multiple workers (CI `workers:4` +
 * `fullyParallel:true`).
 */
function pickStorageStatePath(workerIndex: number): string {
	const specific = `tests/.auth/owner-w${workerIndex}.json`
	if (existsSync(specific)) return specific
	return 'tests/.auth/owner-w0.json'
}

export const test = base.extend<{ storageState: string }, { workerStorageState: string }>({
	workerStorageState: [
		async ({}, use, workerInfo) => {
			await use(pickStorageStatePath(workerInfo.workerIndex))
		},
		{ scope: 'worker' },
	],
	storageState: async ({ workerStorageState }, use) => {
		await use(workerStorageState)
	},
})

export { expect } from '@playwright/test'
