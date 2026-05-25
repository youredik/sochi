/**
 * Round 9 — Yandex demo property detail — `/demo/ota/yandex/property/:id`.
 *
 * Validates search params with Zod (canonical TanStack Router 2026 pattern).
 * Defaults to today+7/today+9 / 2 adults / 0 children if missing — lets a
 * deep-link work without prior search context.
 */
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { YandexPropertyPage } from '../_demo/ota-showcase/yandex/yandex-property-page.tsx'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const searchSchema = z.object({
	checkIn: z.string().regex(ISO_DATE).optional(),
	checkOut: z.string().regex(ISO_DATE).optional(),
	adults: z.coerce.number().int().min(1).max(10).optional(),
	children: z.coerce.number().int().min(0).max(6).optional(),
})

export const Route = createFileRoute('/demo/ota/yandex/property/$id')({
	component: YandexDemoPropertyRoute,
	validateSearch: searchSchema,
})

function todayPlus(days: number): string {
	const d = new Date()
	d.setUTCHours(0, 0, 0, 0)
	d.setUTCDate(d.getUTCDate() + days)
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

function YandexDemoPropertyRoute() {
	const { id } = Route.useParams()
	const search = Route.useSearch()
	const navigate = useNavigate()

	const checkinDate = search.checkIn ?? todayPlus(7)
	const checkoutDate = search.checkOut ?? todayPlus(9)
	const adults = search.adults ?? 2
	const childrenCount = search.children ?? 0

	return (
		<YandexPropertyPage
			hotelId={id}
			checkinDate={checkinDate}
			checkoutDate={checkoutDate}
			adults={adults}
			childrenCount={childrenCount}
			onBook={(params) => {
				void navigate({
					to: '/demo/ota/yandex/booking/$bookingToken',
					params: { bookingToken: params.bookingToken },
					search: {
						roomName: params.roomName,
						totalPrice: params.totalPrice,
						checkIn: params.checkinDate,
						checkOut: params.checkoutDate,
					},
				})
			}}
		/>
	)
}
