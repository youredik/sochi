import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from '@tanstack/react-router'
import { useEffect } from 'react'
import { IdentifyStep } from './components/identify-step.tsx'
import { InventoryStep } from './components/inventory-step.tsx'
import { useWizardStore } from './wizard-store.ts'

const STEP_LABELS: Record<'identify' | 'inventory', string> = {
	identify: 'Гостиница',
	inventory: 'Номера и цена',
}

/**
 * 2-screen onboarding wizard shell. Tracks the two real steps (identify →
 * inventory) and auto-navigates to `/o/$orgSlug/grid` once the inventory
 * mutation flips state to `done`.
 *
 * Cache eviction: `removeQueries({queryKey: ['properties']})` deletes the
 * dashboard guard's cached empty list so its next `ensureQueryData` re-
 * runs the queryFn and sees the newly-created property. Without this, the
 * dashboard sees the stale empty cache and bounces us back into /setup.
 *
 * a11y: `<ol role="list">` step indicator с `aria-current="step"` per ARIA
 * APG multi-step pattern.
 */
export function WizardShell() {
	const step = useWizardStore((s) => s.step)
	const reset = useWizardStore((s) => s.reset)
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const { orgSlug } = useParams({ from: '/_app/o/$orgSlug/setup' })

	useEffect(() => {
		if (step !== 'done') return
		reset()
		queryClient.removeQueries({ queryKey: ['properties'] })
		void navigate({ to: '/o/$orgSlug/grid', params: { orgSlug } })
	}, [step, navigate, orgSlug, reset, queryClient])

	return (
		<main className="mx-auto max-w-xl px-6 py-12">
			<header className="space-y-1">
				<h1 className="text-2xl font-semibold tracking-tight">Заводим гостиницу</h1>
				<p className="text-sm text-muted-foreground">Два шага — и вы в шахматке.</p>
			</header>

			<ProgressIndicator currentStep={step === 'done' ? 'inventory' : step} />

			<div className="mt-8">
				{step === 'identify' ? <IdentifyStep /> : null}
				{step === 'inventory' ? <InventoryStep /> : null}
			</div>
		</main>
	)
}

function ProgressIndicator({ currentStep }: { currentStep: 'identify' | 'inventory' }) {
	const steps: Array<'identify' | 'inventory'> = ['identify', 'inventory']
	const currentIdx = steps.indexOf(currentStep)

	return (
		<ol className="mt-6 flex items-center gap-2 text-sm">
			{steps.map((s, i) => {
				const isActive = s === currentStep
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
