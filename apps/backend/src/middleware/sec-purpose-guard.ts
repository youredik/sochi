/**
 * Sec-Purpose: prefetch guard middleware — M9.widget.7 / A5.4 / D12.
 *
 * Per `plans/m9_widget_7_canonical.md` §2 D12 + R2 §7:
 *   «Backend `/book/...` returns 503 для `Sec-Purpose: prefetch` when not
 *    from hosted facade origin. Malicious embedder cross-tenant prefetch
 *    defense».
 *
 * **Why 503 not 200:**
 *   The Speculation Rules spec (https://wicg.github.io/nav-speculation/)
 *   treats `503 Service Unavailable` as «do not prefetch» — the user agent
 *   discards the prefetch result without surfacing it to the user, AND
 *   does NOT flag this as a real-user-visible failure (no console error
 *   no page-error). 4xx responses would surface as broken-link UX when the
 *   user actually clicks; 5xx are the canonical «not now» signal.
 *
 * **Threat model:**
 *   Malicious embedder injects `<script type="speculationrules">` referencing
 *   `https://victim.sochi.app/book/...` URLs to trigger cross-tenant
 *   prefetch. With this guard:
 *     - Prefetch sourced from a different origin than the request's own
 *       origin → 503 (deny + drop).
 *     - Prefetch from same-origin OR explicit hosted-facade origin → pass
 *       through normally.
 *
 * **Implementation:**
 *   - Read `Sec-Purpose` header (browser-set, can NOT be forged by JS).
 *   - If value contains `prefetch` substring AND `Origin`/`Referer` is
 *     foreign → 503 with `Cache-Control: no-store`.
 *   - Otherwise pass through.
 *
 * Mounted в app.ts on routes that should reject cross-origin prefetch:
 *   `/widget/*`, `/book/*`, anything user-state-bearing.
 */

import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../factory.ts'

export interface SecPurposeGuardOptions {
	/**
	 * Origins allowed to issue prefetch requests. By default this is the
	 * request's own origin (same-origin prefetch). For multi-origin setups
	 * (e.g. hosted facade на отдельном CDN) add explicit origins here.
	 *
	 * Example: `['https://widget.sochi.app']` — allows the embed facade
	 * домен to prefetch /book/... routes when user clicks.
	 */
	readonly allowedPrefetchOrigins?: ReadonlyArray<string>
}

/**
 * Build Sec-Purpose: prefetch guard middleware.
 *
 * Decision matrix:
 *   - No `Sec-Purpose` header → pass through (regular nav request).
 *   - `Sec-Purpose: prefetch` (substring) AND request `Origin` is undefined
 *     OR matches request's own origin → pass through (same-origin prefetch).
 *   - `Sec-Purpose: prefetch` AND `Origin` is foreign AND not in allowlist
 *     → 503.
 *
 * @returns Hono middleware ready для `app.use(...)`.
 */
export function secPurposeGuard(opts: SecPurposeGuardOptions = {}) {
	const allowedOrigins = new Set(opts.allowedPrefetchOrigins ?? [])
	return createMiddleware<AppEnv>(async (c, next) => {
		const secPurpose = c.req.header('sec-purpose')
		// Header absent → not a prefetch / prerender, pass through.
		if (typeof secPurpose !== 'string' || secPurpose.length === 0) {
			return next()
		}
		// Spec uses tokens; canonical 2026 values are `prefetch`,
		// `prerender`, `prefetch;anonymous-client-ip`. Substring match
		// catches all prefetch-class purposes.
		if (!secPurpose.toLowerCase().includes('prefetch')) {
			return next()
		}
		// Determine if the request originates from same-origin OR allowlist.
		const requestUrl = new URL(c.req.url)
		const ownOrigin = `${requestUrl.protocol}//${requestUrl.host}`
		const requestOrigin = c.req.header('origin')
		// `Origin` may be absent on top-level GETs even from same-origin —
		// fall back to `Referer` host comparison.
		const referer = c.req.header('referer')
		let refererOrigin: string | undefined
		if (referer !== undefined) {
			try {
				const refererUrl = new URL(referer)
				refererOrigin = `${refererUrl.protocol}//${refererUrl.host}`
			} catch {
				// Malformed referer — treat as foreign.
			}
		}
		const sourceOrigin = requestOrigin ?? refererOrigin
		// No source origin information at all → conservative deny: prefetch
		// without origin metadata is unusual and likely malicious-intent
		// scraping. Browsers send Origin/Referer for prefetches per spec.
		if (sourceOrigin === undefined) {
			return c.body(null, 503, { 'Cache-Control': 'no-store' })
		}
		if (sourceOrigin === ownOrigin || allowedOrigins.has(sourceOrigin)) {
			return next()
		}
		return c.body(null, 503, { 'Cache-Control': 'no-store' })
	})
}
