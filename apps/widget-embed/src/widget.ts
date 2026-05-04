/**
 * `<sochi-booking-widget-v1>` Lit element — facade.
 *
 * **Facade pattern (D12)** — this element ships in the small `embed.js`
 * bundle (≤15 KB gzip target). It renders the CTA button и dynamically
 * imports the heavy `booking-flow.js` chunk (≤80 KB gzip target) on user
 * click, then renders the lazy `<sochi-booking-flow>` element inside its
 * own shadow root. The Stripe Buy Button (3.5 KB gzip facade → 259 KB Stripe.js
 * lazy), Bnovo (4.2 KB → iframe lazy), SiteMinder (12.3 KB → hosted iframe),
 * Yandex.Travel (4.8 KB) ВСЕ ship two-stage. INP attribution from in-DOM
 * widget event handlers counts against the tenant's PSI score (web-vitals
 * 5 attribution build 2026), so a tiny facade keeps first-paint cheap.
 *
 * Per `plans/m9_widget_6_canonical.md`:
 *   - **D5** `:host { all: initial; isolation: isolate; contain: layout paint; }`
 *     defends parent cascade + clickjacking z-index attacks.
 *   - **D13** Legacy decorators (Lit team explicit production recommendation
 *     2026-Q2). Plain `@property() tenant = ''` (NO `accessor` keyword — Vite 8
 *     oxc bug vitejs/vite#21672).
 *   - **D17** Pollution-safe `Object.create(null)` containers for any state
 *     populated from untrusted sources (URL params, postMessage payloads).
 *   - **D19** `AbortController` per `connectedCallback`; abort in
 *     `disconnectedCallback`. ALL async (event listeners, fetch, observers)
 *     take `signal: this.#abort.signal`.
 *   - **D6** NO `<slot>` exposure; the lazy chunk renders content into
 *     trusted Shadow DOM templates only.
 *
 * Tenant analytics (R1c, D11) — emit `sochi-widget:event` `CustomEvent`
 * (`composed: true; bubbles: true`) so the tenant page can wire its own
 * Yandex.Metrica `ym(N, 'reachGoal', ...)` call. We deliberately do NOT
 * bundle Yandex.Metrica internally — Session Replay does not support
 * Shadow DOM, and bundling adds 152-ФЗ оператор-обработчик complications.
 */

import { css, html, LitElement } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { $createNullObject, $defineProperty, $document, $window } from './dom-stash.ts'

export const WIDGET_TAG = 'sochi-booking-widget-v1'

/**
 * Cached promise for the lazy chunk import. The dynamic import resolves once
 * (browser caches the module) — keeping the promise lets multiple click
 * handlers and the prefetch path share the same load without race-creating
 * duplicate fetch'ов.
 */
let bookingFlowChunk: Promise<unknown> | null = null

function loadBookingFlowChunk(): Promise<unknown> {
	if (bookingFlowChunk === null) {
		// Vite IIFE multi-entry build outputs `dist/booking-flow.js` as a
		// SEPARATE bundle (sibling URL). Tenants self-host both files at the
		// same origin (`widget.sochi.app/embed/v1/`); the relative path is
		// resolved against `import.meta.url` of the running facade.
		bookingFlowChunk = import('./booking-flow-entry.ts')
	}
	return bookingFlowChunk
}

@customElement(WIDGET_TAG)
export class SochiBookingWidget extends LitElement {
	/**
	 * `formAssociated` opts the element into the form-associated custom-elements
	 * spec (Chrome 77+, Safari 16.4+, Firefox 98+). Combined with
	 * `attachInternals()` it lets us expose canonical ARIA semantics
	 * (`role="application"` here would be wrong; the facade is essentially
	 * a `region` containing a `button`. We rely on the implicit `<button>`
	 * role and provide `aria-busy` while the chunk is loading.) The
	 * `ElementInternals` reference also paves the way for `formAssociated:
	 * true` if А4.4 wants the widget to participate в parent `<form>`
	 * submission flow.
	 */
	@property({ type: String, reflect: false }) tenant = ''

	@state() private status: 'idle' | 'loading' | 'ready' | 'error' = 'idle'

	#abort: AbortController | null = null

	#internals: ElementInternals | null = null
	#prefetchObserver: IntersectionObserver | null = null
	#prefetched = false

	/**
	 * Pollution-safe internal draft (D17). Populated from `tenant` attribute
	 * (which itself originates от tenant page DOM); round-trip через null-
	 * prototype dict so prototype-pollution gadgets cannot escalate when
	 * А4.3+ wire URL-param parsing.
	 */
	#draft: { tenant: string } = $createNullObject<{ tenant: string }>()

	static override styles = css`
		:host {
			all: initial;
			display: block;
			isolation: isolate;
			contain: layout paint;
			container-type: inline-size;
			font-family: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial,
				sans-serif;
			color: #0a0a0a;
			line-height: 1.4;
		}
		:host([hidden]) {
			display: none;
		}
		button.sochi-cta {
			cursor: pointer;
			font: inherit;
			padding: 0.75rem 1.5rem;
			border-radius: 0.5rem;
			border: 0;
			background: #0a0a0a;
			color: #ffffff;
			font-weight: 500;
		}
		button.sochi-cta:hover {
			background: #2a2a2a;
		}
		button.sochi-cta:focus-visible {
			outline: 2px solid #2563eb;
			outline-offset: 2px;
		}
		button.sochi-cta:disabled {
			opacity: 0.5;
			cursor: not-allowed;
		}
		.flow-status {
			margin: 0.5rem 0;
			color: #52525b;
			text-wrap: balance;
		}
		@container (min-width: 480px) {
			button.sochi-cta {
				font-size: 1rem;
				padding: 0.875rem 1.75rem;
			}
		}
		@media (forced-colors: active) {
			button.sochi-cta {
				background: ButtonText;
				color: ButtonFace;
			}
		}
		@media (prefers-reduced-motion: reduce) {
			button.sochi-cta {
				transition: none;
			}
		}
	`

	override connectedCallback(): void {
		super.connectedCallback()
		this.#abort = new AbortController()
		// ElementInternals — canonical 2026 ARIA reflection without light-DOM
		// attribute pollution (Chrome 90+ / Safari 16.4+ / Firefox 126+).
		// Spec: `attachInternals()` can only be called ONCE per element
		// instance (subsequent calls throw NotSupportedError). Across
		// disconnect/reconnect cycles the same internals object survives —
		// only attach if we haven't already.
		if (this.#internals === null && typeof this.attachInternals === 'function') {
			try {
				this.#internals = this.attachInternals()
				const internals = this.#internals as ElementInternals & { role?: string }
				internals.role = 'region'
				this.#internals.ariaLabel = 'Виджет бронирования'
			} catch {
				// Older browser without form-associated CE support — degrade
				// silently; `:not(:defined)` fallback (D20) handles end users.
				this.#internals = null
			}
		}
		// Prefetch lazy chunk when the CTA enters the viewport AND the browser
		// is idle. Canonical Stripe/Bnovo/SiteMinder pattern — by the time the
		// user clicks, the chunk is already in module cache, eliminating the
		// click-spinner-render visible delay. Both observers respect
		// `#abort.signal` so SPA route changes don't leak fetch handles.
		this.#schedulePrefetch()
	}

	override disconnectedCallback(): void {
		this.#abort?.abort()
		this.#abort = null
		this.#prefetchObserver?.disconnect()
		this.#prefetchObserver = null
		super.disconnectedCallback()
	}

	#schedulePrefetch(): void {
		if (this.#prefetched) return
		const IO = $window.IntersectionObserver
		if (typeof IO !== 'function') {
			// Old browser — accept click-time load, no prefetch.
			return
		}
		this.#prefetchObserver = new IO((entries) => {
			const entry = entries[0]
			if (!entry?.isIntersecting) return
			this.#prefetchObserver?.disconnect()
			this.#prefetchObserver = null
			this.#prefetchOnIdle()
		})
		this.#prefetchObserver.observe(this)
	}

	#prefetchOnIdle(): void {
		if (this.#prefetched) return
		this.#prefetched = true
		const ric = ($window as Window & { requestIdleCallback?: typeof requestIdleCallback })
			.requestIdleCallback
		const launch = (): void => {
			if (this.#abort?.signal.aborted === true) return
			void loadBookingFlowChunk().catch(() => {
				// Reset cached promise so the click-time path can retry.
				bookingFlowChunk = null
				this.#prefetched = false
			})
		}
		if (typeof ric === 'function') {
			ric(launch, { timeout: 2_000 })
		} else {
			$window.setTimeout(launch, 200)
		}
	}

	override render(): unknown {
		switch (this.status) {
			case 'loading':
				return html`<p class="flow-status" data-testid="widget-loading" aria-live="polite">
					Загружаем форму бронирования…
				</p>`
			case 'error':
				return html`<p class="flow-status" data-testid="widget-error" role="alert">
					Не удалось загрузить виджет. Попробуйте ещё раз.
				</p>`
			case 'ready':
				return html`<sochi-booking-flow
					data-testid="widget-flow"
					.tenant=${this.tenant}
				></sochi-booking-flow>`
			default:
				return html`<button
					type="button"
					class="sochi-cta"
					data-testid="widget-cta"
					@click=${this.#handleOpen}
				>
					Забронировать
				</button>`
		}
	}

	#handleOpen = async (_event: MouseEvent): Promise<void> => {
		const signal = this.#abort?.signal
		this.status = 'loading'
		if (this.#internals) this.#internals.ariaBusy = 'true'

		// Capture tenant slug into pollution-safe draft (D17). А4.3+ will
		// extend с checkIn / checkOut / guestCount from URL search params.
		$defineProperty(this.#draft, 'tenant', {
			value: this.tenant,
			writable: true,
			configurable: false,
			enumerable: true,
		})
		// Stashed document ref (D16) — keep reference live for IIFE call sites
		// that bypass member-style access.
		void $document

		try {
			await loadBookingFlowChunk()
			if (signal?.aborted) return
			this.status = 'ready'
			if (this.#internals) this.#internals.ariaBusy = 'false'
		} catch {
			if (signal?.aborted) return
			this.status = 'error'
			if (this.#internals) this.#internals.ariaBusy = 'false'
			// Reset cached promise so subsequent click retries the import.
			bookingFlowChunk = null
		}
	}
}
