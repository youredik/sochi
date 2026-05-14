import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
import { propertiesQueryOptions } from '../features/receivables/hooks/use-receivables.ts'

/**
 * Inventory layout route — `/o/{orgSlug}/properties/{propertyId}/inventory`.
 *
 * Validates that the propertyId belongs to the active tenant (defensive —
 * parent `_app/o/$orgSlug` already guards session + tenant), then renders
 * `<Outlet />` for the child tab routes (`rooms`, `rate-plans`, `prices`).
 *
 * Direct hit on `/inventory` без a leaf segment redirects к `/rooms` (first
 * tab) — keeps sidebar entry click deterministic, no «empty inventory page»
 * dead state.
 */
export const Route = createFileRoute('/_app/o/$orgSlug/properties/$propertyId/inventory')({
	beforeLoad: async ({ context: { queryClient }, params, location }) => {
		const properties = await queryClient.ensureQueryData(propertiesQueryOptions)
		const target = properties.find((p) => p.id === params.propertyId)
		if (!target) {
			throw redirect({ to: '/o/$orgSlug', params: { orgSlug: params.orgSlug } })
		}
		// Direct hit on the parent route → redirect к first tab.
		if (location.pathname.endsWith('/inventory') || location.pathname.endsWith('/inventory/')) {
			throw redirect({
				to: '/o/$orgSlug/properties/$propertyId/inventory/rooms',
				params: { orgSlug: params.orgSlug, propertyId: params.propertyId },
			})
		}
		return { property: target }
	},
	component: () => <Outlet />,
})
