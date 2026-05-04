/**
 * Demo tour trigger button — M9.widget.8 / A6.2.
 *
 * Visible ONLY когда tenant.mode === 'demo' AND tour status !== 'completed'.
 * Once user starts tour → button hides (overlay takes over).
 * Once tour completes/skipped → button hides (no re-prompting).
 *
 * Caller-provided `mode` prop ensures separation of concerns: tour logic doesn't
 * fetch tenant data — caller decides if we're in demo mode.
 */

import type { ReactElement } from 'react'
import { useDemoTour } from './use-demo-tour.ts'

export interface DemoTourTriggerProps {
	readonly mode: 'demo' | 'production' | null | undefined
}

export function DemoTourTrigger({ mode }: DemoTourTriggerProps): ReactElement | null {
	const { status, start } = useDemoTour()

	// Production tenants — no tour visibility.
	if (mode !== 'demo') return null
	// Tour active OR completed — no trigger.
	if (status !== 'idle') return null

	return (
		<button
			type="button"
			onClick={start}
			data-testid="demo-tour-trigger"
			className="ml-3 inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-xs font-medium text-primary hover:bg-primary/10"
		>
			<span aria-hidden>✨</span>
			<span>Тур по демо</span>
		</button>
	)
}
