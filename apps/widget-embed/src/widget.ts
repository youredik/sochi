/**
 * `<sochi-booking-widget-v1>` Lit element — A4.1 facade scaffold.
 *
 * **Facade pattern (D12)** — this element ships in the small `embed.js`
 * bundle (≤15 KB gzip target). It renders only the CTA button + lazy
 * trigger. The full booking flow (search → addons → guest → confirm) is
 * a separately-built `booking-flow.js` (≤80 KB gzip target) that gets
 * dynamically imported on user interaction OR `requestIdleCallback`. This
 * is the canonical 2026 industry pattern — Stripe Buy Button (3.5 KB gzip
 * loader → 259 KB Stripe.js lazy), Bnovo (4.2 KB → iframe lazy), SiteMinder
 * (12.3 KB → hosted iframe), Yandex.Travel (4.8 KB → widget API). It also
 * defends tenant Core Web Vitals — INP attribution from in-DOM widgets
 * counts against the tenant's PSI score (developers.google.com/search/blog
 * 2023 + web-vitals 5 attribution build 2026).
 *
 * Per `plans/m9_widget_6_canonical.md`:
 *   - **D5** — `:host { all: initial; isolation: isolate; contain: layout paint; }`
 *     defends against parent cascade + clickjacking z-index attacks.
 *   - **D13** — TS legacy decorators canonical (Lit team explicit recommendation
 *     2026-Q2). Plain `@property() name = ''` (NO `accessor` keyword — Vite 8
 *     oxc bug vitejs/vite#21672).
 *   - **D19** — `AbortController` per `connectedCallback`; abort in
 *     `disconnectedCallback`. ALL async (event listeners, fetch, observers)
 *     take `signal: this.#abort.signal`.
 *   - **D6** — NO `<slot>` exposure; A4.2 will render API-fetched content
 *     into trusted Shadow DOM templates only.
 */

import { css, html, LitElement } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { $createNullObject, $defineProperty, $document } from './dom-stash.ts'

export const WIDGET_TAG = 'sochi-booking-widget-v1'

@customElement(WIDGET_TAG)
export class SochiBookingWidget extends LitElement {
	@property({ type: String, reflect: false }) tenant = ''

	@state() private flowOpen = false

	#abort: AbortController | null = null

	/**
	 * Pollution-safe internal state container (D17). А4.2 will populate this
	 * with normalized booking-draft fields read from URL query params /
	 * postMessage payloads — both untrusted, both must use null-prototype
	 * dictionaries to skirt prototype-pollution gadgets.
	 */
	#draft: { tenant: string } = $createNullObject<{ tenant: string }>()

	static override styles = css`
		:host {
			all: initial;
			display: block;
			isolation: isolate;
			contain: layout paint;
			font-family: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
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
	}

	override disconnectedCallback(): void {
		// D19 — abort all in-flight async (fetches, listeners, observers) so
		// SPA route changes don't leak handlers.
		this.#abort?.abort()
		this.#abort = null
		super.disconnectedCallback()
	}

	override render(): unknown {
		// A4.1 facade — renders only the CTA. A4.2 will lazy-load
		// booking-flow chunk on click; for now we surface a loading hint
		// so the UX during chunk-fetch is non-empty.
		if (this.flowOpen) {
			return html`<p data-testid="widget-loading" aria-live="polite">
				Загружаем форму бронирования…
			</p>`
		}
		return html`<button
			type="button"
			class="sochi-cta"
			data-testid="widget-cta"
			@click=${this.#handleOpen}
		>
			Забронировать
		</button>`
	}

	#handleOpen = (_event: MouseEvent): void => {
		// A4.1 placeholder — A4.2 wires `import('./booking-flow.js')` here
		// (lazy chunk, ≤80 KB gzip target). For now toggle a state so tests
		// can verify click semantics.
		this.flowOpen = true
		// Capture tenant slug into pollution-safe draft (D17). A4.2 will
		// extend with checkIn/checkOut/guestCount from URL query params —
		// `URLSearchParams` reads attacker-controlled data, must round-trip
		// through `Object.create(null)`.
		$defineProperty(this.#draft, 'tenant', {
			value: this.tenant,
			writable: true,
			configurable: false,
			enumerable: true,
		})
		// Use stashed document ref (D16) — never bare `document` access in
		// IIFE-bundled code.
		void $document
	}
}
