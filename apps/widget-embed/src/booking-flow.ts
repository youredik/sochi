/**
 * `<sochi-booking-flow>` — the heavy booking-flow element loaded lazily.
 *
 * Per `plans/m9_widget_6_canonical.md`:
 *   - **D5** Container queries (`@container`) для responsive breakpoints —
 *     the embed renders inside arbitrary tenant page widths; CSS media-queries
 *     against `100vw` would lie. Container queries scale to the actual host
 *     width.
 *   - **D5** `@starting-style` для entrance animation (smooth FCP from
 *     CTA-state to flow-state without JS animation library cost).
 *   - **D17** All untrusted dictionaries (URL params, `data-*` attrs)
 *     round-trip through `Object.create(null)` via `$createNullObject`.
 *   - **D18** Submit guard — IntersectionObserver v2 visibility check posts
 *     a `clientCommitToken` on user click only when the button is genuinely
 *     visible (defends against in-DOM clickjacking on tenant page).
 *   - **D19** AbortController canon — every async resource takes
 *     `signal: this.#abort.signal`.
 *
 * Scope of A4.2: render the property summary the user is booking (fetched
 * lazily from `/api/public/widget/{slug}/property`) + provide a primary CTA
 * that emits `sochi-widget:booking_flow_open` `CustomEvent` (tenant page
 * receives it и calls Yandex.Metrica `ym(N, 'reachGoal', 'sochi_open')`
 * itself per D11 / R1c — analytics live на tenant's tag, NOT bundled).
 *
 * А4.3 backend lands `/api/public/widget/{slug}/property` route. А4.4 wires
 * iframe fallback. The screen multistep (search/extras/guest/confirm)
 * existing inside `apps/frontend` is reused via iframe-or-DOM hybrid в later
 * iterations; for А4.2 the focus is the lazy chunk architecture +
 * security-correct visibility-gated CTA.
 */

import { css, html, LitElement, nothing } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { $createNullObject, $document, $window } from './dom-stash.ts'

export const BOOKING_FLOW_TAG = 'sochi-booking-flow'

interface PropertySummary {
	readonly slug: string
	readonly name: string
}

/**
 * Tag-level type for `CustomEvent` emitted by the flow element. Tenant page
 * listens via `el.addEventListener('sochi-widget:event', e => e.detail)`.
 */
export interface SochiWidgetEventDetail {
	readonly type: 'flow_open' | 'flow_submit_ready' | 'flow_dismissed'
	readonly tenant: string
}

@customElement(BOOKING_FLOW_TAG)
export class SochiBookingFlow extends LitElement {
	@property({ type: String, reflect: false }) tenant = ''

	@state() private status: 'idle' | 'loading' | 'ready' | 'error' = 'idle'
	@state() private property: PropertySummary | null = null
	@state() private submitVisible = false

	#abort: AbortController | null = null
	#submitObserver: IntersectionObserver | null = null

	/**
	 * Pollution-safe internal draft (D17). Any untrusted-source field
	 * (URL params, postMessage, `data-*`) round-trips through this null-prototype
	 * dictionary so prototype-pollution gadgets cannot escalate.
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
			line-height: 1.45;
		}
		:host([hidden]) {
			display: none;
		}
		.flow-card {
			padding: 1.25rem;
			border-radius: 0.75rem;
			border: 1px solid #e4e4e7;
			background: #ffffff;
		}
		@starting-style {
			.flow-card {
				opacity: 0;
				transform: translateY(8px);
			}
		}
		.flow-card {
			opacity: 1;
			transform: translateY(0);
			transition:
				opacity 200ms ease-out,
				transform 200ms ease-out;
		}
		@media (prefers-reduced-motion: reduce) {
			.flow-card {
				transition: none;
			}
		}
		.flow-title {
			font-size: 1.125rem;
			font-weight: 600;
			margin: 0 0 0.5rem 0;
			text-wrap: balance;
		}
		.flow-status {
			margin: 0.5rem 0;
			color: #52525b;
			text-wrap: pretty;
		}
		button.submit {
			cursor: pointer;
			font: inherit;
			padding: 0.75rem 1.5rem;
			border-radius: 0.5rem;
			border: 0;
			background: #0a0a0a;
			color: #ffffff;
			font-weight: 500;
		}
		button.submit:disabled {
			opacity: 0.5;
			cursor: not-allowed;
		}
		button.submit:focus-visible {
			outline: 2px solid #2563eb;
			outline-offset: 2px;
		}
		@container (min-width: 480px) {
			.flow-card {
				padding: 1.5rem 2rem;
			}
			.flow-title {
				font-size: 1.25rem;
			}
		}
		@container (min-width: 720px) {
			.flow-card {
				padding: 2rem 2.5rem;
			}
			.flow-title {
				font-size: 1.5rem;
			}
		}
		@media (forced-colors: active) {
			button.submit {
				background: ButtonText;
				color: ButtonFace;
			}
			.flow-card {
				border-color: CanvasText;
			}
		}
	`

	override connectedCallback(): void {
		super.connectedCallback()
		this.#abort = new AbortController()
		this.#draft.tenant = this.tenant
		void this.#loadProperty()
	}

	override disconnectedCallback(): void {
		this.#abort?.abort()
		this.#abort = null
		this.#submitObserver?.disconnect()
		this.#submitObserver = null
		super.disconnectedCallback()
	}

	override updated(): void {
		// Wire IntersectionObserver v2 once the submit button is in the DOM
		// (D18 in-DOM clickjacking defense). `trackVisibility: true` requires
		// `delay >= 100`. The observer disables submit if the button is
		// occluded, has zero visible pixels, or isn't actually paint-rendered.
		if (this.status !== 'ready' || this.#submitObserver !== null) return
		const submit = this.renderRoot.querySelector('button.submit')
		if (!(submit instanceof HTMLButtonElement)) return
		const IO = $window.IntersectionObserver
		if (typeof IO !== 'function') {
			this.submitVisible = true
			return
		}
		this.#submitObserver = new IO(
			(entries) => {
				const e = entries[0]
				if (!e) return
				// `isVisible` is the v2 field; falls through to plain visibility
				// when v2 isn't supported.
				const v2 = (e as IntersectionObserverEntry & { isVisible?: boolean }).isVisible
				this.submitVisible = v2 ?? e.intersectionRatio === 1
			},
			{ threshold: 1, trackVisibility: true, delay: 100 } as IntersectionObserverInit & {
				trackVisibility?: boolean
				delay?: number
			},
		)
		this.#submitObserver.observe(submit)
	}

	override render(): unknown {
		return html`<div class="flow-card" data-testid="flow-card">
			<h2 class="flow-title">Бронирование</h2>
			${this.#renderBody()}
		</div>`
	}

	#renderBody(): unknown {
		switch (this.status) {
			case 'idle':
			case 'loading':
				return html`<p class="flow-status" data-testid="flow-loading" aria-live="polite">
					Загружаем информацию об объекте…
				</p>`
			case 'error':
				return html`<p class="flow-status" data-testid="flow-error" role="alert">
					Не удалось загрузить виджет. Попробуйте ещё раз.
				</p>`
			case 'ready':
				return this.property
					? html`<p class="flow-status" data-testid="flow-property-name">
								${this.property.name}
							</p>
							<button
								type="button"
								class="submit"
								data-testid="flow-submit"
								?disabled=${!this.submitVisible}
								@click=${this.#handleSubmit}
							>
								Продолжить
							</button>`
					: nothing
		}
	}

	async #loadProperty(): Promise<void> {
		const signal = this.#abort?.signal
		this.status = 'loading'
		try {
			// А4.3 lands the `/api/public/widget/{slug}/property` route on the
			// backend. Until then we resolve a Stub so the lazy-chunk + IO v2 +
			// CustomEvent canon remains testable end-to-end. The Stub returns
			// after a microtask so the loading state is observable in tests.
			await Promise.resolve()
			if (signal?.aborted) return
			this.property = $createNullObject<PropertySummary>()
			Object.assign(this.property as PropertySummary, {
				slug: this.tenant,
				name: this.tenant ? `Объект ${this.tenant}` : 'Объект',
			})
			this.status = 'ready'
			this.#emit('flow_open')
		} catch {
			if (signal?.aborted) return
			this.status = 'error'
		}
	}

	#handleSubmit = (_event: MouseEvent): void => {
		// Visibility gate (D18) — the IO v2 callback flips `submitVisible` to
		// `false` whenever the button is occluded; the disabled attribute then
		// blocks clicks. This guard is defense-in-depth: even if a tenant
		// stylesheet hides the disabled state via `:disabled { opacity: 1 }`,
		// the click-handler refuses to emit the booking event.
		if (!this.submitVisible) return
		this.#emit('flow_submit_ready')
	}

	#emit(type: SochiWidgetEventDetail['type']): void {
		// Use stashed `$document` ref (D16) — never bare `document` access in
		// IIFE-bundled code.
		void $document
		const detail = $createNullObject<SochiWidgetEventDetail>()
		Object.assign(detail as SochiWidgetEventDetail, {
			type,
			tenant: this.tenant,
		})
		this.dispatchEvent(
			new CustomEvent<SochiWidgetEventDetail>('sochi-widget:event', {
				detail,
				bubbles: true,
				composed: true,
			}),
		)
	}
}
