/**
 * Минимальный 1-экранный «credibility surface» под discovery-first pivot
 * (см. plans/customer-discovery-plan.md §10).
 *
 * Назначение: люди которые получили outreach-сообщение от founder'а в
 * WhatsApp/Telegram и зашли на sepshn.ru проверить «что это вообще такое».
 * НЕ acquisition channel — не воронка. Один экран, контакт-кнопки, footer.
 *
 * НЕ добавлять без явного customer-research сигнала: pricing-таблицу,
 * сравнение с конкурентами (38-ФЗ риск), live-калькулятор, multi-section,
 * скриншоты demo, видео. Lock per plan §S1-S12 DEFERRED.
 *
 * Analytics: CTA-кнопки fire Y.Metrika goal'ы ('tg_click', 'email_click').
 * `trackLinks: true` auto-tracking покрывает только outbound HTTP(S) —
 * mailto: не входит, поэтому explicit reachGoal обязателен.
 */

import { reachGoal } from '../../lib/yandex-metrika.ts'

const TG_URL = import.meta.env.VITE_CONTACT_TG_URL ?? 'https://t.me/sepshn'
const EMAIL = import.meta.env.VITE_CONTACT_EMAIL ?? 'hi@sepshn.ru'

export function LandingPage() {
	return (
		<main className="flex min-h-svh flex-col">
			<header className="mx-auto flex w-full max-w-2xl items-center justify-between px-6 pt-6">
				<span className="text-2xl font-semibold tracking-tight">Сэпшн</span>
				<a
					href="/login"
					onClick={() => reachGoal('login_click')}
					className="text-muted-foreground hover:text-foreground text-sm transition"
				>
					Войти →
				</a>
			</header>
			<div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center px-6 py-16">
				<h1 className="text-3xl font-semibold leading-tight tracking-tight md:text-4xl">
					Программа для управления гостевым домом или мини-отелем.
				</h1>

				<p className="mt-4 text-base text-muted-foreground md:text-lg">Сделано в Сочи.</p>

				<p className="mt-16 text-base">Свяжитесь любым удобным способом:</p>

				<div className="mt-4 flex flex-wrap gap-3">
					<a
						href={TG_URL}
						target="_blank"
						rel="noopener noreferrer"
						onClick={() => reachGoal('tg_click')}
						className="bg-primary text-primary-foreground inline-flex h-11 items-center justify-center rounded-lg px-6 text-base font-medium transition hover:opacity-90"
					>
						Telegram
					</a>
					<a
						href={`mailto:${EMAIL}`}
						onClick={() => reachGoal('email_click')}
						className="border-border inline-flex h-11 items-center justify-center rounded-lg border px-6 text-base font-medium transition hover:bg-muted"
					>
						Email
					</a>
				</div>
			</div>

			<footer className="border-border text-muted-foreground border-t px-6 py-6 text-center text-sm">
				© 2026 Сэпшн · {EMAIL}
			</footer>
		</main>
	)
}
