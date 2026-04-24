/**
 * Stryker Mutator 9.6.1 — mutation testing for critical pure libraries.
 *
 * Why: coverage tells us WHICH lines run under test, but not whether
 * the tests ACTUALLY catch bugs when logic mutates. Mutation testing
 * flips operators/values in source and re-runs tests — if tests still
 * pass, the test suite isn't hunting bugs on that mutation
 * (per feedback_strict_tests.md — tests must hunt bugs).
 *
 * Scope: pure libraries only (no React components, no DB calls).
 * These are our highest-strict-test-discipline surfaces:
 *   - booking-create.ts   — money micros, guest snapshot, idempotency key
 *   - booking-transitions.ts — state machine, nextStatus, optimistic
 *   - seed.ts             — rubToMicrosString + buildSeedPayload
 *   - keymap.ts           — APG keymap + roving-tabindex math
 *
 * NOT in pre-push — Stryker on 4 files with hundreds of mutants takes
 * minutes, too heavy for every push. Run manually via `pnpm mutate`
 * at phase boundaries (same cadence as dependency audits).
 *
 * Target: ≥80% mutation score on these libs (industry-standard for
 * algorithm-heavy code per Stryker docs 2026). Below 80% = tests are
 * passing too easily on boundary conditions → add adversarial cases.
 */
// biome-ignore lint/style/noDefaultExport: required by Stryker config loader
export default {
	testRunner: 'vitest',
	plugins: ['@stryker-mutator/vitest-runner'],
	vitest: {
		configFile: 'vitest.config.ts',
	},
	mutate: [
		'apps/frontend/src/features/bookings/lib/booking-create.ts',
		'apps/frontend/src/features/bookings/lib/booking-transitions.ts',
		'apps/frontend/src/features/setup/lib/seed.ts',
		'apps/frontend/src/features/chessboard/lib/keymap.ts',
	],
	reporters: ['progress', 'clear-text', 'html'],
	thresholds: {
		high: 90,
		low: 80,
		break: 75, // build fails below 75% mutation score
	},
	timeoutMS: 60_000,
	concurrency: 4,
	tempDirName: '.stryker-tmp',
	htmlReporter: {
		fileName: '.stryker-tmp/mutation-report.html',
	},
}
