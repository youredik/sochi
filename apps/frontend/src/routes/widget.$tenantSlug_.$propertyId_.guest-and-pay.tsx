/**
 * Public booking widget Screen 3 (Guest+Pay) route —
 * `/widget/{tenantSlug}/{propertyId}/guest-and-pay`.
 *
 * Per `plans/m9_widget_4_canonical.md` §3:
 *   - Search params carry forward booking context: dates + guests + selected
 *     room/rate + cart serialization (M9.widget.2/3 canonical pattern).
 *   - validateSearch (Zod) rejects malformed → errorComponent fallback.
 *   - Underscore (`_`) in segment — TanStack flat-route opt-out для nesting.
 *   - Re-fetches availability + addons (cache hit от Screens 1+2 — instant
 *     render).
 */
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { useAddons } from '../features/public-widget/hooks/use-addons.ts'
import { useAvailability } from '../features/public-widget/hooks/use-availability.ts'
import {
	type AddonCartEntry,
	deserializeCart,
} from '../features/public-widget/lib/addon-pricing.ts'
import { GuestAndPay } from '../features/public-widget/screens/guest-and-pay.tsx'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
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

export const Route = createFileRoute('/widget/$tenantSlug_/$propertyId_/guest-and-pay')({
	component: GuestAndPayPage,
	errorComponent: GuestAndPayRouteError,
	validateSearch: searchSchema,
})

function GuestAndPayPage() {
	const { tenantSlug, propertyId } = Route.useParams()
	const search = Route.useSearch()
	const navigate = useNavigate()

	const { checkIn, checkOut, adults, children: childrenCount, roomTypeId, ratePlanId } = search

	const availability = useAvailability({
		tenantSlug,
		propertyId,
		checkIn,
		checkOut,
		adults,
		children: childrenCount,
	})
	const addonsQuery = useAddons(tenantSlug, propertyId)

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
		// Selected room/rate no longer available — send back к Screen 1
		void navigate({
			to: '/widget/$tenantSlug/$propertyId',
			params: { tenantSlug, propertyId },
			search: { checkIn, checkOut, adults, children: childrenCount },
			replace: true,
		})
		return null
	}

	return (
		<GuestAndPay
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
			addons={addonsQuery.data?.addons ?? []}
		/>
	)
}

function GuestAndPayRouteError({ error, reset }: { error: Error; reset: () => void }) {
	return (
		<main
			className="mx-auto max-w-3xl p-4 sm:p-6 md:p-8"
			lang="ru"
			role="alert"
			data-testid="guest-and-pay-route-error"
		>
			<h1 className="text-2xl font-semibold">Что-то пошло не так</h1>
			<p className="mt-2 text-sm text-muted-foreground">
				Параметры брони некорректны или произошла ошибка. Попробуйте начать поиск заново.
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
