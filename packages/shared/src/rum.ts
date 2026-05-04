/**
 * Shared types + schema for RUM (Real User Monitoring) — M9.widget.7 / A5.2.
 *
 * Per `plans/m9_widget_7_canonical.md` D7 + D8:
 *   - D7: frontend → POST /api/rum → backend bridge → Yandex Cloud Monitoring
 *         (proprietary HTTP API; OTLP NOT native per docs 2026-03-24).
 *   - D8: 152-ФЗ MANDATORY anonymization pipeline. INP attribution
 *         `interactionTarget` like `input[name="passport_serial"]` IS ПДн под
 *         ст. 3 ч. 1 152-ФЗ → caller MUST scrub via
 *         `apps/frontend/src/lib/rum/anonymize.ts` BEFORE POST.
 *
 * Schema is the single source of truth: frontend builds payload + validates,
 * backend zValidator reads the same shape. Subpath export `./rum` to avoid
 * pulling other shared barrels into client bundle.
 */

import { z } from 'zod'

/** web-vitals 5.x metric names (CLS / INP / LCP / FCP / TTFB only — no PING). */
export const RumMetricNameSchema = z.enum(['CLS', 'INP', 'LCP', 'FCP', 'TTFB'])
export type RumMetricName = z.infer<typeof RumMetricNameSchema>

/** web-vitals 5.x rating buckets — pinned vs library spec. */
export const RumRatingSchema = z.enum(['good', 'needs-improvement', 'poor'])
export type RumRating = z.infer<typeof RumRatingSchema>

/**
 * Bucketed UA — caller MUST anonymize via `bucketUserAgent()` before send.
 * Raw UA strings are ПДн class B (browser fingerprint) + leak OS-version
 * patches → defender mat.
 */
export const RumUaBucketSchema = z.object({
	browser: z.enum(['chrome', 'firefox', 'safari', 'edge', 'opera', 'other']),
	os: z.enum(['windows', 'macos', 'linux', 'ios', 'android', 'other']),
	mobile: z.boolean(),
})
export type RumUaBucket = z.infer<typeof RumUaBucketSchema>

/**
 * Normalized attribution slice — web-vitals 5.x attribution build only.
 *
 * Frontend `rum/index.ts` extracts the metric-specific selector field from
 * web-vitals (INP `interactionTarget`, LCP `target`, CLS `largestShiftTarget`)
 * → runs through `scrubSelector()` → assigns to `selector` here.
 *
 * `loadState` / numeric timings are PII-free by web-vitals design but we
 * still cap to known shape (defense-in-depth + bounded backend storage).
 */
export const RumAttributionSchema = z
	.object({
		/** Scrubbed CSS-selector — caller MUST run scrubSelector() first (D8). */
		selector: z.string().max(512).optional(),
		loadState: z.enum(['loading', 'dom-interactive', 'dom-content-loaded', 'complete']).optional(),
		// INP attribution timings (numeric — PII-free).
		interactionType: z.enum(['pointer', 'keyboard']).optional(),
		interactionTime: z.number().nonnegative().optional(),
		inputDelay: z.number().nonnegative().optional(),
		processingDuration: z.number().nonnegative().optional(),
		presentationDelay: z.number().nonnegative().optional(),
		nextPaintTime: z.number().nonnegative().optional(),
		// LCP attribution timings.
		timeToFirstByte: z.number().nonnegative().optional(),
		resourceLoadDelay: z.number().nonnegative().optional(),
		resourceLoadDuration: z.number().nonnegative().optional(),
		elementRenderDelay: z.number().nonnegative().optional(),
		// CLS attribution values.
		largestShiftTime: z.number().nonnegative().optional(),
		largestShiftValue: z.number().nonnegative().optional(),
	})
	.strict()
export type RumAttribution = z.infer<typeof RumAttributionSchema>

/**
 * Single RUM metric envelope — payload sent over the wire frontend → backend.
 * `tenantSlug` optional: SPA hosted route knows it (path-segment); raw embed
 * (`/api/embed/v1/iframe/...`) also knows from URL. CSP + cross-origin embed
 * may strip it — that's fine, we still ingest as «unknown-tenant» bucket.
 */
export const RumMetricSchema = z
	.object({
		metric: RumMetricNameSchema,
		value: z.number().nonnegative().finite(),
		rating: RumRatingSchema,
		id: z.string().min(1).max(64),
		navigationType: z
			.enum(['navigate', 'reload', 'back-forward', 'back-forward-cache', 'prerender', 'restore'])
			.optional(),
		// Pathname only — caller MUST strip query/hash via `scrubUrl()`.
		path: z.string().min(1).max(512),
		ua: RumUaBucketSchema,
		tenantSlug: z
			.string()
			.regex(/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/)
			.optional(),
		// Wall-clock timestamp at client send (ms since epoch). Backend MAY
		// override with server-receive ts to prevent client clock drift.
		ts: z.number().int().positive(),
		attribution: RumAttributionSchema.optional(),
	})
	.strict()
export type RumMetric = z.infer<typeof RumMetricSchema>

/**
 * Batched POST body — `metrics` array (≤16 per request to bound payload).
 * Frontend `batch.flush()` collects up to 16 metrics or 5s window then POSTs.
 */
export const RumBatchSchema = z
	.object({
		metrics: z.array(RumMetricSchema).min(1).max(16),
	})
	.strict()
export type RumBatch = z.infer<typeof RumBatchSchema>

// ---------------------------------------------------------------------------
// IP truncation (152-ФЗ edge anonymization) — D8.
// ---------------------------------------------------------------------------

/**
 * Truncate IP per RFC 7239 / GA4 / Yandex.Metrica `ip_truncate` semantics:
 *   - IPv4: zero last octet → `203.0.113.42` ⇒ `203.0.113.0`
 *   - IPv6: zero last 80 bits (keep /48 prefix, the «site»-level mask)
 *           → `2001:db8:1::cafe` ⇒ `2001:db8:1::`
 *   - Invalid / empty → `'unknown'` (backend sentinel).
 *
 * Called BEFORE persistence at the edge of POST /api/rum. Frontend never
 * knows the public IP (NAT) — this lives backend-side, but the helper is
 * shared so 152-ФЗ tests can verify the contract from anywhere.
 *
 * @example
 * truncateIp('203.0.113.42')        // '203.0.113.0'
 * truncateIp('2001:db8:1::cafe')    // '2001:db8:1::'
 * truncateIp('::ffff:203.0.113.42') // '203.0.113.0'  (IPv4-mapped IPv6 unwrap)
 * truncateIp('garbage')             // 'unknown'
 */
export function truncateIp(ip: string | null | undefined): string {
	if (typeof ip !== 'string') return 'unknown'
	const trimmed = ip.trim()
	if (trimmed.length === 0) return 'unknown'

	// Unwrap IPv4-mapped IPv6 (`::ffff:1.2.3.4`) per RFC 4291 §2.5.5.2.
	const v4Mapped = trimmed.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i)
	const candidate = v4Mapped?.[1] ?? trimmed

	// IPv4: x.x.x.x
	const v4Match = candidate.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
	if (v4Match) {
		const [, a, b, c] = v4Match
		const oct = [a, b, c].map((s) => Number.parseInt(s ?? '', 10))
		if (oct.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
			return `${oct[0]}.${oct[1]}.${oct[2]}.0`
		}
		return 'unknown'
	}

	// IPv6: keep first 3 hextets (/48 prefix), zero the rest.
	if (candidate.includes(':')) {
		// Reject obvious garbage — must have only hex+colon.
		if (!/^[0-9a-fA-F:]+$/.test(candidate)) return 'unknown'
		// Expand `::` once.
		const hadDouble = candidate.includes('::')
		const halves = candidate.split('::')
		if (hadDouble && halves.length !== 2) return 'unknown'
		const left = (halves[0] ?? '').split(':').filter((h) => h.length > 0)
		const right = hadDouble ? (halves[1] ?? '').split(':').filter((h) => h.length > 0) : []
		const totalLen = left.length + right.length
		if (totalLen > 8) return 'unknown'
		const fillCount = hadDouble ? 8 - totalLen : 0
		const expanded = [...left, ...Array<string>(fillCount).fill('0'), ...right]
		if (expanded.length !== 8) return 'unknown'
		// Validate each hextet ≤4 hex chars.
		if (!expanded.every((h) => /^[0-9a-fA-F]{1,4}$/.test(h))) return 'unknown'
		// Keep first 3 hextets (48 bits), zero remaining 5 hextets (80 bits).
		return `${expanded[0]}:${expanded[1]}:${expanded[2]}::`
	}

	return 'unknown'
}
