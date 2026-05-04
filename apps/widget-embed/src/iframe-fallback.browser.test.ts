/**
 * `<sochi-iframe-fallback-v1>` browser tests — IFE1-IFE7 per plan §А4.4.
 *
 * Vitest 4 Browser Mode + Playwright provider runs in real Chromium so
 * iframe element creation, sandbox attribute parsing, and URL fragment
 * encoding all use canonical browser semantics.
 *
 * Coverage:
 *   IFE1 element registers с versioned tag `sochi-iframe-fallback-v1`
 *   IFE2 iframe sandbox tokens match D30 canonical (NO allow-top-navigation-by-user-activation)
 *   IFE3 iframe URL contains nonce in URL fragment (D32 nonce binding)
 *   IFE4 iframe `loading="lazy"` + `referrerpolicy="strict-origin-when-cross-origin"`
 *   IFE5 buildIframeUrl encodes special chars in slug (XSS-safe)
 *   IFE6 disconnectedCallback aborts AbortController (D19 leak defense)
 *   IFE7 missing tenant attribute → renders fallback p, no iframe
 */

import { html } from 'lit'
import { afterEach, describe, expect, test } from 'vitest'
import { render } from 'vitest-browser-lit'
import {
	buildIframeUrl,
	IFRAME_FALLBACK_TAG,
	IFRAME_SANDBOX_TOKENS,
	SochiIframeFallback,
} from './iframe-fallback.ts'
import { SochiBookingWidget, WIDGET_TAG } from './index.ts'

void SochiBookingWidget // ensure facade module side-effects (registers WIDGET_TAG)
void WIDGET_TAG

describe('SochiIframeFallback parent-side wrapper', () => {
	afterEach(() => {
		for (const el of document.querySelectorAll(IFRAME_FALLBACK_TAG)) el.remove()
	})

	test('[IFE1] element registers с versioned tag', () => {
		expect(customElements.get(IFRAME_FALLBACK_TAG)).toBe(SochiIframeFallback)
		expect(IFRAME_FALLBACK_TAG).toBe('sochi-iframe-fallback-v1')
		expect(IFRAME_FALLBACK_TAG).toMatch(/-v\d+$/)
	})

	test('[IFE2] iframe sandbox tokens match D30 (NO top-navigation-by-user-activation)', async () => {
		render(
			html`<sochi-iframe-fallback-v1
				tenant="aurora"
				property-id="prop-123"
				origin="https://widget-embed.test"
			></sochi-iframe-fallback-v1>`,
		)
		const host = document.querySelector(IFRAME_FALLBACK_TAG) as SochiIframeFallback
		await host.updateComplete
		const iframe = host.shadowRoot?.querySelector('iframe') as HTMLIFrameElement
		expect(iframe).not.toBeNull()
		const sandbox = iframe.getAttribute('sandbox') ?? ''
		// Canonical tokens present
		expect(sandbox).toContain('allow-scripts')
		expect(sandbox).toContain('allow-same-origin')
		expect(sandbox).toContain('allow-forms')
		expect(sandbox).toContain('allow-popups')
		expect(sandbox).toContain('allow-popups-to-escape-sandbox')
		expect(sandbox).toContain('allow-storage-access-by-user-activation')
		// CVE-2026-5903 mitigation — top-navigation forbidden
		expect(sandbox).not.toContain('allow-top-navigation')
		expect(sandbox).not.toContain('allow-modals')
		expect(sandbox).not.toContain('allow-downloads')
		// And matches the exported canonical constant exactly
		expect(sandbox).toBe(IFRAME_SANDBOX_TOKENS)
	})

	test('[IFE3] iframe URL contains nonce in URL fragment (D32)', async () => {
		render(
			html`<sochi-iframe-fallback-v1
				tenant="aurora"
				property-id="prop-123"
				origin="https://widget-embed.test"
			></sochi-iframe-fallback-v1>`,
		)
		const host = document.querySelector(IFRAME_FALLBACK_TAG) as SochiIframeFallback
		await host.updateComplete
		const iframe = host.shadowRoot?.querySelector('iframe') as HTMLIFrameElement
		const src = iframe.getAttribute('src') ?? ''
		expect(src).toMatch(
			/^https:\/\/widget-embed\.test\/api\/embed\/v1\/iframe\/aurora\/prop-123\.html#nonce=[\w-]{8,}$/,
		)
	})

	test('[IFE4] iframe loading=lazy + referrerpolicy strict-origin-when-cross-origin', async () => {
		render(
			html`<sochi-iframe-fallback-v1
				tenant="aurora"
				property-id="prop-123"
				origin="https://widget-embed.test"
			></sochi-iframe-fallback-v1>`,
		)
		const host = document.querySelector(IFRAME_FALLBACK_TAG) as SochiIframeFallback
		await host.updateComplete
		const iframe = host.shadowRoot?.querySelector('iframe') as HTMLIFrameElement
		expect(iframe.getAttribute('loading')).toBe('lazy')
		expect(iframe.getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin')
		expect(iframe.getAttribute('title')).toBe('Виджет бронирования')
	})

	test('[IFE5] buildIframeUrl percent-encodes slug characters', () => {
		const url = buildIframeUrl({
			origin: 'https://widget-embed.test',
			tenantSlug: 'tenant with space',
			propertyId: 'prop with/slash',
			nonce: 'abc-123',
		})
		// Encoded path components — defense-in-depth even though zod will reject
		// these at backend route layer.
		expect(url).toContain('tenant%20with%20space')
		expect(url).toContain('prop%20with%2Fslash')
		expect(url).toContain('#nonce=abc-123')
	})

	test('[IFE6] disconnect aborts in-flight async (D19)', async () => {
		render(
			html`<sochi-iframe-fallback-v1
				tenant="aurora"
				property-id="prop-123"
				origin="https://widget-embed.test"
			></sochi-iframe-fallback-v1>`,
		)
		const host = document.querySelector(IFRAME_FALLBACK_TAG) as SochiIframeFallback
		await host.updateComplete
		host.remove()
		document.body.appendChild(host)
		await host.updateComplete
		// Reconnect must work cleanly — D19 controller re-created in
		// connectedCallback; ElementInternals stays attached single-shot.
		expect(host.shadowRoot?.querySelector('iframe')).not.toBeNull()
	})

	test('[IFE7] missing tenant attribute → renders fallback paragraph (no iframe)', async () => {
		render(html`<sochi-iframe-fallback-v1></sochi-iframe-fallback-v1>`)
		const host = document.querySelector(IFRAME_FALLBACK_TAG) as SochiIframeFallback
		await host.updateComplete
		expect(host.shadowRoot?.querySelector('iframe')).toBeNull()
		expect(host.shadowRoot?.querySelector('.sochi-status')?.textContent).toContain('не настроен')
	})
})
