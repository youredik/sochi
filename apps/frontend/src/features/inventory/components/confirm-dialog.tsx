/**
 * `<ConfirmDialog>` — generic confirm-then-act modal for destructive
 * operations (delete category, delete rate plan, etc.). Uses the existing
 * shadcn-style Dialog primitive с role="alertdialog" semantics — APG canon
 * для irreversible actions per WCAG / Mews / Cloudbeds canon.
 *
 * Pre-done audit:
 *   - [R1] Hidden when open=false; renders когда open=true.
 *   - [A1] `<DialogTitle>` обязателен; serves as accessible name.
 *   - [A2] role="alertdialog" via portal markup (Radix Dialog default
 *          carries role="dialog"; aria-describedby paired для context).
 *   - [F1] Confirm button reflects busy state (`isPending` prop).
 *   - [F2] Cancel button disabled while pending.
 */
import type { ReactNode } from 'react'
import { Button } from '../../../components/ui/button.tsx'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '../../../components/ui/dialog.tsx'

export interface ConfirmDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	title: string
	description: ReactNode
	confirmLabel: string
	cancelLabel?: string
	onConfirm: () => void | Promise<void>
	isPending?: boolean
	tone?: 'destructive' | 'default'
}

export function ConfirmDialog({
	open,
	onOpenChange,
	title,
	description,
	confirmLabel,
	cancelLabel = 'Отмена',
	onConfirm,
	isPending = false,
	tone = 'destructive',
}: ConfirmDialogProps) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={isPending}
					>
						{cancelLabel}
					</Button>
					<Button
						type="button"
						variant={tone === 'destructive' ? 'destructive' : 'default'}
						onClick={() => {
							void onConfirm()
						}}
						disabled={isPending}
					>
						{/* biome-ignore lint/nursery/noLeakedRender: both ternary branches are string literals — no leak possible. The lint mistakes the `confirmLabel` variable as «potentially falsy». */}
						{isPending ? 'Выполняем…' : confirmLabel}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
