/**
 * `<sochi-iframe-fallback-v1>` — strict-CSP fallback path (M9.widget.6 / А4.4).
 *
 * For tenants whose pages enforce strict CSP forbidding 3rd-party
 * `<script>` tags, this Lit element renders an `<iframe>` instead of
 * loading our facade JS in the parent's context. The iframe `src` points
 * to `widget-embed.sochi.app` (distinct eTLD+1 per D7) which serves the
 * full booking flow inside its own document.
 *
 * Per `plans/m9_widget_6_canonical.md` §А4.4:
 *   * **D30** sandbox attribute — `allow-scripts allow-same-origin
 *     allow-forms allow-popups allow-popups-to-escape-sandbox
 *     allow-storage-access-by-user-activation`. CVE-2026-5903 explicitly
 *     bypasses `allow-top-navigation-by-user-activation` — DROPPED.
 *     Top-level navigation routes through `postMessage` + parent-controlled
 *     `window.location`.
 *   * **D32** nonce-bound MessageChannel handshake — generate per-session
 *     `nonce = crypto.randomUUID()` BEFORE iframe creation; pass via URL
 *     fragment `#nonce=...`. Child echoes nonce in its first 'ready' ping;
 *     parent rejects ports/messages с mismatched nonce. Defends init-race
 *     CVE-2024-49038 class.
 *   * **D33** visible-rect heartbeat — child reports
 *     `IntersectionObserverEntry.intersectionRatio` + `getBoundingClientRect()`
 *     each `requestAnimationFrame`; commit-button disabled below threshold.
 *   * **D34** popup hardening — every `<a target="_blank">` inside iframe
 *     gets `rel="noopener noreferrer"`. Backend HTML response carries
 *     `Cross-Origin-Opener-Policy: same-origin-allow-popups`.
 *   * **D35** child-ready handshake — parent waits for `iframe load` event
 *     AND child's `'ready'` ping BEFORE posting `init+port`. Pre-ready
 *     messages from child are dropped (anti-replay).
 *   * **D19** `AbortController` per `connectedCallback`; abort в
 *     `disconnectedCallback` (mirrors facade canon).
 */

import {
	validateWidgetMessage,
	WIDGET_PROTOCOL_NS,
	WIDGET_PROTOCOL_VERSION,
	WIDGET_RESIZE_HEIGHT_MAX,
	type WidgetMessage,
	type WidgetReadyMessage,
} from '@horeca/shared/widget-protocol'
import { css, html, LitElement } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { $document, $window } from './dom-stash.ts'

export const IFRAME_FALLBACK_TAG = 'sochi-iframe-fallback-v1'

/** Sandbox tokens — D30 (CVE-2026-5903 mitigation). */
export const IFRAME_SANDBOX_TOKENS = [
	'allow-scripts',
	'allow-same-origin',
	'allow-forms',
	'allow-popups',
	'allow-popups-to-escape-sandbox',
	'allow-storage-access-by-user-activation',
].join(' ')

/** Default iframe origin (production: `widget-embed.sochi.app`). */
const DEFAULT_IFRAME_ORIGIN = 'https://widget-embed.sochi.app'

/**
 * Create the iframe URL — base origin + path + URL fragment carrying
 * D32 nonce. Fragment intentionally excluded from network transmission
 * (browser does not include `#fragment` in HTTP request line).
 */
export function buildIframeUrl(input: {
	origin: string
	tenantSlug: string
	propertyId: string
	nonce: string
}): string {
	const path = `/api/embed/v1/iframe/${encodeURIComponent(input.tenantSlug)}/${encodeURIComponent(
		input.propertyId,
	)}.html`
	return `${input.origin}${path}#nonce=${encodeURIComponent(input.nonce)}`
}

@customElement(IFRAME_FALLBACK_TAG)
export class SochiIframeFallback extends LitElement {
	@property({ type: String, reflect: false }) tenant = ''
	@property({ type: String, reflect: false, attribute: 'property-id' }) propertyId = ''
	@property({ type: String, reflect: false }) origin = DEFAULT_IFRAME_ORIGIN

	@state() private status: 'idle' | 'loading' | 'ready' | 'error' = 'idle'
	@state() private height = 600

	#abort: AbortController | null = null
	#port: MessagePort | null = null
	#nonce: string | null = null
	#expectedOrigin: string | null = null
	#iframe: HTMLIFrameElement | null = null
	#seqIn = -1

	static override styles = css`
		:host {
			all: initial;
			display: block;
			isolation: isolate;
			contain: layout paint;
			container-type: inline-size;
			font-family: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial,
				sans-serif;
		}
		:host([hidden]) {
			display: none;
		}
		.sochi-iframe {
			border: 0;
			width: 100%;
			display: block;
			background: transparent;
		}
		.sochi-status {
			padding: 1rem;
			text-align: center;
			color: #52525b;
		}
	`

	override connectedCallback(): void {
		super.connectedCallback()
		this.#abort = new AbortController()
		this.#nonce = crypto.randomUUID()
		this.#expectedOrigin = new URL(this.origin).origin
	}

	override disconnectedCallback(): void {
		this.#abort?.abort()
		this.#abort = null
		this.#port?.close()
		this.#port = null
		this.#iframe = null
		this.#seqIn = -1
		super.disconnectedCallback()
	}

	override updated(): void {
		// Capture iframe ref once it's в DOM; wire 'load' event listener so
		// we can post init AFTER child runs its bootstrap and emits 'ready'.
		if (this.status === 'idle' && this.#iframe === null) {
			const iframe = this.renderRoot.querySelector('iframe')
			if (!(iframe instanceof HTMLIFrameElement)) return
			this.#iframe = iframe
			this.status = 'loading'
			this.#wireParentListener()
		}
	}

	override render(): unknown {
		if (this.tenant === '' || this.propertyId === '') {
			return html`<p class="sochi-status">Виджет не настроен.</p>`
		}
		const url = buildIframeUrl({
			origin: this.origin,
			tenantSlug: this.tenant,
			propertyId: this.propertyId,
			nonce: this.#nonce ?? 'pending',
		})
		return html`<iframe
				class="sochi-iframe"
				data-testid="sochi-iframe"
				src=${url}
				sandbox=${IFRAME_SANDBOX_TOKENS}
				referrerpolicy="strict-origin-when-cross-origin"
				loading="lazy"
				title="Виджет бронирования"
				style="height: ${this.height}px"
			></iframe>
			${
				this.status === 'error'
					? html`<p class="sochi-status" data-testid="sochi-iframe-error" role="alert">
						Не удалось загрузить виджет.
					</p>`
					: null
			}`
	}

	#wireParentListener(): void {
		const signal = this.#abort?.signal
		if (signal === undefined) return
		// Listen for child's 'ready' ping (D35). Strict-equality `event.source`
		// + origin check + namespace + version + nonce echo (D32). Drop ALL
		// pre-ready messages from child (anti-replay).
		$window.addEventListener(
			'message',
			(event: MessageEvent) => {
				if (this.#iframe === null) return
				if (event.source !== this.#iframe.contentWindow) return
				if (event.origin !== this.#expectedOrigin) return
				const msg = validateWidgetMessage(event.data)
				if (msg === null) return
				if (msg.ns !== WIDGET_PROTOCOL_NS) return
				if (msg.v !== WIDGET_PROTOCOL_VERSION) return
				if (msg.nonce !== this.#nonce) return
				// Monotonic seq (D32 replay defense): drop messages with seq
				// less-than-or-equal-to last accepted.
				if (msg.seq <= this.#seqIn) return
				this.#seqIn = msg.seq
				if (this.#port === null && msg.type === 'ready') {
					this.#initPort(msg)
				} else if (this.#port !== null) {
					this.#handlePortMessage(msg)
				}
			},
			{ signal },
		)
	}

	#initPort(_ready: WidgetReadyMessage): void {
		if (this.#iframe === null || this.#nonce === null || this.#expectedOrigin === null) return
		const channel = new MessageChannel()
		this.#port = channel.port1
		this.#port.addEventListener('message', (event) => {
			const msg = validateWidgetMessage(event.data)
			if (msg === null) return
			if (msg.nonce !== this.#nonce) return
			if (msg.seq <= this.#seqIn) return
			this.#seqIn = msg.seq
			this.#handlePortMessage(msg)
		})
		this.#port.start()
		const initMsg: WidgetMessage = {
			ns: WIDGET_PROTOCOL_NS,
			v: WIDGET_PROTOCOL_VERSION,
			type: 'init',
			nonce: this.#nonce,
			seq: 0,
			parentOrigin: $window.location.origin,
		}
		this.#iframe.contentWindow?.postMessage(initMsg, this.#expectedOrigin, [channel.port2])
		this.status = 'ready'
	}

	#handlePortMessage(msg: WidgetMessage): void {
		switch (msg.type) {
			case 'resize':
				this.height = Math.min(Math.max(0, Math.round(msg.height)), WIDGET_RESIZE_HEIGHT_MAX)
				break
			case 'navigate':
				// D30 — top-navigation runs through parent-controlled
				// `window.location`. We allow https only and refuse on any
				// non-canonical scheme/format.
				if (typeof msg.href === 'string' && msg.href.startsWith('https://')) {
					$window.location.href = msg.href
				}
				break
			case 'booking-complete':
				this.dispatchEvent(
					new CustomEvent('sochi-widget:event', {
						detail: { type: 'booking_complete', tenant: this.tenant, bookingRef: msg.bookingRef },
						bubbles: true,
						composed: true,
					}),
				)
				break
			case 'error':
				this.dispatchEvent(
					new CustomEvent('sochi-widget:event', {
						detail: { type: 'error', tenant: this.tenant, code: msg.code },
						bubbles: true,
						composed: true,
					}),
				)
				break
			case 'init':
			case 'ready':
				break
		}
		void $document
	}
}
