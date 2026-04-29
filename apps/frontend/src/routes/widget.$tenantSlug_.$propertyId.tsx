/**
 * Public booking widget Screen 1 route — `/widget/{tenantSlug}/{propertyId}`.
 *
 * NO auth gate. Anonymous user lands here from property card click on
 * `/widget/{slug}` OR direct deep link.
 *
 * URL search params: `checkIn`, `checkOut`, `adults`, `children` — canonical
 * 2026 shareable booking state per TanStack Router 1.168 + retainSearchParams
 * middleware research (2026-04-29).
 *
 * Defaults if no search params: today + 2 nights, 2 adults, 0 children.
 */
import { createFileRoute, notFound, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { SearchAndPick } from '../features/public-widget/screens/search-and-pick.tsx'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const searchSchema = z.object({
	checkIn: z.string().regex(ISO_DATE).optional(),
	checkOut: z.string().regex(ISO_DATE).optional(),
	adults: z.coerce.number().int().min(1).max(10).optional(),
	children: z.coerce.number().int().min(0).max(6).optional(),
})

export const Route = createFileRoute('/widget/$tenantSlug_/$propertyId')({
	component: PropertyBookingPage,
	notFoundComponent: PropertyNotFound,
	errorComponent: PropertyRouteError,
	validateSearch: searchSchema,
})

function PropertyBookingPage() {
	const { tenantSlug, propertyId } = Route.useParams()
	const search = Route.useSearch()
	const navigate = useNavigate()

	const today = new Date()
	const todayPlus = (days: number) => {
		const d = new Date(today)
		d.setUTCHours(0, 0, 0, 0)
		d.setUTCDate(d.getUTCDate() + days)
		return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
	}
	const checkIn = search.checkIn ?? todayPlus(7)
	const checkOut = search.checkOut ?? todayPlus(9)
	const adults = search.adults ?? 2
	const childrenCount = search.children ?? 0

	return (
		<SearchAndPick
			tenantSlug={tenantSlug}
			propertyId={propertyId}
			checkIn={checkIn}
			checkOut={checkOut}
			adults={adults}
			childrenCount={childrenCount}
			onSearchChange={(next) => {
				const { childrenCount: kids, ...rest } = next
				void navigate({
					to: '/widget/$tenantSlug/$propertyId',
					params: { tenantSlug, propertyId },
					search: { ...rest, children: kids },
					replace: true,
				})
			}}
			onContinue={(_selection) => {
				// М9.widget.3 (Screen 2 Extras) — для теперь scroll-to-top no-op.
				// Real navigation активируется в follow-up sub-phase.
				if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' })
			}}
			onNotFound={() => {
				throw notFound()
			}}
		/>
	)
}

/**
 * Route-level error boundary — fires когда validateSearch (Zod) rejects
 * invalid query params (e.g. `?adults=abc` или `?checkIn=not-a-date`),
 * либо при unexpected component-tree crash. Renders user-actionable
 * fallback с reset-to-defaults link instead of blank page.
 */
function PropertyRouteError({ error, reset }: { error: Error; reset: () => void }) {
	return (
		<main
			className="mx-auto max-w-3xl p-4 sm:p-6 md:p-8"
			lang="ru"
			role="alert"
			data-testid="route-error-fallback"
		>
			<h1 className="text-2xl font-semibold">Что-то пошло не так</h1>
			<p className="mt-2 text-sm text-muted-foreground">
				Параметры поиска некорректны или произошла ошибка. Попробуйте обновить страницу или начать
				поиск заново.
			</p>
			{error?.message ? (
				<p className="mt-2 text-xs text-muted-foreground">Подробности: {error.message}</p>
			) : null}
			<button
				type="button"
				onClick={reset}
				className="mt-4 rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
			>
				Попробовать ещё раз
			</button>
		</main>
	)
}

function PropertyNotFound() {
	const { tenantSlug, propertyId } = Route.useParams()
	return (
		<main className="mx-auto max-w-3xl p-4 sm:p-6 md:p-8" lang="ru">
			<h1 className="text-2xl font-semibold">Не найдено</h1>
			<p className="mt-2 text-sm text-muted-foreground">
				Размещение <code>{propertyId}</code> для отеля <code>{tenantSlug}</code> не найдено или
				недоступно для онлайн-бронирования. Проверьте ссылку.
			</p>
		</main>
	)
}
