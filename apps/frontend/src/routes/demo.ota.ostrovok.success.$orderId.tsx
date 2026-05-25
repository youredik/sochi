/**
 * Round 9 — Островок demo success confirmation — `/demo/ota/ostrovok/success/:orderId`.
 *
 * Terminal page — shows partner_order_id (== our local correlation UUID)
 * + return-to-PMS link. The PMS link points to `/demo` (the showcase
 * entry). In production demo the entry tile is external (sales console),
 * but on the deployed frontend `/demo` works too.
 */
import { createFileRoute } from '@tanstack/react-router'
import { OstrovokSuccessPage } from '../_demo/ota-showcase/ostrovok/ostrovok-success-page.tsx'

const RETURN_TO_PMS_URL = '/demo'

export const Route = createFileRoute('/demo/ota/ostrovok/success/$orderId')({
	component: OstrovokDemoSuccessRoute,
})

function OstrovokDemoSuccessRoute() {
	const { orderId } = Route.useParams()
	return <OstrovokSuccessPage orderId={orderId} returnToPmsUrl={RETURN_TO_PMS_URL} />
}
