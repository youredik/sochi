/**
 * Round 12 (R12V-6 Preview MCP find) — `/demo` index landing page.
 *
 * Previously `/demo` route rendered only an `<Outlet />` (whitespace) since
 * Round 9 — but success pages of both Yandex + Ostrovok demos send users
 * BACK to `/demo` via `RETURN_TO_PMS_URL = '/demo'`. Users would click
 * «Вернуться к демо PMS» and land on a blank page. Fix: tile-based landing
 * с links to the three demo flows + showcase.
 *
 * Trademark-safe — uses generic «гостевой дом» phrasing + DemoDisclaimerBanner
 * mounted on each child route. No real brand logos on this landing.
 */
import { createFileRoute, Link } from '@tanstack/react-router'

export const Route = createFileRoute('/demo/')({
	component: DemoIndexPage,
})

const DEMO_TILES = [
	{
		to: '/demo/ota/yandex',
		title: 'Демо OTA (Yandex.Путешествия)',
		description: 'Гость ищет, бронирует — резервация падает в PMS через webhook (mock).',
		testId: 'demo-tile-yandex',
	},
	{
		to: '/demo/ota/ostrovok',
		title: 'Демо OTA (Островок)',
		description: 'Тот же поток, второй канал. ETG-style API: form → finish → cancel.',
		testId: 'demo-tile-ostrovok',
	},
	{
		to: '/demo/showcase',
		title: 'Side-by-Side showcase',
		description: 'OTA слева, шахматка PMS справа — наглядно для отельеров.',
		testId: 'demo-tile-showcase',
	},
] as const

function DemoIndexPage() {
	return (
		<div lang="ru" className="min-h-svh bg-neutral-50 text-neutral-900">
			<header className="border-b border-neutral-200 bg-white px-6 py-6 shadow-sm">
				<div className="mx-auto max-w-5xl">
					<h1 className="text-3xl font-bold tracking-tight" data-testid="demo-index-heading">
						Sepshn — демонстрация
					</h1>
					<p className="mt-2 text-sm text-neutral-700">
						Учебная демонстрация программного обеспечения Sepshn для отельеров. Все данные —
						тестовые, бронирования не имеют юридической силы.
					</p>
				</div>
			</header>
			<main className="mx-auto max-w-5xl px-6 py-10">
				<h2 className="text-xl font-semibold">Сценарии демонстрации</h2>
				<ul
					className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3"
					data-testid="demo-index-scenario-list"
				>
					{DEMO_TILES.map((tile) => (
						<li key={tile.testId}>
							<Link
								to={tile.to}
								data-testid={tile.testId}
								className="block h-full rounded-lg border border-neutral-200 bg-white p-5 shadow-sm transition-shadow hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
							>
								<h3 className="text-base font-semibold">{tile.title}</h3>
								<p className="mt-2 text-sm text-neutral-700">{tile.description}</p>
								<span className="mt-3 inline-block text-sm font-medium text-blue-700">
									Открыть демонстрацию →
								</span>
							</Link>
						</li>
					))}
				</ul>
				<footer className="mt-12 border-t border-neutral-200 pt-6 text-sm text-neutral-600">
					<p>
						Не аффилирован с ООО „Яндекс" и аффилированные лица или Emerging Travel Group и
						аффилированные лица. Все названия, логотипы и торговые знаки — собственность
						соответствующих правообладателей.
					</p>
				</footer>
			</main>
		</div>
	)
}
