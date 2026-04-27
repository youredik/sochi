import { useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { AddonsStep } from './steps/addons-step.tsx'
import { AmenitiesStep } from './steps/amenities-step.tsx'
import { ComplianceStep } from './steps/compliance-step.tsx'
import { DescriptionsStep } from './steps/descriptions-step.tsx'
import { MediaStep } from './steps/media-step.tsx'
import {
	CONTENT_WIZARD_STEPS,
	type ContentStep,
	STEP_LABELS,
	useContentWizardStore,
} from './wizard-store.ts'

interface WizardShellProps {
	propertyId: string
	orgSlug: string
}

/**
 * Content-wizard shell. Displays a progress strip + the active step body.
 *
 * propertyId & orgSlug come from the route's `useParams` — passed through
 * because step components need both for backend calls (compliance is
 * tenant-scoped, the other 4 are property-scoped).
 *
 * `done` state navigates back to property dashboard. Operator can re-enter
 * the wizard at any step via the progress-strip buttons (each step is
 * idempotent: PATCH/PUT semantics, not insert).
 */
export function ContentWizardShell({ propertyId, orgSlug }: WizardShellProps) {
	const step = useContentWizardStore((s) => s.step)
	const reset = useContentWizardStore((s) => s.reset)
	const navigate = useNavigate()

	useEffect(() => {
		if (step !== 'done') return
		reset()
		void navigate({ to: '/o/$orgSlug', params: { orgSlug } })
	}, [step, navigate, orgSlug, reset])

	return (
		<main className="mx-auto max-w-3xl px-6 py-12">
			<header className="mb-6">
				<h1 className="text-2xl font-semibold">Профиль гостиницы</h1>
				<p className="text-muted-foreground mt-1 text-sm">
					Заполните compliance, удобства, описание, фото и услуги — данные используются в публичных
					виджетах и интеграциях с каналами продаж.
				</p>
			</header>
			<ProgressIndicator />
			<div className="mt-8">
				{step === 'compliance' ? <ComplianceStep /> : null}
				{step === 'amenities' ? <AmenitiesStep propertyId={propertyId} /> : null}
				{step === 'descriptions' ? <DescriptionsStep propertyId={propertyId} /> : null}
				{step === 'media' ? <MediaStep propertyId={propertyId} /> : null}
				{step === 'addons' ? <AddonsStep propertyId={propertyId} /> : null}
			</div>
		</main>
	)
}

function ProgressIndicator() {
	const current = useContentWizardStore((s) => s.step)
	const goTo = useContentWizardStore((s) => s.goTo)
	const visibleSteps = CONTENT_WIZARD_STEPS.filter(
		(s): s is Exclude<ContentStep, 'done'> => s !== 'done',
	)
	const currentIdx = current === 'done' ? visibleSteps.length : visibleSteps.indexOf(current)

	return (
		<ol className="flex flex-wrap items-center gap-2 text-sm">
			{visibleSteps.map((s, i) => {
				const isActive = s === current
				const isDone = i < currentIdx
				return (
					<li
						key={s}
						className="flex flex-1 items-center gap-2"
						{...(isActive ? { 'aria-current': 'step' } : {})}
					>
						<button
							type="button"
							onClick={() => goTo(s)}
							className="flex items-center gap-2"
							aria-label={`Перейти к шагу ${i + 1}: ${STEP_LABELS[s]}`}
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
						</button>
					</li>
				)
			})}
		</ol>
	)
}
