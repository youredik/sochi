/**
 * Embed bundle entry point — `<sochi-booking-widget-v1>` registration.
 *
 * Per `plans/m9_widget_6_canonical.md` §D4 (defensive registration):
 *   - Versioned tag name `sochi-booking-widget-v1` lets us ship v2 side-by-side
 *     when the API surface changes (no auto-upgrade trap).
 *   - `customElements.get(name)` guard prevents `DOMException` collision when
 *     the bundle is accidentally double-loaded (tenant pastes embed twice,
 *     GTM/Yandex.Metrica tag manager re-injects, hot navigation, etc.).
 *
 * А4.1 scope: scaffold only. Actual widget logic lands in А4.2.
 */

import { SochiBookingWidget, WIDGET_TAG } from './widget.ts'

if (!customElements.get(WIDGET_TAG)) {
	customElements.define(WIDGET_TAG, SochiBookingWidget)
}

export { SochiBookingWidget, WIDGET_TAG }
