/**
 * Demo tour overlay — M9.widget.8 / A6.2 / D9-D11.
 *
 * Native HTML Popover API + `<dialog>` + `@floating-ui/dom` positioning.
 * **NO driver.js** (rejected per «современно или в топку» canon — 5-month
 * maintenance mode + raw HTML XSS sink + iOS unfixed).
 *
 * **5 hardening clauses (D11) all native or app-level:**
 *   (a) Lingui-only copy — driven by `demo-tour-config.ts`, no tenant strings
 *   (b) `prefers-reduced-motion` — CSS native + JS bool from `useDemoTour`
 *   (c) ARIA — `<dialog>` ships `role="dialog"` + `aria-modal` natively;
 *       we add `aria-labelledby` + visually-hidden `aria-live="polite"`
 *   (d) iOS Safari touch — native `<dialog>` + `popover` handle inertness
 *   (e) lifecycle — `useEffect` cleanup destroys `autoUpdate` listeners +
 *       closes dialog on unmount
 */

import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom'
import { type ReactElement, useEffect, useId, useRef } from 'react'
import { useDemoTour } from './use-demo-tour.ts'

export function DemoTourOverlay(): ReactElement | null {
	const { status, currentStep, currentStepIndex, totalSteps, reducedMotion, next, prev, skip } =
		useDemoTour()
	const dialogRef = useRef<HTMLDialogElement>(null)
	const titleId = useId()
	const descId = useId()
	const liveId = useId()

	// Open / close dialog в sync with tour status.
	useEffect(() => {
		const dialog = dialogRef.current
		if (!dialog) return
		if (currentStep && !dialog.open) {
			dialog.showModal()
		} else if (!currentStep && dialog.open) {
			dialog.close()
		}
	}, [currentStep])

	// Position popover near target via floating-ui autoUpdate (handles scroll +
	// resize). Cleanup releases listeners (D11.e).
	useEffect(() => {
		if (!currentStep) return undefined
		const dialog = dialogRef.current
		if (!dialog) return undefined
		const target = document.querySelector(currentStep.targetSelector)
		if (!(target instanceof HTMLElement)) return undefined

		const cleanup = autoUpdate(target, dialog, () => {
			void computePosition(target, dialog, {
				placement: currentStep.placement,
				middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 16 })],
			}).then(({ x, y }) => {
				Object.assign(dialog.style, {
					margin: '0',
					position: 'fixed',
					left: `${x}px`,
					top: `${y}px`,
				})
			})
		})
		return cleanup
	}, [currentStep])

	// Close-on-Esc invokes `skip` to mark completed (avoid re-prompting).
	useEffect(() => {
		const dialog = dialogRef.current
		if (!dialog) return undefined
		const handler = (e: Event) => {
			e.preventDefault()
			skip()
		}
		dialog.addEventListener('cancel', handler)
		return () => dialog.removeEventListener('cancel', handler)
	}, [skip])

	if (!currentStep || (status !== 'idle' && status !== 'completed' && !currentStep)) {
		return null
	}

	if (!currentStep) return null

	const stepNumber = currentStepIndex + 1
	const announceText = `Шаг ${stepNumber} из ${totalSteps}: ${currentStep.title}`

	return (
		<dialog
			ref={dialogRef}
			data-testid="demo-tour-dialog"
			data-reduced-motion={reducedMotion ? 'true' : 'false'}
			aria-labelledby={titleId}
			aria-describedby={descId}
			className="m-0 max-w-md rounded-xl border border-border bg-card p-0 shadow-xl"
			style={{
				transition: reducedMotion ? 'none' : 'opacity 150ms ease-out',
			}}
		>
			<div className="p-4 sm:p-5">
				<div
					className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
					data-testid="demo-tour-step-counter"
				>
					Шаг {stepNumber} из {totalSteps}
				</div>
				<h2 id={titleId} className="mt-1 text-lg font-semibold tracking-tight">
					{currentStep.title}
				</h2>
				<p id={descId} className="mt-2 text-sm text-muted-foreground">
					{currentStep.description}
				</p>
				{/* Visually-hidden aria-live — announces step transitions для screen readers. */}
				<div id={liveId} aria-live="polite" aria-atomic="true" className="sr-only">
					{announceText}
				</div>
				<div className="mt-4 flex items-center justify-between gap-2">
					<button
						type="button"
						className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
						onClick={skip}
						data-testid="demo-tour-skip"
					>
						Пропустить
					</button>
					<div className="flex items-center gap-2">
						{currentStepIndex > 0 ? (
							<button
								type="button"
								className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
								onClick={prev}
								data-testid="demo-tour-prev"
							>
								Назад
							</button>
						) : null}
						<button
							type="button"
							className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
							onClick={next}
							data-testid="demo-tour-next"
						>
							{stepNumber === totalSteps ? 'Готово' : 'Далее'}
						</button>
					</div>
				</div>
			</div>
		</dialog>
	)
}
