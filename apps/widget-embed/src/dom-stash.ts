/**
 * IIFE-prologue stash of canonical browser globals — D16 (DOM Clobbering
 * defense, R2 #2) + D17 helpers (prototype pollution defense, R2 #1).
 *
 * Tenant pages (especially Bitrix / WordPress / Tilda CMSes very common in
 * the Russian SMB segment) routinely contain user-generated HTML like
 * `<form id="document">`, `<img name="customElements">`, `<a id="window">`.
 * These shadow the same-named globals our bundle expects (`document`,
 * `window`, `customElements`). Reading from `window.X` returns the clobbered
 * DOM node; method calls then throw or — worse — silently route through
 * attacker-controlled DOM properties.
 *
 * Capture references at script-evaluation time (before any tenant code can
 * inject more clobber) and use them throughout the bundle. A Biome
 * `noRestrictedSyntax` rule will ban bare `document.X` / `window.X` /
 * `customElements.X` access in `apps/widget-embed/src/**` (added in А4.2 when
 * call sites multiply).
 *
 * Hardening:
 *   - `instanceof` type checks defend against tenant-defined globals that
 *     exist but are bogus (e.g. tenant page sets `window.customElements = {}`)
 *   - Throwing on mismatch prevents the bundle from booting in a hostile
 *     environment — the `:not(:defined)` fallback (D20) shows the static
 *     "Забронировать" link instead.
 *   - `$createNullObject` / `$defineProperty` are pollution-safe primitives
 *     для serialized dictionaries (postMessage payloads, `data-*` parsed
 *     objects) — `Object.create(null)` skips the `Object.prototype` chain
 *     entirely, so prototype-polluted gadgets cannot escalate.
 *
 * References:
 *   - OWASP DOM Clobbering Prevention Cheat Sheet (2026-Q2)
 *   - IEEE S&P 2023 — DOM Clobbering Time (9.8 % of top 5 K sites affected)
 *   - CVE-2024-43788 (Webpack runtime clobbered via `<img name="currentScript">`)
 *   - CVE-2026-41238 (DOMPurify 3.0.1-3.3.3 prototype pollution chain via embed)
 */

const $win = globalThis.window
const $doc = $win.document
const $CE = $win.customElements

// Defensive checks: if any of these is not what we expect, the bundle is
// running in an environment that has been clobbered or polyfilled in a way
// we cannot trust. Throw early — `:not(:defined)` fallback HTML stays visible.
if (!($doc instanceof Document)) {
	throw new Error('widget-embed: hostile environment — document clobbered')
}
if (!($CE instanceof CustomElementRegistry)) {
	throw new Error('widget-embed: hostile environment — customElements clobbered')
}

/**
 * Pollution-safe dictionary factory — `Object.create(null)` produces an
 * object whose `[[Prototype]]` is `null`, so no inherited properties from
 * `Object.prototype`. Use for ALL postMessage payload deserializations,
 * `data-*` attribute object parses, and internal config maps в booking-flow.
 */
const $createNullObject = <T extends object>(): T => Object.create(null) as T

/**
 * Stashed reference to `Object.defineProperty` — used to install IO v2
 * visibility guards on submit buttons (D18) without trusting a clobbered
 * `Object.defineProperty` from tenant page.
 */
const $defineProperty = Object.defineProperty.bind(Object)

export {
	$CE as $customElements,
	$createNullObject,
	$defineProperty,
	$doc as $document,
	$win as $window,
}
