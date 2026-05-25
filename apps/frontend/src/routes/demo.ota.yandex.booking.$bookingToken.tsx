/**
 * Round 9 — Yandex demo booking form — `/demo/ota/yandex/booking/:bookingToken`.
 *
 * URL-bound booking_token = single-use, 24h TTL — issued by `searchOffers`
 * on the property page. Page submits to `createOrder` and forwards to the
 * success page on `{ status: 'CONFIRMED' }`.
 */
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { YandexBookingPage } from '../_demo/ota-showcase/yandex/yandex-booking-page.tsx'

const searchSchema = z.object({
	roomName: z.string().optional(),
	totalPrice: z.coerce.number().optional(),
	checkIn: z.string().optional(),
	checkOut: z.string().optional(),
})

export const Route = createFileRoute('/demo/ota/yandex/booking/$bookingToken')({
	component: YandexDemoBookingRoute,
	validateSearch: searchSchema,
})

function YandexDemoBookingRoute() {
	const { bookingToken } = Route.useParams()
	const navigate = useNavigate()

	return (
		<YandexBookingPage
			bookingToken={bookingToken}
			onConfirmed={(orderId) => {
				void navigate({
					to: '/demo/ota/yandex/success/$orderId',
					params: { orderId },
				})
			}}
		/>
	)
}
