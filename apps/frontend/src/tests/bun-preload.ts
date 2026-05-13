/**
 * Bun test preload for frontend (Phase 16 — 2026-05-12).
 *
 * Replaces Vitest's `environment: 'happy-dom'` + `setupFiles: [global-mocks.ts]`
 * combo. Bun test runs Node-mode by default — registering happy-dom globals
 * here ensures `document`, `window`, `Navigator` etc. exist before any test
 * imports @testing-library/react or shadcn components.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof globalThis.document === 'undefined') {
	GlobalRegistrator.register({ url: 'http://localhost/' })
}

await import('./global-mocks.ts')
