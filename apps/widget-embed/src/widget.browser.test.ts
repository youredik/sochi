/**
 * Smoke component test — A4.1.fix scaffold marker.
 *
 * Real W1-W10 strict component tests land в А4.2 per plan §9. This file
 * just exercises Vitest Browser Mode + Playwright provider + `vitest-browser-lit`
 * so the toolchain is wired (BLD-FX1..3 build asserts cover the security
 * hardening; W-prefix tests cover Shadow DOM behaviour from real browser
 * context).
 */

import { html } from 'lit'
import { expect, test } from 'vitest'
import { render } from 'vitest-browser-lit'
import { WIDGET_TAG } from './index.ts'

test('[W0] widget element registers with versioned tag', async () => {
	const screen = render(html`<sochi-booking-widget-v1 tenant="sirius"></sochi-booking-widget-v1>`)
	const cta = screen.getByTestId('widget-cta')
	await expect.element(cta).toBeInTheDocument()
	await expect.element(cta).toHaveTextContent('Забронировать')
	expect(customElements.get(WIDGET_TAG)).toBeDefined()
})
