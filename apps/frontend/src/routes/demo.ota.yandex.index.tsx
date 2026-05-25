/**
 * Round 9 — Yandex demo search landing — `/demo/ota/yandex`.
 *
 * Thin route wrapper around <YandexSearchPage>. On submit, navigates to
 * the property page с search params encoding the form state (canonical
 * shareable URL pattern per widget canon).
 */
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { YandexSearchPage } from '../_demo/ota-showcase/yandex/yandex-search-page.tsx'

export const Route = createFileRoute('/demo/ota/yandex/')({
	component: YandexDemoSearchRoute,
})

function YandexDemoSearchRoute() {
	const navigate = useNavigate()
	return (
		<YandexSearchPage
			onSearch={(params) => {
				void navigate({
					to: '/demo/ota/yandex/property/$id',
					params: { id: params.hotelId },
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
