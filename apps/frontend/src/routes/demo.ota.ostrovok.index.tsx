/**
 * Round 9 — Островок demo search landing — `/demo/ota/ostrovok`.
 *
 * Thin route wrapper around <OstrovokSearchPage>. On submit, navigates to
 * the property page с search params encoding the form state.
 *
 * Property route uses numeric `hid` (vs Yandex string hotelId) per ETG
 * canon — SANDBOX_DEMO_HID = 8473727. String-encoded for URL param.
 */
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { OstrovokSearchPage } from '../_demo/ota-showcase/ostrovok/ostrovok-search-page.tsx'

export const Route = createFileRoute('/demo/ota/ostrovok/')({
	component: OstrovokDemoSearchRoute,
})

function OstrovokDemoSearchRoute() {
	const navigate = useNavigate()
	return (
		<OstrovokSearchPage
			onSearch={(params) => {
				void navigate({
					to: '/demo/ota/ostrovok/property/$id',
					params: { id: String(params.hid) },
					search: {
						checkIn: params.checkinDate,
						checkOut: params.checkoutDate,
						adults: params.adults,
						children: params.children,
					},
				})
			}}
		/>
	)
}
