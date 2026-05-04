/**
 * Embed bundle entry point — IIFE prologue + `<sochi-booking-widget-v1>`
 * registration. This is the FACADE bundle (D12, ≤15 KB gzip target).
 *
 * Boot order (matters for security hardening):
 *   1. Stash canonical browser globals BEFORE any tenant code can clobber
 *      (D16). `dom-stash.ts` aborts boot on hostile env.
 *   2. Detect prototype-pollution gadgets (D17). Abort if present —
 *      `:not(:defined)` fallback (D20) stays visible to the user.
 *   3. Register Lit `'lit-html'` Trusted Types policy (D15) so tenant CSP
 *      `require-trusted-types-for 'script'` doesn't break Lit's safe template
 *      path. If policy creation is forbidden, set a flag the element can
 *      read to degrade to iframe-only mode.
 *   4. Import Lit DSD-SSR hydration support (D1) — must come BEFORE the
 *      Lit element class so reactive properties bind to the SSR-rendered
 *      Shadow DOM correctly.
 *   5. Defensive `customElements.define` guard (D4) — `@customElement` decorator
 *      already runs `define`; this idempotent post-check guards against
 *      double-bundle-load (tenant pastes script twice, GTM re-injects, etc.).
 */

// 1. DOM clobbering stash — runs at module top-level evaluation.
import { $customElements } from './dom-stash.ts'
// 2 + 3. Security prologue.
import { detectPrototypePollution, registerLitTrustedTypesPolicy } from './security-prologue.ts'

if (detectPrototypePollution()) {
	throw new Error('widget-embed: prototype-pollution markers present — aborting boot')
}

const trustedTypesOk = registerLitTrustedTypesPolicy()

// 4. Lit DSD hydration support — MUST import before any LitElement subclass
//    is constructed so the global hydrate handlers are registered.
import '@lit-labs/ssr-client/lit-element-hydrate-support.js'

// 6. iframe fallback parent-side wrapper (M9.widget.6 / А4.4). Same idempotent
//    guard pattern. Tenants who paste this Lit element get auto-managed
//    iframe + nonce-bound postMessage handshake. Tenants on strict CSP can
//    paste raw `<iframe>` directly без this element.
import { IFRAME_FALLBACK_TAG, SochiIframeFallback } from './iframe-fallback.ts'
// 5. Element registration. `@customElement(WIDGET_TAG)` inside `widget.ts`
//    runs `customElements.define`; the guard below makes double-evaluation
//    idempotent (no DOMException on repeat-load).
import { SochiBookingWidget, WIDGET_TAG } from './widget.ts'

if (!$customElements.get(WIDGET_TAG)) {
	$customElements.define(WIDGET_TAG, SochiBookingWidget)
}
if (!$customElements.get(IFRAME_FALLBACK_TAG)) {
	$customElements.define(IFRAME_FALLBACK_TAG, SochiIframeFallback)
}

export { IFRAME_FALLBACK_TAG, SochiBookingWidget, SochiIframeFallback, trustedTypesOk, WIDGET_TAG }
