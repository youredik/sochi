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
 *   - folio-balance.ts    — Int64 копейки money math: charges sum, tourism
 *                           tax floor (НК РФ ст.418.5), micros↔minor rounding,
 *                           balance conservation invariant
 *   - payment-transitions.ts — 9-state Payment FSM, per-provider gate
 *                              (sbp-no-preauth canon #17), hold expiry math,
 *                              refund-derived status, capture-amount bound
 *   - refund-math.ts      — refund cap arithmetic, partial-vs-full classifier
 *   - cdc-handlers.ts     — pure CdcEvent → activity row transformations (M6.5.1)
 *   - format-ru.ts        — RU money/date formatters + moneyKopecksSchema (M6.7)
 *   - aging-buckets.ts    — receivables aging math (M6.7.4)
 *   - rbac.ts             — portable role × permission lookup matrix (M6.6.1)
 *
 * NOT in pre-push — Stryker on 11 files with hundreds of mutants takes
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
		'apps/backend/src/domains/folio/lib/folio-balance.ts',
		'apps/backend/src/domains/payment/lib/payment-transitions.ts',
		'apps/backend/src/domains/refund/lib/refund-math.ts',
		// cdc-handlers.ts — pure CdcEvent → ActivityInsertInput transformations.
		// Type-only deps (no DB, no time, no random). 30+ unit + property-based
		// tests in cdc-handlers.test.ts. M6.5.1 silent-skip closure (2026-04-25):
		// previously omitted from list, no upstream blocker found.
		'apps/backend/src/workers/cdc-handlers.ts',
		// M6.7 frontend pure libs (added M6.5.1):
		'apps/frontend/src/lib/format-ru.ts',
		'apps/frontend/src/features/receivables/lib/aging-buckets.ts',
		// M6.6.1 portable RBAC matrix (added M6.5.1):
		'packages/shared/src/rbac.ts',
		// M7.A.1 folio-creator CDC handler (added M7.A.1, 2026-04-25):
		// pure CdcEvent → folio INSERT. 17 strict tests incl Promise.all race.
		'apps/backend/src/workers/handlers/folio-creator.ts',
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
