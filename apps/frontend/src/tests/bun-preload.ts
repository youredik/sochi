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
	GlobalRegistrator.register({ url: 'http://localhost/' })
}
