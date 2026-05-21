/**
 * Bun test preload for frontend — DOM registration only (Phase 16 closure 2026-05-13).
 *
 * Replaces Vitest's `environment: 'happy-dom'`. `global-mocks.ts` is now a
 * SEPARATE preload entry in `bunfig.toml` (NOT a `await import` from here) —
 * dynamic import inside preload introduced a race: lifecycle hooks
 * `beforeEach`/`afterEach` registered AFTER test files started under
 * `bun test --parallel`, producing «Cannot call beforeEach() inside a test»
 * + indeterministic failures (5 same-input parallel runs → 0/1/2 reds).
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof globalThis.document === 'undefined') {
	GlobalRegistrator.register({
		url: 'http://localhost/',
		// Disable real script-tag loading per `feedback_bun_test_canons_2026_05_13`
		// §7 «tests must NOT issue real network calls». Without this happy-dom
		// fetches any `<script src="https://...">` appended via DOM, which
		// (a) fails в bun:test (NotSupportedError), (b) pollutes stderr, (c)
		// could hit real CDN under different runner config.
		// `handleDisabledFileLoadingAsSuccess: true` makes happy-dom dispatch
		// 'load' event silently instead of throwing.
		settings: {
			disableJavaScriptFileLoading: true,
			handleDisabledFileLoadingAsSuccess: true,
		},
	})
}
