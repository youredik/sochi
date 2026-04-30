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
 * For pre-push (local) reuses — for CI (future) spins fresh.
 *
 * Keep single-worker in pre-push (auth smoke should cost <20s; parallelism
 * with shared backend session is a rabbit hole).
 */

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173'
const API_URL = process.env.PLAYWRIGHT_API_URL ?? 'http://localhost:8787'
const isRemote = BASE_URL !== 'http://localhost:5173'

export default defineConfig({
	testDir: './tests/e2e',
	fullyParallel: false,
	forbidOnly: Boolean(process.env.CI),
	retries: process.env.CI ? 1 : 0,
	workers: 1,
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
			testIgnore: /smoke\.spec\.ts/,
		},
		{
			name: 'smoke',
			use: { ...devices['Desktop Chrome'] },
			testMatch: /smoke\.spec\.ts/,
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
