/**
 * Demo tour step configuration — M9.widget.8 / A6.2 / D9-D11.
 *
 * Per `plans/m9_widget_8_canonical.md` D10: «strings ONLY из i18n catalog —
 * tenant-controlled inputs BANNED в tour DOM». All step copy lives here as
 * static constants (Cyrillic literal). Future-Lingui-migration adds keys
 * без change to logic.
 *
 * **Selector contract:** each step `targetSelector` MUST exist in the DOM
 * when the corresponding step activates. Use `data-testid` — stable + не
 * Tailwind-coupled. Tour `next()` skips the step if selector misses (defensive).
 */

import type { Placement } from '@floating-ui/dom'

export interface DemoTourStep {
	readonly id: string
	/** CSS selector resolving to a single highlight target. */
	readonly targetSelector: string
	/** Title — Cyrillic literal (Lingui carry-forward). */
	readonly title: string
	/** Description — Cyrillic literal. */
	readonly description: string
	/** Floating-ui placement preference. */
	readonly placement: Placement
}

/**
 * Canonical 4-step tour. Steps anchor to widget-page surfaces:
 *   1. demo banner — sets context («это живая витрина»)
 *   2. properties section — directs к property card
 *   3. property card CTA — explains booking flow
 *   4. footer / refresh hint — explains daily 03:00 MSK refresh
 */
export const DEMO_TOUR_STEPS: ReadonlyArray<DemoTourStep> = [
	{
		id: 'welcome',
		targetSelector: '[data-testid="demo-banner"]',
		title: 'Добро пожаловать!',
		description:
			'Это живая витрина продукта. Бронирования и данные настоящие, но всё в demo-режиме — попробуйте полный цикл без рисков.',
		placement: 'bottom-start',
	},
	{
		id: 'properties',
		targetSelector: '[data-testid="properties-count"]',
		title: 'Реальные объекты',
		description:
			'Посмотрите номера, тарифы и доступность. 24 номера в Сириусе с реальными ценами и фотографиями.',
		placement: 'bottom',
	},
	{
		id: 'booking-flow',
		targetSelector: 'a[href*="/widget/"], [data-testid^="property-card"]',
		title: 'Полный цикл бронирования',
		description:
			'Кликните по объекту чтобы пройти все 4 шага: даты → номер → услуги → оплата. Используется тот же код, что и в production.',
		placement: 'top',
	},
	{
		id: 'refresh',
		targetSelector: '[data-testid="demo-banner"]',
		title: 'Свежие данные ежедневно',
		description:
			'Демо-сценарий обновляется в 03:00 МСК — бронирования сдвигаются вперёд, чтобы витрина всегда выглядела актуально.',
		placement: 'top',
	},
] as const
