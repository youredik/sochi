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

import { test as base } from '@playwright/test'

export const test = base.extend<{ storageState: string }, { workerStorageState: string }>({
	workerStorageState: [
		async ({}, use, workerInfo) => {
			await use(`tests/.auth/owner-w${workerInfo.workerIndex}.json`)
		},
		{ scope: 'worker' },
	],
	storageState: async ({ workerStorageState }, use) => {
		await use(workerStorageState)
	},
})

export { expect } from '@playwright/test'
