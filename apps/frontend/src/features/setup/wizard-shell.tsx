import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from '@tanstack/react-router'
import { useEffect } from 'react'
import { PropertyStep } from './steps/property-step'
import { RatePlanStep } from './steps/rate-plan-step'
import { RoomTypeStep } from './steps/room-type-step'
import { RoomsStep } from './steps/rooms-step'
import { STEP_LABELS, useWizardStore, WIZARD_STEPS } from './wizard-store'

/**
 * Setup wizard shell. Progress indicator (numbered steps with current/
 * completed styling), + the step-specific form component. Auto-navigates
 * to tenant dashboard once the user finishes step 3 ("done" state).
 *
 * a11y: `<ol role="list">` for the step indicator, current step marked
 * with `aria-current="step"` per ARIA APG pattern for multi-step flows.
 */
export function WizardShell() {
	const step = useWizardStore((s) => s.step)
	const reset = useWizardStore((s) => s.reset)
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const { orgSlug } = useParams({ from: '/_app/o/$orgSlug/setup' })

	useEffect(() => {
		if (step !== 'done') return
		// `removeQueries` deletes cached data — the dashboard's next
		// `ensureQueryData(['properties'])` MUST call queryFn and get fresh
		// data (now including our created property). `invalidateQueries`
		// only marks stale; inactive queries don't auto-refetch, so
		// ensureQueryData could return the old empty cache and loop us
		// back to /setup.
		reset()
		queryClient.removeQueries({ queryKey: ['properties'] })
		void navigate({ to: '/o/$orgSlug', params: { orgSlug } })
	}, [step, navigate, orgSlug, reset, queryClient])

	return (
		<main className="mx-auto max-w-lg px-6 py-12">
			<ProgressIndicator />
			<div className="mt-8">
				{step === 'property' ? <PropertyStep /> : null}
				{step === 'roomType' ? <RoomTypeStep /> : null}
				{step === 'rooms' ? <RoomsStep /> : null}
				{step === 'ratePlan' ? <RatePlanStep /> : null}
			</div>
		</main>
	)
}

function ProgressIndicator() {
	const current = useWizardStore((s) => s.step)
	const visibleSteps = WIZARD_STEPS.filter((s): s is Exclude<typeof s, 'done'> => s !== 'done')
	const currentIdx = current === 'done' ? visibleSteps.length : visibleSteps.indexOf(current)

	return (
		<ol className="flex items-center gap-2 text-sm">
			{visibleSteps.map((s, i) => {
				const isActive = s === current
				const isDone = i < currentIdx
				return (
					<li
						key={s}
						className="flex flex-1 items-center gap-2"
						{...(isActive ? { 'aria-current': 'step' } : {})}
					>
						<span
							className={
								isDone
									? 'bg-primary text-primary-foreground flex size-6 items-center justify-center rounded-full text-xs font-medium'
									: isActive
										? 'border-primary text-primary flex size-6 items-center justify-center rounded-full border-2 text-xs font-medium'
										: 'border-border text-muted-foreground flex size-6 items-center justify-center rounded-full border text-xs'
							}
						>
							{i + 1}
						</span>
						<span className={isActive ? 'text-foreground font-medium' : 'text-muted-foreground'}>
							{STEP_LABELS[s]}
						</span>
					</li>
				)
			})}
		</ol>
	)
}
