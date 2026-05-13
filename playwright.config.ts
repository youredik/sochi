import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright configuration (stankoff-v2 pattern, verified 2026).
 *
 * Projects:
 *   - `setup`   — runs auth.setup.ts (signup + saves storageState.json).
 *   - `chromium` — authenticated suite, reuses storageState. Depends on setup.
 *   - `smoke`    — anonymous-only suite for post-deploy sanity (no DB writes,
 *     no storageState dependency). Runs against any BASE_URL.
 *
 * webServer: starts backend + frontend dev servers unless already running.
 * Locally reuses — CI gets fresh per-run (`reuseExistingServer: !CI`).
 *
 * Workers (Phase 16 speedup 2026-05-13):
 *   - Local: `workers: 1` (dev process reuse + shared session safety —
 *     parallelism here is a rabbit hole per stankoff-v2 lineage).
 *   - CI: `workers: 2` (fresh per-run webServer + tenant created by
 *     `auth.setup.ts` is reused read-mostly by 21 specs → 2 workers
 *     parallel-safe per round-2 research 2026-05-13 + Playwright canon
 *     `playwright.dev/docs/test-parallel`). Expected wall-clock ~1.8×.
 *   - `fullyParallel: false` (per-file scheduling preserves file-level
 *     setup affinity; per-test scheduling deferred until per-test
 *     tenant slug isolation lands).
 */

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5273'
const API_URL = process.env.PLAYWRIGHT_API_URL ?? 'http://localhost:8787'
const isRemote = BASE_URL !== 'http://localhost:5273'

export default defineConfig({
	testDir: './tests/e2e',
	fullyParallel: false,
	forbidOnly: Boolean(process.env.CI),
	retries: process.env.CI ? 1 : 0,
	workers: process.env.CI ? 2 : 1,
	reporter: process.env.CI ? 'github' : 'line',
	use: {
		baseURL: BASE_URL,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
	},
	projects: [
		{
			name: 'setup',
			testMatch: /auth\.setup\.ts/,
		},
		{
			name: 'chromium',
			use: {
				...devices['Desktop Chrome'],
				storageState: 'tests/.auth/owner.json',
			},
			dependencies: ['setup'],
			testMatch: /.*\.spec\.ts/,
			testIgnore: /(smoke|embed|perf-a11y|iframe-noscript|demo-tour)\.spec\.ts/,
		},
		{
			name: 'smoke',
			use: { ...devices['Desktop Chrome'] },
			testMatch: /(smoke|embed|perf-a11y|iframe-noscript|demo-tour)\.spec\.ts/,
		},
	],
	webServer: isRemote
		? undefined
		: [
				{
					command: 'pnpm --filter @horeca/backend dev',
					url: `${API_URL}/health`,
					reuseExistingServer: !process.env.CI,
					timeout: 120_000,
					stdout: 'pipe',
					stderr: 'pipe',
				},
				{
					command: 'pnpm --filter @horeca/frontend dev',
					url: BASE_URL,
					reuseExistingServer: !process.env.CI,
					timeout: 120_000,
					stdout: 'pipe',
					stderr: 'pipe',
				},
			],
})
