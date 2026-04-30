/**
 * Public booking widget Screen 2 (Extras / Addons) route —
 * `/widget/{tenantSlug}/{propertyId}/extras`.
 *
 * Per `plans/m9_widget_canonical.md` §3 + Round 2 verified canon:
 *   - Search params carry forward booking context (checkIn/checkOut/adults/children)
 *     plus selected room/rate (roomTypeId/ratePlanId) и cart state (addons CSV).
 *   - URL-shareable cart canon (TanStack Router 2026 — Round 2 confirmed).
 *   - validateSearch (Zod) rejects malformed → errorComponent fallback.
 *   - Underscore (`_`) in segment — TanStack flat-route opt-out for nesting.
 */
import { createFileRoute, notFound, useNavigate } from '@tanstack/react-router'
import { useCallback } from 'react'
import { z } from 'zod'
import { useAvailability } from '../features/public-widget/hooks/use-availability.ts'
import {
	type AddonCartEntry,
	deserializeCart,
	serializeCart,
} from '../features/public-widget/lib/addon-pricing.ts'
import { Extras } from '../features/public-widget/screens/extras.tsx'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
// Cart format per addon-pricing.ts: `addonId:qty,addonId:qty`. Permissive
// regex; deserializeCart does strict parse + throws for malformed.
const CART_FORMAT = /^([\w-]+:\d+)(,[\w-]+:\d+)*$/

const searchSchema = z.object({
	checkIn: z.string().regex(ISO_DATE),
	checkOut: z.string().regex(ISO_DATE),
	adults: z.coerce.number().int().min(1).max(10),
	children: z.coerce.number().int().min(0).max(6).default(0),
	roomTypeId: z.string().min(1).max(128),
	ratePlanId: z.string().min(1).max(128),
	addons: z
		.string()
		.optional()
		.refine((s) => s === undefined || s === '' || CART_FORMAT.test(s), {
			message: 'cart format invalid',
		}),
})

export const Route = createFileRoute('/widget/$tenantSlug_/$propertyId_/extras')({
	component: ExtrasPage,
	notFoundComponent: ExtrasNotFound,
	errorComponent: ExtrasRouteError,
	validateSearch: searchSchema,
})

function ExtrasPage() {
	const { tenantSlug, propertyId } = Route.useParams()
	const search = Route.useSearch()
	const navigate = useNavigate()

	const { checkIn, checkOut, adults, children: childrenCount, roomTypeId, ratePlanId } = search

	// Re-fetch availability — нужно для resolve selectedRoomType + selectedRate
	// detail. Cache hit от Screen 1 (same query key) — instant render.
	const availability = useAvailability({
		tenantSlug,
		propertyId,
		checkIn,
		checkOut,
		adults,
		children: childrenCount,
	})

	const cart: readonly AddonCartEntry[] =
		search.addons === undefined || search.addons === ''
			? []
			: (() => {
					try {
						return deserializeCart(search.addons)
					} catch {
						return []
					}
				})()

	const handleCartChange = useCallback(
		(next: readonly AddonCartEntry[]) => {
			void navigate({
				to: '/widget/$tenantSlug/$propertyId/extras',
				params: { tenantSlug, propertyId },
				search: {
					...search,
					addons: serializeCart(next) || undefined,
				},
				replace: true,
			})
		},
		[navigate, search, tenantSlug, propertyId],
	)

	const handleContinue = useCallback(() => {
		// M9.widget.4 (Screen 3 Guest+Pay) — TODO в next sub-phase.
		// На текущий момент scroll-to-top + persist cart в URL (already done).
		if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' })
	}, [])

	const handleSkip = useCallback(() => {
		// Skip = proceed-with-empty-cart. Clear cart + go to Screen 3 (M9.widget.4 — TBD).
		if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' })
	}, [])

	if (availability.isLoading || !availability.data) {
		return (
			<main
				className="mx-auto grid min-h-svh max-w-6xl gap-4 p-4 sm:p-6 md:grid-cols-[1fr_320px] md:p-8"
				lang="ru"
			>
				<div className="space-y-4">
					<div className="h-14 w-full animate-pulse rounded-lg bg-muted" />
					<div className="h-72 w-full animate-pulse rounded-xl bg-muted" />
				</div>
				<div className="hidden h-72 w-full animate-pulse rounded-xl bg-muted md:block" />
			</main>
		)
	}

	const offering = availability.data.offerings.find((o) => o.roomType.id === roomTypeId)
	const rate = offering?.rateOptions.find((r) => r.ratePlanId === ratePlanId)
	if (!offering || !rate) {
		// Selected room/rate no longer available (price changed, sold out, etc.).
		// Send back to Screen 1 to re-pick (preserve dates/guests).
		void navigate({
			to: '/widget/$tenantSlug/$propertyId',
			params: { tenantSlug, propertyId },
			search: { checkIn, checkOut, adults, children: childrenCount },
			replace: true,
		})
		return null
	}

	return (
		<Extras
			tenantSlug={tenantSlug}
			propertyId={propertyId}
			checkIn={checkIn}
			checkOut={checkOut}
			nights={availability.data.nights}
			adults={adults}
			childrenCount={childrenCount}
			selectedRoomType={offering.roomType}
			selectedRate={rate}
			tourismTaxRateBps={availability.data.property.tourismTaxRateBps}
			cart={cart}
			onCartChange={handleCartChange}
			onContinue={handleContinue}
			onSkip={handleSkip}
			onNotFound={() => {
				throw notFound()
			}}
		/>
	)
}

function ExtrasRouteError({ error, reset }: { error: Error; reset: () => void }) {
	return (
		<main
			className="mx-auto max-w-3xl p-4 sm:p-6 md:p-8"
			lang="ru"
			role="alert"
			data-testid="extras-route-error"
		>
			<h1 className="text-2xl font-semibold">Что-то пошло не так</h1>
			<p className="mt-2 text-sm text-muted-foreground">
				Параметры поиска некорректны или произошла ошибка. Попробуйте начать поиск заново.
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

function ExtrasNotFound() {
	const { tenantSlug, propertyId } = Route.useParams()
	return (
		<main className="mx-auto max-w-3xl p-4 sm:p-6 md:p-8" lang="ru">
			<h1 className="text-2xl font-semibold">Не найдено</h1>
			<p className="mt-2 text-sm text-muted-foreground">
				Дополнительные услуги для размещения <code>{propertyId}</code> отеля{' '}
				<code>{tenantSlug}</code> недоступны. Проверьте ссылку.
			</p>
		</main>
	)
}
