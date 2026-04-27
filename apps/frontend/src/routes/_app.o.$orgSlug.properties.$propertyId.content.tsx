/**
 * Content wizard route — `/o/{orgSlug}/properties/{propertyId}/content`.
 *
 * Closes the operator UX gap from M8.A.0: backend ready for compliance +
 * amenities + descriptions + media + addons, but no UI to populate. This
 * route hosts the 5-step wizard.
 *
 * Guards:
 *   - Parent `/_app/o/$orgSlug` validates session + tenant slug + membership.
 *   - This route additionally validates that the propertyId belongs to the
 *     active tenant (via the existing `propertiesQueryOptions` cache —
 *     no extra HTTP roundtrip in the common case).
 *
 * RBAC: `useCan` UX hint inside step components (compliance is owner-only;
 * the others are owner+manager). Server-side enforcement is the load-bearing
 * gate via `requirePermission` middleware.
 */
import { createFileRoute, redirect } from '@tanstack/react-router'
import { ContentWizardShell } from '../features/content-wizard/wizard-shell.tsx'
import { propertiesQueryOptions } from '../features/receivables/hooks/use-receivables.ts'

export const Route = createFileRoute('/_app/o/$orgSlug/properties/$propertyId/content')({
	beforeLoad: async ({ context: { queryClient }, params }) => {
		const properties = await queryClient.ensureQueryData(propertiesQueryOptions)
		const target = properties.find((p) => p.id === params.propertyId)
		if (!target) {
			throw redirect({ to: '/o/$orgSlug', params: { orgSlug: params.orgSlug } })
		}
		return { property: target }
	},
	component: ContentRouteComponent,
})

function ContentRouteComponent() {
	const { propertyId, orgSlug } = Route.useParams()
	return <ContentWizardShell propertyId={propertyId} orgSlug={orgSlug} />
}
