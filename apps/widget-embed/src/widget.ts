/**
 * `<sochi-booking-widget-v1>` Lit element shell (A4.1 scaffold).
 *
 * Per `plans/m9_widget_6_canonical.md`:
 *   - §D5 — `:host { all: initial; display: block; }` defends against parent
 *     cascade (font-family, color, line-height) and Tailwind v4 preflight `*`
 *     reset that pierces shadow boundary (GH lit/lit#18628).
 *   - §D4 — versioned tag `sochi-booking-widget-v1` (registered in `index.ts`).
 *   - §D6 — NO `<slot>` exposure; A4.2 will render API-fetched content into
 *     trusted Shadow DOM templates (no light children).
 *
 * `static properties` + `declare` pattern — canonical Lit 3 idiom under
 * TS `useDefineForClassFields: true` (ES2022 default). `declare` tells TS
 * the property is installed at runtime by Lit's accessor descriptor and
 * is NOT a class field that would shadow it.
 */

import { css, html, LitElement } from 'lit'

export const WIDGET_TAG = 'sochi-booking-widget-v1'

export class SochiBookingWidget extends LitElement {
	static override properties = {
		tenant: { type: String, reflect: false },
	}

	static override styles = css`
		:host {
			all: initial;
			display: block;
			font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
			color: #0a0a0a;
			line-height: 1.4;
		}
		:host([hidden]) {
			display: none;
		}
	`

	declare tenant: string

	constructor() {
		super()
		this.tenant = ''
	}

	override render(): unknown {
		return html`<div data-testid="widget-shell">
			<p>Загружаем виджет бронирования…</p>
		</div>`
	}
}
