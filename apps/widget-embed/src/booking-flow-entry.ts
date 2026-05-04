/**
 * Lazy booking-flow entry — IIFE bundle that ships separately from facade.
 *
 * Loaded via dynamic `import('./booking-flow.js')` from `widget.ts` on user
 * click (D12 facade pattern). Bundle target: ≤80 KB gzip per industry leader
 * benchmark (Resy 36.8 KB / Stripe Elements 259 KB ceiling — we sit between).
 *
 * Boot order mirrors `index.ts`:
 *   1. DOM-clobbering stash (D16) — ensures lazy chunk evaluates against the
 *      same captured globals the facade saw.
 *   2. Lit DSD hydrate-support (D1).
 *   3. Defensive `customElements.define` для `<sochi-booking-flow>`.
 *
 * The `<sochi-booking-flow>` element is rendered INSIDE the existing
 * `<sochi-booking-widget-v1>` shadow root (facade swaps its own `render()`
 * output к the new sub-element after dynamic import resolves). No second
 * Shadow DOM nesting — defended cleanly за пределами Tailwind preflight reach.
 */

// 1. Stash globals (idempotent if facade already ran).
import { $customElements } from './dom-stash.ts'
// 2. Hydrate-support — required для DSD-rendered markup the backend will
//    inject in А4.3.
import '@lit-labs/ssr-client/lit-element-hydrate-support.js'
// 3. Element class.
import { BOOKING_FLOW_TAG, SochiBookingFlow } from './booking-flow.ts'

if (!$customElements.get(BOOKING_FLOW_TAG)) {
	$customElements.define(BOOKING_FLOW_TAG, SochiBookingFlow)
}

export { BOOKING_FLOW_TAG, SochiBookingFlow }
