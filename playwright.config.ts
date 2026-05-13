import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright configuration (stankoff-v2 pattern, verified 2026).
 *
 * Projects:
 *   - `setup`    — runs auth.setup.ts once per worker (signup + saves
 *     `tests/.auth/owner-w{workerIdx}.json`).
 *   - `chromium` — authenticated suite, picks up per-worker storage via
 *     `tests/e2e/_fixtures.ts`. Depends on setup.
 *   - `smoke`    — anonymous-only suite for post-deploy sanity (no DB writes,
 *     no storageState dependency). Runs against any BASE_URL.
 *
 * webServer: starts backend + frontend dev servers unless already running.
 * Locally reuses — CI gets fresh per-run (`reuseExistingServer: !CI`).
 *
 * Workers + parallelism (Phase 16 closure 2026-05-13):
 *   - **Local**: `workers: 1` (dev process reuse + shared session safety
 *     — parallelism here is a rabbit hole per stankoff-v2 lineage).
 *   - **CI**: `workers: 4` + `fullyParallel: true`. Per-worker tenant
 *     isolation via `auth.setup.ts` (creates `e2e-owner-{ts}-w{idx}@
 *     sochi.local` per worker slot) + `_fixtures.ts` worker-scoped
 *     `storageState` fixture. Each spec picks up its own worker's storage.
 *     Expected wall-clock ~3-4× vs the prior single-tenant workers=2
 *     (~1.8× baseline). Per Playwright canon `playwright.dev/docs/auth
 *     #multiple-signed-in-roles` + `test-fixtures#worker-scoped-fixtures`
 *     (≥2026-05-13 verify).
 */

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5273'
const API_URL = process.env.PLAYWRIGHT_API_URL ?? 'http://localhost:8787'
const isRemote = BASE_URL !== 'http://localhost:5273'

export default defineConfig({
	testDir: './tests/e2e',
	fullyParallel: Boolean(process.env.CI),
	forbidOnly: Boolean(process.env.CI),
	retries: process.env.CI ? 1 : 0,
	workers: process.env.CI ? 4 : 1,
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
				// Default storageState — per-worker override comes from
				// tests/e2e/_fixtures.ts (worker-scoped fixture). Static path
				// here is the fallback when a spec imports raw `test` from
				// '@playwright/test'; if that happens the spec hits w0
				// storage (which `setup` always produces first).
				storageState: 'tests/.auth/owner-w0.json',
			},
			dependencies: ['setup'],
			testMatch: /.*\.spec\.ts/,
			testIgnore: /(smoke|embed|perf-a11y|iframe-noscript|demo-tour|onboarding-90s)\.spec\.ts/,
		},
		{
			name: 'smoke',
			use: { ...devices['Desktop Chrome'] },
			testMatch: /(smoke|embed|perf-a11y|iframe-noscript|demo-tour|onboarding-90s)\.spec\.ts/,
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
					// Force the `dadata.mock` adapter binding per
					// `[[behaviour_faithful_mock_canon]]`: e2e exercises the
					// production mock surface (canonical Сочи demo records),
					// not the live DaData API. When Playwright spawns the
					// backend, this env override wins; on `reuseExistingServer`
					// the assumption is that the running dev backend is also in
					// mock mode (документировано в README / playbook).
					env: { DADATA_API_KEY: '' },
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
