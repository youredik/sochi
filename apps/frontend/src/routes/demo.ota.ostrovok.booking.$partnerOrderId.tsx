/**
 * Round 9 — Островок demo booking form — `/demo/ota/ostrovok/booking/:partnerOrderId`.
 *
 * URL-bound `partnerOrderId` = UUIDv4 we minted on the property page CTA;
 * `book_hash` + price flow through search params (canonical 2026 shareable
 * URL pattern). The booking page orchestrates the 2-stage `prebookForm()`
 * → `finishBooking()` handshake.
 *
 * If the user lands here without book_hash / totalPrice (e.g. bookmark
 * the URL after a fresh restart), we route them back to search — the
 * stage 1 hash is single-use and cannot be regenerated client-side.
 */
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { OstrovokBookingPage } from '../_demo/ota-showcase/ostrovok/ostrovok-booking-page.tsx'

const searchSchema = z.object({
	bookHash: z.string().min(1).optional(),
	roomName: z.string().optional(),
	totalPrice: z.coerce.number().optional(),
	checkIn: z.string().optional(),
	checkOut: z.string().optional(),
})

export const Route = createFileRoute('/demo/ota/ostrovok/booking/$partnerOrderId')({
	component: OstrovokDemoBookingRoute,
	validateSearch: searchSchema,
})

function OstrovokDemoBookingRoute() {
	const { partnerOrderId } = Route.useParams()
	const search = Route.useSearch()
	const navigate = useNavigate()

	if (search.bookHash === undefined || search.totalPrice === undefined) {
		// Deep-link without context — bounce back to search start. Stage 1
		// book_hash is single-use, server cannot reissue from URL alone.
		void navigate({ to: '/demo/ota/ostrovok', replace: true })
		return null
	}

	return (
		<OstrovokBookingPage
			bookHash={search.bookHash}
			partnerOrderId={partnerOrderId}
			totalPrice={search.totalPrice}
			onConfirmed={(orderId) => {
				void navigate({
					to: '/demo/ota/ostrovok/success/$orderId',
					params: { orderId },
				})
			}}
		/>
	)
}
