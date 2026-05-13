/**
 * Stryker Mutator 9.6.1 — mutation testing for critical pure libraries.
 *
 * Re-enabled Phase 16 closure 2026-05-13 (commit follow-up to `9144493`).
 * Prior blockers fixed:
 *   - 401 stderr noise in frontend test:fast (commit `fe3ad40`) — was
 *     causing intermittent exit-1 → Stryker dryRun fail.
 *   - act() warnings in frontend tests (commit `0bf5fd4`) — same surface.
 *   - bun:test preload race (commit `652d1b0`) — deterministic green now.
 *
 * Test-runner choice: `command` (Stryker official, no plugin needed).
 * Spawns `pnpm test:fast` per mutation batch with concurrency=1. The
 * built-in `@stryker-mutator/vitest-runner` (commit 9144493 era) cannot
 * run bun:test sources. Community bun runners
 * (`@hughescr/stryker-bun-runner`, `stryker-mutator-bun-runner`) had
 * empirical issues (Inspector WebSocket, dry-run timeout) — command-
 * runner sidesteps the entire integration surface.
 *
 * Why: coverage tells WHICH lines run, but not whether the tests CATCH
 * bugs when logic mutates. Per [[strict-tests]] — tests must hunt bugs.
 *
 * Scope: pure libraries only (no React components, no DB calls).
 * High-strict-test-discipline targets per phase 14/15 canon:
 *   - refund-math.ts      — refund cap arithmetic, classifier
 *   - rbac.ts             — portable role × permission lookup matrix
 *   - folio-balance.ts    — Int64 копейки money math, balance invariant
 *   - payment-transitions.ts — 9-state Payment FSM
 *   - booking-create.ts   — money micros, guest snapshot, idempotency
 *   - booking-transitions.ts — state machine, nextStatus, optimistic
 *   - format-ru.ts        — RU money/date formatters + schemas
 *   - aging-buckets.ts    — receivables aging math
 *   - keymap.ts           — APG keymap + roving-tabindex math
 *   - cdc-handlers.ts     — pure CdcEvent → activity row transformations
 *   - seed.ts             — rubToMicrosString + buildSeedPayload
 *
 * NOT in pre-push — full run takes minutes per file. Run manually via
 * `pnpm mutate` at phase boundaries (same cadence as dependency audits).
 *
 * Target: ≥80% mutation score on these libs (industry-standard for
 * algorithm-heavy code per Stryker docs 2026).
 */

// biome-ignore lint/style/noDefaultExport: required by Stryker config loader
export default {
	testRunner: 'command',
	commandRunner: {
		command: 'pnpm test:fast',
	},
	concurrency: 1,
	timeoutMS: 600_000,
	checkers: [],
	mutate: [
		'apps/backend/src/domains/refund/lib/refund-math.ts',
		'apps/backend/src/domains/folio/lib/folio-balance.ts',
		'apps/backend/src/domains/payment/lib/payment-transitions.ts',
		'apps/backend/src/domains/cdc/cdc-handlers.ts',
		'apps/frontend/src/features/bookings/lib/booking-create.ts',
		'apps/frontend/src/features/bookings/lib/booking-transitions.ts',
		'apps/frontend/src/features/setup/lib/seed.ts',
		'apps/frontend/src/features/chessboard/lib/keymap.ts',
		'apps/frontend/src/features/receivables/lib/aging-buckets.ts',
		'apps/frontend/src/lib/format-ru.ts',
		'packages/shared/src/rbac.ts',
	],
	reporters: ['progress', 'clear-text', 'html'],
	htmlReporter: { fileName: 'reports/mutation/index.html' },
	thresholds: {
		high: 90,
		low: 80,
		break: 70,
	},
	disableTypeChecks: 'apps/**/*.{ts,tsx}',
	tempDirName: '.stryker-tmp',
	cleanTempDir: 'always',
}
