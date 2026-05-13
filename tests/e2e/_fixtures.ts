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
 * standard Playwright `test` with a worker-scoped `storageState` fixture
 * that points each spec at the right per-worker file.
 *
 * Canonical Playwright pattern per playwright.dev/docs/auth#multiple-signed-
 * in-roles + `playwright.dev/docs/test-fixtures#worker-scoped-fixtures`
 * (verified ≥2026-05-13).
 *
 * Migration: replace `import { test } from '@playwright/test'` →
 * `import { test } from './_fixtures.ts'`. `expect` continues to come
 * from '@playwright/test' (no change needed). Underscore-prefix on file
 * name keeps `testMatch: /.*\.spec\.ts/` from picking it up as a test.
 */

import { test as base } from '@playwright/test'

export const test = base.extend<object, { storageState: string }>({
	storageState: [
		async ({}, use, workerInfo) => {
			const path = `tests/.auth/owner-w${workerInfo.workerIndex}.json`
			await use(path)
		},
		{ scope: 'worker' },
	],
})

export { expect } from '@playwright/test'
