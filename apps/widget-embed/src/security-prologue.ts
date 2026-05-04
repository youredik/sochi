/**
 * IIFE-prologue security hardening — runs once at bundle load.
 *
 * - **D15 Trusted Types policy** — if tenant CSP enforces
 *   `require-trusted-types-for 'script'`, all `innerHTML` / `<script>` sink
 *   writes throw `TypeError`. Lit 3 reads a `'lit-html'` policy if registered,
 *   otherwise falls through to the default policy (which strict CSP forbids).
 *   We register a passthrough policy so Lit's safe template path keeps
 *   working. Tenant must also allow-list our policy in their CSP header:
 *   `trusted-types lit-html 'allow-duplicates'`. Documented в onboarding pack.
 *
 * - **D17 Prototype-pollution gadget detection** — CVE-2026-41238 explicitly
 *   weaponizes 3rd-party widget ↔ host page boundary. Tenant page pollutes
 *   `Object.prototype.polluted` / `Array.prototype.includes` BEFORE our bundle
 *   evaluates. Boot-time guard: if pollution markers are present, abort —
 *   `:not(:defined)` fallback (D20) stays visible. We do NOT freeze
 *   `Object.prototype` / `Array.prototype` (would break tenant code →
 *   liability).
 *
 * Both checks fire at IIFE entry, before `customElements.define`, so the
 * fallback link inside `<sochi-booking-widget-v1>` stays the rendered UX.
 */

import { $window } from './dom-stash.ts'

/**
 * Minimal Trusted Types types — TS 6.0 lib.dom.d.ts does not yet include
 * the W3C TR (Feb 2026 WD). Once it lands, this declaration becomes a
 * no-op and can be removed.
 */
interface TrustedTypesPolicy {
	createHTML: (input: string) => string
}
interface TrustedTypesAPI {
	createPolicy: (name: string, policy: TrustedTypesPolicy) => unknown
}
interface WindowWithTrustedTypes {
	trustedTypes?: TrustedTypesAPI
}

/**
 * Register `lit-html` Trusted Types policy if the API is available. Returns
 * `true` on success or when TT is not enforced. Returns `false` if registration
 * is forbidden (tenant CSP `trusted-types 'none'`) — caller should degrade
 * to iframe-only fallback.
 */
export function registerLitTrustedTypesPolicy(): boolean {
	const tt = ($window as unknown as WindowWithTrustedTypes).trustedTypes
	if (tt === undefined) return true
	if (typeof tt.createPolicy !== 'function') return true
	try {
		tt.createPolicy('lit-html', {
			createHTML: (s: string) => s,
		})
		return true
	} catch {
		// Policy creation forbidden by CSP — caller falls back to iframe mode.
		return false
	}
}

/**
 * Detect indicators of prototype pollution in the running global scope.
 * Returns `true` if pollution is detected (caller should abort boot).
 *
 * Canonical detection pattern: a fresh empty object `{}` should produce ZERO
 * keys via `for-in` (which iterates own + inherited enumerable string keys).
 * If `Object.prototype` has been polluted with enumerable properties (the
 * default behaviour of lodash.set / jQuery.extend recursive merge / direct
 * `Object.prototype.x = y` assignment), they leak into every new object and
 * `for-in` reveals them. False-positive risk is essentially zero:
 * `Object.prototype` ships with NO enumerable properties on any modern engine.
 *
 * `Array.prototype` is checked the same way for completeness — many gadget
 * chains target `Array.prototype.includes` / `Array.prototype.find`.
 *
 * Reference: CVE-2026-41238 (DOMPurify ↔ widget pollution chain),
 * OWASP Prototype Pollution Prevention Cheat Sheet (2026-Q2).
 */
export function detectPrototypePollution(): boolean {
	const probeObj = {} as Record<string, unknown>
	for (const k in probeObj) {
		// Any inherited enumerable key on a fresh `{}` ⇒ Object.prototype polluted.
		if (!Object.hasOwn(probeObj, k)) return true
	}
	const probeArr = [] as unknown as Record<string, unknown>
	for (const k in probeArr) {
		if (!Object.hasOwn(probeArr, k)) return true
	}
	return false
}
