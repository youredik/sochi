/**
 * Round 9 — Yandex demo success confirmation — `/demo/ota/yandex/success/:orderId`.
 *
 * Terminal page — shows order_id + return-to-PMS link. The PMS link points
 * to `/demo` (the showcase entry). In production demo the entry tile is
 * external (sales console), but on the deployed frontend `/demo` works too.
 */
import { createFileRoute } from '@tanstack/react-router'
import { YandexSuccessPage } from '../_demo/ota-showcase/yandex/yandex-success-page.tsx'

const RETURN_TO_PMS_URL = '/demo'

export const Route = createFileRoute('/demo/ota/yandex/success/$orderId')({
	component: YandexDemoSuccessRoute,
})

function YandexDemoSuccessRoute() {
	const { orderId } = Route.useParams()
	return <YandexSuccessPage orderId={orderId} returnToPmsUrl={RETURN_TO_PMS_URL} />
}
