/**
 * RUM (Real User Monitoring) pipeline — M9.widget.7 / A5.2.
 *
 * Wires web-vitals 5.x attribution build → 152-ФЗ anonymize → batched POST to
 * `/api/rum/v1/web-vitals`. Per plan §2:
 *   - D6: web-vitals 5.x attribution build via `web-vitals/attribution` subpath
 *   - D7: frontend → backend bridge → Yandex Cloud Monitoring (proprietary HTTP API)
 *   - D8: MANDATORY anonymize before send (selector / UA / URL scrubbing)
 *   - D9 / R2 §7: skip emission while `document.prerendering` (phantom-session
 *                 filter — Speculation Rules prefetch should NOT pollute RUM)
 *
 * Shape:
 *   - Each metric arrives via on{INP,LCP,CLS,FCP,TTFB} callback
 *   - We anonymize + queue → flush every 5s OR when queue reaches 16
 *   - On `pagehide` / `visibilitychange:hidden` we flush via `sendBeacon`
 *     (synchronous-ish, survives tab close per Web Specs)
 *   - On 4xx we drop the batch (don't retry permanent failures)
 *   - On 5xx / network error we silently drop (RUM MUST NOT loop-page-error)
 *
 * Tested via `web-vitals.test.ts` (existing OTel) + new RUM integration tests
 * on backend side (`rum.routes.test.ts`).
 */

import {
	RumBatchSchema,
	type RumMetric,
	type RumMetricName,
	type RumRating,
} from '@horeca/shared/rum'
import { onCLS, onFCP, onINP, onLCP, onTTFB } from 'web-vitals/attribution'
import { bucketUserAgent, scrubSelector, scrubUrl } from './anonymize.ts'

/** Maximum metrics per batch — matches backend `RumBatchSchema.max(16)`. */
const BATCH_MAX_SIZE = 16
/** Flush window — 5s mirrors web-vitals default reporting cadence. */
const BATCH_FLUSH_MS = 5_000
/** Backend ingest path — D7 canonical. */
const RUM_ENDPOINT = '/api/rum/v1/web-vitals'

/**
 * Test seam — overridable for unit testing. Production uses real
 * `globalThis.fetch` + `navigator.sendBeacon`.
 */
export interface RumTransport {
	readonly fetch: (url: string, init: RequestInit) => Promise<Response>
	readonly sendBeacon: (url: string, body: BodyInit) => boolean
	readonly now: () => number
	readonly setTimeout: (cb: () => void, ms: number) => ReturnType<typeof globalThis.setTimeout>
	readonly clearTimeout: (handle: ReturnType<typeof globalThis.setTimeout>) => void
	readonly userAgent: string
	readonly path: string
	/** Optional tenant slug — extracted by caller from path-segment. */
	readonly tenantSlug?: string | undefined
}

function defaultTransport(): RumTransport {
	return {
		fetch: (url, init) => globalThis.fetch(url, init),
		sendBeacon: (url, body) => globalThis.navigator?.sendBeacon(url, body) ?? false,
		now: () => Date.now(),
		setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
		clearTimeout: (h) => globalThis.clearTimeout(h),
		userAgent: globalThis.navigator?.userAgent ?? '',
		path: globalThis.location?.pathname ?? '/',
		tenantSlug: extractTenantSlug(globalThis.location?.pathname ?? ''),
	}
}

/**
 * Pulls `tenantSlug` from `/widget/:slug/...` or `/book/:slug/...` URLs.
 * Other paths return `undefined` — backend ingests as «unknown-tenant»
 * bucket without rejecting.
 */
function extractTenantSlug(pathname: string): string | undefined {
	const m = pathname.match(/^\/(?:widget|book)\/([a-z0-9][a-z0-9-]{1,28}[a-z0-9])(?:\/|$)/)
	return m?.[1]
}

/**
 * Normalize web-vitals 5 metric callback object → wire-shape `RumMetric`.
 * Centralizes anonymization (D8) — every selector field passes through
 * `scrubSelector()`. Numeric timings copied verbatim (PII-free per spec).
 */
interface RawMetric {
	readonly name: string
	readonly value: number
	readonly rating: string
	readonly id: string
	readonly navigationType?: string
	readonly attribution?: unknown
}

function normalizeMetric(raw: RawMetric, transport: RumTransport): RumMetric | null {
	// Defensive guard — web-vitals MAY emit non-canonical names if API drift.
	if (!isMetricName(raw.name)) return null
	if (!isRating(raw.rating)) return null
	if (!Number.isFinite(raw.value) || raw.value < 0) return null

	const attribution: Record<string, unknown> =
		raw.attribution !== null && typeof raw.attribution === 'object'
			? (raw.attribution as Record<string, unknown>)
			: {}
	// Pick the metric-specific selector field per web-vitals 5 attribution
	// types (INP=interactionTarget; LCP=target; CLS=largestShiftTarget).
	const rawSelector =
		(attribution.interactionTarget as string | undefined) ??
		(attribution.target as string | undefined) ??
		(attribution.largestShiftTarget as string | undefined)

	const navType = isNavType(raw.navigationType) ? raw.navigationType : undefined

	return {
		metric: raw.name,
		value: raw.value,
		rating: raw.rating,
		id: raw.id.slice(0, 64),
		navigationType: navType,
		path: scrubUrl(transport.path),
		ua: bucketUserAgent(transport.userAgent),
		tenantSlug: transport.tenantSlug,
		ts: transport.now(),
		attribution: {
			selector: rawSelector ? scrubSelector(rawSelector) : undefined,
			loadState: pickEnum(attribution.loadState, [
				'loading',
				'dom-interactive',
				'dom-content-loaded',
				'complete',
			]),
			interactionType: pickEnum(attribution.interactionType, ['pointer', 'keyboard']),
			interactionTime: pickFiniteNonNeg(attribution.interactionTime),
			inputDelay: pickFiniteNonNeg(attribution.inputDelay),
			processingDuration: pickFiniteNonNeg(attribution.processingDuration),
			presentationDelay: pickFiniteNonNeg(attribution.presentationDelay),
			nextPaintTime: pickFiniteNonNeg(attribution.nextPaintTime),
			timeToFirstByte: pickFiniteNonNeg(attribution.timeToFirstByte),
			resourceLoadDelay: pickFiniteNonNeg(attribution.resourceLoadDelay),
			resourceLoadDuration: pickFiniteNonNeg(attribution.resourceLoadDuration),
			elementRenderDelay: pickFiniteNonNeg(attribution.elementRenderDelay),
			largestShiftTime: pickFiniteNonNeg(attribution.largestShiftTime),
			largestShiftValue: pickFiniteNonNeg(attribution.largestShiftValue),
		},
	}
}

const METRIC_NAMES = ['CLS', 'INP', 'LCP', 'FCP', 'TTFB'] as const
function isMetricName(s: string): s is RumMetricName {
	return (METRIC_NAMES as readonly string[]).includes(s)
}
const RATINGS = ['good', 'needs-improvement', 'poor'] as const
function isRating(s: string): s is RumRating {
	return (RATINGS as readonly string[]).includes(s)
}
const NAV_TYPES = [
	'navigate',
	'reload',
	'back-forward',
	'back-forward-cache',
	'prerender',
	'restore',
] as const
function isNavType(s: string | undefined): s is (typeof NAV_TYPES)[number] {
	return typeof s === 'string' && (NAV_TYPES as readonly string[]).includes(s)
}

function pickEnum<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
	if (typeof v !== 'string') return undefined
	return (allowed as readonly string[]).includes(v) ? (v as T) : undefined
}

function pickFiniteNonNeg(v: unknown): number | undefined {
	if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined
	return v
}

// ---------------------------------------------------------------------------
// Batcher
// ---------------------------------------------------------------------------

class RumBatcher {
	#buffer: RumMetric[] = []
	#timer: ReturnType<typeof globalThis.setTimeout> | undefined
	readonly #transport: RumTransport

	constructor(transport: RumTransport) {
		this.#transport = transport
	}

	push(metric: RumMetric): void {
		this.#buffer.push(metric)
		if (this.#buffer.length >= BATCH_MAX_SIZE) {
			void this.flush()
			return
		}
		this.#scheduleFlush()
	}

	#scheduleFlush(): void {
		if (this.#timer !== undefined) return
		this.#timer = this.#transport.setTimeout(() => {
			this.#timer = undefined
			void this.flush()
		}, BATCH_FLUSH_MS)
	}

	async flush(): Promise<void> {
		if (this.#buffer.length === 0) return
		const drained = this.#buffer
		this.#buffer = []
		if (this.#timer !== undefined) {
			this.#transport.clearTimeout(this.#timer)
			this.#timer = undefined
		}
		const body: unknown = { metrics: drained }
		const parsed = RumBatchSchema.safeParse(body)
		if (!parsed.success) {
			// Malformed payload — drop silently (RUM MUST NOT loop on its own
			// errors). Defense-in-depth: should never fire because we already
			// validate per-metric in normalizeMetric().
			return
		}
		try {
			await this.#transport.fetch(RUM_ENDPOINT, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(parsed.data),
				keepalive: true,
				credentials: 'same-origin',
				mode: 'same-origin',
			})
		} catch {
			// Network error / 5xx → silent drop.
		}
	}

	flushBeacon(): void {
		if (this.#buffer.length === 0) return
		const drained = this.#buffer
		this.#buffer = []
		if (this.#timer !== undefined) {
			this.#transport.clearTimeout(this.#timer)
			this.#timer = undefined
		}
		const parsed = RumBatchSchema.safeParse({ metrics: drained })
		if (!parsed.success) return
		const blob = new Blob([JSON.stringify(parsed.data)], { type: 'application/json' })
		this.#transport.sendBeacon(RUM_ENDPOINT, blob)
	}

	get bufferSize(): number {
		return this.#buffer.length
	}
}

// ---------------------------------------------------------------------------
// Public entry — startRum()
// ---------------------------------------------------------------------------

let started = false

/**
 * Initialize RUM pipeline. Call once after main React mount.
 *
 * Idempotent: subsequent calls are no-ops (web-vitals callbacks would fire
 * twice otherwise → 2× upload bloat). React StrictMode-safe.
 *
 * Per R2 §7 / D11: while `document.prerendering` is `true` we skip emission
 * entirely — Speculation Rules prefetch SHOULD NOT generate phantom-session
 * RUM rows. We re-arm in the `prerenderingchange` event listener so once the
 * page activates the next metric callback enters the queue normally.
 *
 * @param transport optional override for testing; default uses globals.
 */
export function startRum(transport: RumTransport = defaultTransport()): {
	flush: () => Promise<void>
	bufferSize: () => number
} {
	if (started) {
		// Idempotent: subsequent calls return inert handle so React StrictMode
		// double-render doesn't double-register web-vitals callbacks.
		return { flush: async () => undefined, bufferSize: () => 0 }
	}
	started = true

	const batcher = new RumBatcher(transport)

	const handle = (raw: RawMetric) => {
		// R2 §7 phantom-session filter: skip while prerendering.
		if (typeof document !== 'undefined' && document.prerendering === true) return
		const metric = normalizeMetric(raw, transport)
		if (metric === null) return
		batcher.push(metric)
	}

	onCLS(handle)
	onINP(handle)
	onLCP(handle)
	onFCP(handle)
	onTTFB(handle)

	// Flush on tab close — `pagehide` is the canonical event (more reliable
	// than `unload` per webvitals.dev guide). `visibilitychange:hidden`
	// covers tab-switch flushes.
	if (typeof globalThis.addEventListener === 'function') {
		globalThis.addEventListener('pagehide', () => batcher.flushBeacon(), { capture: true })
		globalThis.addEventListener(
			'visibilitychange',
			() => {
				if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
					batcher.flushBeacon()
				}
			},
			{ capture: true },
		)
	}

	return {
		flush: () => batcher.flush(),
		bufferSize: () => batcher.bufferSize,
	}
}
