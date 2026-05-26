/**
 * Round 9 — central brand-safe disclaimer banner for demo OTA pages.
 *
 * Canon: `feedback_round_9_demo_ota_server_canon_2026_05_25.md`.
 *
 * **MUST be present on every page** в `/demo/ota/*` route tree. Playwright
 * E2E ассертит наличие через `data-testid="demo-disclaimer-banner"`. Canon
 * mandates trademark-safe positioning:
 *   - Sticky top: «[ДЕМО] Демонстрация Sepshn — не настоящий [Yandex.Путешествия|Островок]»
 *   - Optional footer disclaimer slot (passed via `footerNote` prop)
 *
 * Round 12 polish (canon `feedback_no_emoji.md` + factual ИНН fix):
 *   - Pill chip «[ДЕМО]» replaces emoji `🧪` (canon: 0 emojis default).
 *   - Trademark disclaimer drops ИНН (`7704735704` was incorrectly bound to
 *     `ООО „Яндекс.Путешествия"` — that ИНН belongs to `ООО „ЯНДЕКС.ТАКСИ"`).
 *     Neutral phrasing «ООО „Яндекс" и аффилированные лица» avoids factual error.
 *     Ostrovok: `Emerging Travel Group OÜ` (Estonian OÜ form) → `Emerging Travel
 *     Group` без legal-form (group is multi-jurisdiction; OÜ is one of several).
 *
 * Brand parameter accepts only known channels — TypeScript-enforced const-union
 * so мы не можем случайно показать «не настоящий Booking.com» в Yandex flow.
 */

import type { ReactNode } from 'react'

export type DemoOtaBrand = 'yandex' | 'ostrovok'

const BRAND_LABELS: Record<DemoOtaBrand, string> = {
	yandex: 'Yandex.Путешествия',
	ostrovok: 'Островок',
}

/**
 * Round 12 fix — neutral trademark phrasing. Drops ИНН (factual error) and
 * legal form (OÜ vs plc / Раша — multi-jurisdiction group). Honors trademark
 * acknowledgement without claiming specific corporate-registry facts that may
 * be wrong or change.
 */
const BRAND_LEGAL: Record<DemoOtaBrand, string> = {
	yandex: 'ООО „Яндекс" и аффилированные лица',
	ostrovok: 'Emerging Travel Group и аффилированные лица',
}

export interface DemoDisclaimerBannerProps {
	readonly brand: DemoOtaBrand
	readonly footerNote?: ReactNode
}

export function DemoDisclaimerBanner({ brand, footerNote }: DemoDisclaimerBannerProps): ReactNode {
	const label = BRAND_LABELS[brand]
	const legal = BRAND_LEGAL[brand]
	return (
		<>
			<div
				data-testid="demo-disclaimer-banner"
				className="sticky top-0 z-50 w-full border-b border-amber-300/60 bg-amber-100/95 px-4 py-2 text-center text-sm font-medium text-amber-900 shadow-sm backdrop-blur"
				role="status"
				aria-label="Демонстрационный режим"
			>
				<span className="mr-2 inline-block rounded bg-amber-300/80 px-1.5 py-0.5 text-xs font-bold uppercase tracking-wide text-amber-950">
					Демо
				</span>
				<strong>Демонстрация Sepshn</strong> — это не настоящий {label}. Все данные — тестовые,
				бронирования не имеют юридической силы.
			</div>
			{footerNote !== undefined && (
				<footer
					data-testid="demo-disclaimer-footer"
					className="mt-12 border-t border-neutral-200 bg-neutral-50 px-4 py-6 text-center text-xs text-neutral-500"
				>
					<p>{footerNote}</p>
					<p className="mt-2">
						Этот интерфейс — учебная демонстрация программного обеспечения Sepshn для отельеров. Не
						аффилирован с {legal}. Все названия, логотипы и торговые знаки — собственность
						соответствующих правообладателей.
					</p>
				</footer>
			)}
		</>
	)
}
