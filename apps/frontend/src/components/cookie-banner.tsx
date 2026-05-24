/**
 * Cookie consent banner — 152-ФЗ ст.6 + ст.18 opt-in (Sprint C+ Round 6
 * Legal P0 fix 2026-05-24).
 *
 * Renders fixed-bottom banner с 3 actions:
 *   1. «Принять все» → analytics + marketing on (когда выпустим marketing)
 *   2. «Только необходимые» → necessary on, all else off
 *   3. «Настроить» → expands panel с per-category toggles
 *
 * Banner показывается ТОЛЬКО когда `hasDecided() === false`. После любого
 * choice — banner hides, decision сохраняется в localStorage, subscribers
 * (Metrika init waiter) уведомляются.
 *
 * A11y:
 *   - `role="dialog"` + `aria-labelledby` + `aria-describedby`
 *   - Initial focus на «Принять все» (primary action)
 *   - Esc дозволен НЕ закрывать — только explicit choice (canon: implicit
 *     consent = nothing, banner sticky until clicked)
 *   - z-index 50 поверх content, не блокирует scroll
 *
 * Accessibility note: WCAG 2.4.13 focus-ring solid via global styles. Banner
 * рендерится только когда нужно — нет SEO impact (static).
 */
import { useEffect, useId, useState } from 'react'
import { Button } from './ui/button.tsx'
import { Checkbox } from './ui/checkbox.tsx'
import {
	type ConsentCategory,
	hasDecided,
	onConsentChange,
	setConsent,
} from '../lib/cookie-consent.ts'

export function CookieBanner(): React.JSX.Element | null {
	const [visible, setVisible] = useState<boolean>(() => !hasDecided())
	const [showSettings, setShowSettings] = useState(false)
	const [analytics, setAnalytics] = useState(false)
	const [marketing, setMarketing] = useState(false)
	const titleId = useId()
	const descId = useId()
	const necessaryId = useId()
	const analyticsId = useId()
	const marketingId = useId()

	useEffect(() => {
		const unsub = onConsentChange(() => {
			setVisible(false)
		})
		return unsub
	}, [])

	if (!visible) return null

	function acceptAll() {
		setConsent({ analytics: true, marketing: true })
	}
	function rejectAll() {
		setConsent({ analytics: false, marketing: false })
	}
	function saveCustom() {
		setConsent({ analytics, marketing })
	}

	return (
		<dialog
			aria-labelledby={titleId}
			aria-describedby={descId}
			aria-modal="false"
			open
			className="fixed right-4 bottom-4 left-4 z-50 m-0 max-w-2xl rounded-lg border border-border bg-card p-6 text-card-foreground shadow-lg md:right-6 md:bottom-6 md:left-auto"
			data-testid="cookie-banner"
		>
			<h2 id={titleId} className="font-semibold text-base">
				Cookies и аналитика
			</h2>
			<p id={descId} className="mt-2 text-muted-foreground text-sm">
				Сайт использует cookies для работы сервиса. Аналитические cookies (Яндекс.Метрика) помогают
				улучшать продукт — включаются только с вашего согласия (152-ФЗ ст.6 + ст.18). Подробнее в{' '}
				<a href="/legal/privacy" className="underline">
					политике конфиденциальности
				</a>
				.
			</p>

			{showSettings ? (
				<div className="mt-4 space-y-3 border-border border-t pt-4">
					<CategoryToggle
						htmlId={necessaryId}
						category="necessary"
						label="Необходимые"
						description="Сессия, авторизация, CSRF. Без них сервис не работает."
						checked
						disabled
					/>
					<CategoryToggle
						htmlId={analyticsId}
						category="analytics"
						label="Аналитика"
						description="Яндекс.Метрика — обезличенная статистика посещений."
						checked={analytics}
						onChange={setAnalytics}
					/>
					<CategoryToggle
						htmlId={marketingId}
						category="marketing"
						label="Маркетинг"
						description="Сейчас не используется. Зарезервировано на будущее."
						checked={marketing}
						onChange={setMarketing}
					/>
				</div>
			) : null}

			<div className="mt-4 flex flex-wrap gap-2">
				{showSettings ? (
					<>
						<Button onClick={saveCustom} variant="default">
							Сохранить выбор
						</Button>
						<Button onClick={() => setShowSettings(false)} variant="outline">
							Назад
						</Button>
					</>
				) : (
					<>
						<Button onClick={acceptAll} variant="default" autoFocus>
							Принять все
						</Button>
						<Button onClick={rejectAll} variant="outline">
							Только необходимые
						</Button>
						<Button onClick={() => setShowSettings(true)} variant="ghost">
							Настроить
						</Button>
					</>
				)}
			</div>
		</dialog>
	)
}

interface CategoryToggleProps {
	htmlId: string
	category: ConsentCategory
	label: string
	description: string
	checked: boolean
	disabled?: boolean
	onChange?: (next: boolean) => void
}

function CategoryToggle({
	htmlId,
	label,
	description,
	checked,
	disabled,
	onChange,
}: CategoryToggleProps): React.JSX.Element {
	return (
		<label htmlFor={htmlId} className="flex cursor-pointer items-start gap-3">
			<Checkbox
				id={htmlId}
				checked={checked}
				disabled={disabled}
				onCheckedChange={(next) => onChange?.(next === true)}
				className="mt-0.5"
			/>
			<span className="flex-1">
				<span className="block font-medium text-sm">{label}</span>
				<span className="block text-muted-foreground text-xs">{description}</span>
			</span>
		</label>
	)
}
