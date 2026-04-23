import { createFileRoute } from '@tanstack/react-router'
import { WizardShell } from '../features/setup/wizard-shell'

/**
 * Setup wizard route — `/o/{orgSlug}/setup`. Gated by `_app/o/$orgSlug`
 * parent (session + tenant slug + membership already validated).
 *
 * Dashboard redirects here when `property.list()` returns empty; there's
 * no explicit "you have nothing" empty-state on the dashboard because
 * having zero properties means the user literally can't do anything with
 * the product yet. Forcing the wizard is the right default.
 */
export const Route = createFileRoute('/_app/o/$orgSlug/setup')({
	component: WizardShell,
})
