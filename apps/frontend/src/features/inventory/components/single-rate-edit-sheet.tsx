/**
 * `<SingleRateEditSheet>` — per-cell price edit. Click ячейку on the prices
 * grid → open this Sheet с pre-filled date + ratePlan + current price.
 * Canon май 2026 (Mews / Cloudbeds): inline cell-edit is the daily ad-hoc
 * affordance, complementing the bulk-edit modal for seasonal adjustments.
 *
 * Pre-done audit:
 *   [R1] Hidden when open=false; renders когда open=true.
 *   [F1] Submit calls useBulkUpsertRates с rates=[{date, amount}] (single
 *        rate per call — same backend endpoint, smallest payload).
 *   [F2] «Удалить» button calls useDeleteRate (DELETE /rates/:date) →
 *        cell reverts к «—» (no rate).
 *   [A1] `<ResponsiveSheetTitle>` обязателен.
 */
import { useForm } from '@tanstack/react-form'
import type { RatePlan, RoomType } from '@horeca/shared'
import { useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { Button } from '../../../components/ui/button.tsx'
import { Field, FieldError, FieldLabel } from '../../../components/ui/field.tsx'
import { Input } from '../../../components/ui/input.tsx'
import {
	ResponsiveSheet,
	ResponsiveSheetContent,
	ResponsiveSheetDescription,
	ResponsiveSheetFooter,
	ResponsiveSheetHeader,
	ResponsiveSheetTitle,
} from '../../../components/ui/responsive-sheet.tsx'
import { useBulkUpsertRates, useDeleteRate } from '../hooks/use-rates.ts'

const formSchema = z.object({
	// Strict positive amount. Caught real-bug-hunt 2026-05-15: regex allowed
	// '0' → cell saved as 0₽ rate → sellable for free (data-loss trap).
	// Server's `singleRateSchema.amount` ALSO forbids non-positive but
	// generic 400 response is UX-bad. .refine surfaces inline FieldError.
	price: z
		.string()
		.min(1, 'Введите цену')
		.regex(/^\d+(\.\d{1,2})?$/, 'Число, до 2 знаков после точки')
		.refine((v) => Number(v) > 0, 'Цена должна быть больше нуля'),
})

export interface SingleRateEditTarget {
	readonly date: string
	readonly ratePlan: RatePlan
	readonly roomType: RoomType
	readonly currentAmount: string | undefined
}

export interface SingleRateEditSheetProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	target: SingleRateEditTarget
}

export function SingleRateEditSheet({ open, onOpenChange, target }: SingleRateEditSheetProps) {
	const [submitError, setSubmitError] = useState<string | null>(null)
	const upsert = useBulkUpsertRates()
	const del = useDeleteRate()
	const isPending = upsert.isPending || del.isPending

	const form = useForm({
		defaultValues: {
			// Empty default когда no current amount — заставить user явно ввести
			// price (placeholder-as-default trap caught earlier с inventoryCount /
			// orgName; applying same canon here). При edit-mode prefill existing.
			price: target.currentAmount ?? '',
		},
		onSubmit: async ({ value }) => {
			setSubmitError(null)
			try {
				await upsert.mutateAsync({
					ratePlanId: target.ratePlan.id,
					input: {
						rates: [{ date: target.date, amount: value.price, currency: 'RUB' }],
					},
				})
				toast.success(`Цена на ${target.date} сохранена`)
				onOpenChange(false)
			} catch (err) {
				setSubmitError(err instanceof Error ? err.message : String(err))
			}
		},
	})

	async function handleDelete() {
		setSubmitError(null)
		try {
			await del.mutateAsync({ ratePlanId: target.ratePlan.id, date: target.date })
			toast.success(`Цена на ${target.date} удалена`)
			onOpenChange(false)
		} catch (err) {
			setSubmitError(err instanceof Error ? err.message : String(err))
		}
	}

	return (
		<ResponsiveSheet open={open} onOpenChange={onOpenChange}>
			<ResponsiveSheetContent side="right" className="sm:max-w-md">
				<ResponsiveSheetHeader>
					<ResponsiveSheetTitle>Изменить цену</ResponsiveSheetTitle>
					<ResponsiveSheetDescription>
						{target.date} · {target.roomType.name} · тариф {target.ratePlan.code}
					</ResponsiveSheetDescription>
				</ResponsiveSheetHeader>

				<form
					onSubmit={(e) => {
						e.preventDefault()
						e.stopPropagation()
						void form.handleSubmit()
					}}
					className="space-y-4 px-4 pb-4"
					noValidate
				>
					{submitError ? (
						<div
							role="alert"
							className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
						>
							{submitError}
						</div>
					) : null}

					<form.Field
						name="price"
						validators={{
							onChange: ({ value }) =>
								formSchema.shape.price.safeParse(value).error?.issues[0]?.message,
						}}
					>
						{(field) => (
							<Field data-invalid={field.state.meta.errors.length > 0 ? '' : undefined}>
								<FieldLabel htmlFor={field.name}>Цена за ночь, ₽</FieldLabel>
								<Input
									id={field.name}
									type="number"
									inputMode="decimal"
									step="0.01"
									min={0}
									value={field.state.value}
									onChange={(e) => field.handleChange(e.target.value)}
									autoFocus
								/>
								{field.state.meta.errors[0] ? (
									<FieldError>{String(field.state.meta.errors[0])}</FieldError>
								) : null}
							</Field>
						)}
					</form.Field>

					<ResponsiveSheetFooter className="mt-2 flex-wrap gap-2 px-0">
						<Button
							type="button"
							variant="ghost"
							onClick={handleDelete}
							disabled={isPending || target.currentAmount === undefined}
							className="text-destructive hover:bg-destructive/10"
						>
							Удалить цену
						</Button>
						<div className="ml-auto flex gap-2">
							<Button
								type="button"
								variant="outline"
								onClick={() => onOpenChange(false)}
								disabled={isPending}
							>
								Отмена
							</Button>
							<Button type="submit" disabled={isPending}>
								{isPending ? 'Сохраняем…' : 'Сохранить'}
							</Button>
						</div>
					</ResponsiveSheetFooter>
				</form>
			</ResponsiveSheetContent>
		</ResponsiveSheet>
	)
}
