/**
 * Round 9 — Островок demo property detail — `/demo/ota/ostrovok/property/:id`.
 *
 * URL `:id` is the numeric hid coerced from string. We parse-and-fall-back
 * to SANDBOX_DEMO_HID if the segment is non-numeric (deep-link tolerance).
 *
 * Validates search params with Zod (canonical TanStack Router 2026 pattern).
 * Defaults to today+7/today+9 / 2 adults / 0 children if missing.
 */
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { SANDBOX_DEMO_HID } from '../_demo/ota-showcase/ostrovok/api-client.ts'
import { OstrovokPropertyPage } from '../_demo/ota-showcase/ostrovok/ostrovok-property-page.tsx'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const searchSchema = z.object({
	checkIn: z.string().regex(ISO_DATE).optional(),
	checkOut: z.string().regex(ISO_DATE).optional(),
	adults: z.coerce.number().int().min(1).max(10).optional(),
	children: z.coerce.number().int().min(0).max(6).optional(),
})

export const Route = createFileRoute('/demo/ota/ostrovok/property/$id')({
	component: OstrovokDemoPropertyRoute,
	validateSearch: searchSchema,
})

function todayPlus(days: number): string {
	const d = new Date()
	d.setUTCHours(0, 0, 0, 0)
	d.setUTCDate(d.getUTCDate() + days)
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

function OstrovokDemoPropertyRoute() {
	const { id } = Route.useParams()
	const search = Route.useSearch()
	const navigate = useNavigate()

	const parsedHid = Number.parseInt(id, 10)
	const hid = Number.isFinite(parsedHid) ? parsedHid : SANDBOX_DEMO_HID
	const checkinDate = search.checkIn ?? todayPlus(7)
	const checkoutDate = search.checkOut ?? todayPlus(9)
	const adults = search.adults ?? 2
	const childrenCount = search.children ?? 0

	return (
		<OstrovokPropertyPage
			hid={hid}
			checkinDate={checkinDate}
			checkoutDate={checkoutDate}
			adults={adults}
			childrenCount={childrenCount}
			onBook={(params) => {
				void navigate({
					to: '/demo/ota/ostrovok/booking/$partnerOrderId',
					params: { partnerOrderId: params.partnerOrderId },
					search: {
						bookHash: params.bookHash,
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
