/**
 * `<BulkEditPricesSheet>` — Bnovo «Цены и ограничения» canonical RU
 * pattern (research 2026-05-14, Bnovo update 01.05.2026):
 *
 *   1. Date range — from/to (both required).
 *   2. Day-of-week multi-select (default all 7 ON).
 *   3. Rate plan multi-select (at least 1).
 *   4. Action: set price (absolute) — relative ops deferred к bis.
 *
 * Submit fans out N parallel POST `/rate-plans/:id/rates` calls (one per
 * selected ratePlan) с the matching date subset, each call within the
 * 365-rate `rateBulkUpsertInput.max` cap (date-range × 1 plan ≤ 365).
 * Per-ratePlan success/failure surfaced inline.
 */
import { useForm } from '@tanstack/react-form'
import type { RatePlan, RoomType } from '@horeca/shared'
import { useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { Button } from '../../../components/ui/button.tsx'
import { Checkbox } from '../../../components/ui/checkbox.tsx'
import { Field, FieldDescription, FieldError, FieldLabel } from '../../../components/ui/field.tsx'
import { Input } from '../../../components/ui/input.tsx'
import {
	ResponsiveSheet,
	ResponsiveSheetContent,
	ResponsiveSheetDescription,
	ResponsiveSheetFooter,
	ResponsiveSheetHeader,
	ResponsiveSheetTitle,
} from '../../../components/ui/responsive-sheet.tsx'
import { generateDatesInRange, isoDateOffset, useBulkUpsertRates } from '../hooks/use-rates.ts'

interface FormValues {
	from: string
	to: string
	dow: ReadonlyArray<boolean>
	ratePlanIds: ReadonlyArray<string>
	price: string
}

const formSchema = z.object({
	from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
	to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
	price: z.string().regex(/^\d+(\.\d{1,2})?$/, 'Число, до 2 знаков после точки'),
})

/**
 * RU week order ПН-ВТ-СР-ЧТ-ПТ-СБ-ВС, matching Bnovo + 1С:Отель display.
 * JS `Date.getDay()` returns 0=Sun, 1=Mon, .., 6=Sat, so the array index
 * 0 maps to ПН (JS day 1), index 6 → ВС (JS day 0). Mapping:
 *   [ПН=1, ВТ=2, СР=3, ЧТ=4, ПТ=5, СБ=6, ВС=0]
 */
const DOW_LABELS_RU = ['ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ', 'ВС'] as const
const DOW_JS_BY_INDEX = [1, 2, 3, 4, 5, 6, 0] as const

export interface BulkEditPricesSheetProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	ratePlans: ReadonlyArray<RatePlan>
	roomTypes: ReadonlyArray<RoomType>
}

export function BulkEditPricesSheet({
	open,
	onOpenChange,
	ratePlans,
	roomTypes,
}: BulkEditPricesSheetProps) {
	const [result, setResult] = useState<{ updated: number; failedPlans: string[] } | null>(null)
	const bulk = useBulkUpsertRates()

	const roomTypeNameById = new Map(roomTypes.map((rt) => [rt.id, rt.name] as const))

	const form = useForm({
		defaultValues: {
			from: isoDateOffset(0),
			to: isoDateOffset(89),
			dow: [true, true, true, true, true, true, true] as ReadonlyArray<boolean>,
			ratePlanIds: ratePlans.map((p) => p.id) as ReadonlyArray<string>,
			price: '4000',
		} satisfies FormValues,
		onSubmit: async ({ value }) => {
			setResult(null)
			const allowedJsDow = new Set(
				value.dow.flatMap((on, idx) => (on ? [DOW_JS_BY_INDEX[idx] ?? -1] : [])),
			)
			const dates = generateDatesInRange(value.from, value.to, allowedJsDow)
			if (dates.length === 0) {
				toast.error('Под выбранные дни в диапазоне дат не попадает ни одна дата')
				return
			}
			if (value.ratePlanIds.length === 0) {
				toast.error('Выберите хотя бы один тариф')
				return
			}
			const amount = value.price
			const failedPlans: string[] = []
			let totalUpdated = 0
			const tasks = value.ratePlanIds.map(async (ratePlanId) => {
				try {
					const updated = await bulk.mutateAsync({
						ratePlanId,
						input: {
							rates: dates.map((date) => ({ date, amount, currency: 'RUB' })),
						},
					})
					totalUpdated += updated.length
				} catch (err) {
					failedPlans.push(`${ratePlanId}: ${err instanceof Error ? err.message : String(err)}`)
				}
			})
			await Promise.all(tasks)
			setResult({ updated: totalUpdated, failedPlans })
			if (failedPlans.length === 0) {
				toast.success(`Обновлено ${totalUpdated} ячеек`)
				onOpenChange(false)
			} else {
				toast.warning(`Обновлено ${totalUpdated}, не удалось ${failedPlans.length} тарифов`)
			}
		},
	})

	return (
		<ResponsiveSheet open={open} onOpenChange={onOpenChange}>
			<ResponsiveSheetContent side="right" className="sm:max-w-lg">
				<ResponsiveSheetHeader>
					<ResponsiveSheetTitle>Изменить цены</ResponsiveSheetTitle>
					<ResponsiveSheetDescription>
						Выберите даты, дни недели и тарифы — установим одну цену для всех попавших ячеек.
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
					<div className="grid grid-cols-2 gap-3">
						<form.Field
							name="from"
							validators={{
								onChange: ({ value }) =>
									formSchema.shape.from.safeParse(value).error?.issues[0]?.message,
							}}
						>
							{(field) => (
								<Field data-invalid={field.state.meta.errors.length > 0 ? '' : undefined}>
									<FieldLabel htmlFor={field.name}>С даты</FieldLabel>
									<Input
										id={field.name}
										type="date"
										value={field.state.value}
										onChange={(e) => field.handleChange(e.target.value)}
									/>
									{field.state.meta.errors[0] ? (
										<FieldError>{String(field.state.meta.errors[0])}</FieldError>
									) : null}
								</Field>
							)}
						</form.Field>
						<form.Field
							name="to"
							validators={{
								onChange: ({ value }) =>
									formSchema.shape.to.safeParse(value).error?.issues[0]?.message,
							}}
						>
							{(field) => (
								<Field data-invalid={field.state.meta.errors.length > 0 ? '' : undefined}>
									<FieldLabel htmlFor={field.name}>По дату</FieldLabel>
									<Input
										id={field.name}
										type="date"
										value={field.state.value}
										onChange={(e) => field.handleChange(e.target.value)}
									/>
									{field.state.meta.errors[0] ? (
										<FieldError>{String(field.state.meta.errors[0])}</FieldError>
									) : null}
								</Field>
							)}
						</form.Field>
					</div>

					<form.Field name="dow">
						{(field) => (
							<fieldset className="space-y-2">
								<legend className="text-sm font-medium">Дни недели</legend>
								<div className="flex flex-wrap gap-3 text-sm">
									{DOW_LABELS_RU.map((label, idx) => {
										const id = `bulk-dow-${idx}`
										const checked = field.state.value[idx] ?? false
										return (
											<div key={label} className="flex items-center gap-1.5">
												<Checkbox
													id={id}
													checked={checked}
													onCheckedChange={(c) => {
														const next = field.state.value.slice() as boolean[]
														next[idx] = c === true
														field.handleChange(next)
													}}
												/>
												<label htmlFor={id} className="cursor-pointer font-medium">
													{label}
												</label>
											</div>
										)
									})}
								</div>
							</fieldset>
						)}
					</form.Field>

					<form.Field name="ratePlanIds">
						{(field) => (
							<fieldset className="space-y-2">
								<legend className="text-sm font-medium">Тарифы</legend>
								<div className="flex flex-col gap-2 text-sm">
									{ratePlans.map((plan) => {
										const id = `bulk-rp-${plan.id}`
										const checked = field.state.value.includes(plan.id)
										return (
											<div key={plan.id} className="flex items-center gap-2">
												<Checkbox
													id={id}
													checked={checked}
													onCheckedChange={(c) => {
														const next =
															c === true
																? Array.from(new Set([...field.state.value, plan.id]))
																: field.state.value.filter((x) => x !== plan.id)
														field.handleChange(next)
													}}
												/>
												<label htmlFor={id} className="cursor-pointer">
													<span className="font-medium">{plan.name}</span>{' '}
													<span className="text-xs text-muted-foreground">
														({roomTypeNameById.get(plan.roomTypeId) ?? '—'} · {plan.code})
													</span>
												</label>
											</div>
										)
									})}
								</div>
								<FieldDescription>
									Минимум один тариф. Выбрано: {field.state.value.length} из {ratePlans.length}.
								</FieldDescription>
							</fieldset>
						)}
					</form.Field>

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
									placeholder="4500"
								/>
								{field.state.meta.errors[0] ? (
									<FieldError>{String(field.state.meta.errors[0])}</FieldError>
								) : null}
								<FieldDescription>
									Применится ко всем выбранным ячейкам (дата × тариф). Относительные операции (+%,
									+сумма) — в следующей версии.
								</FieldDescription>
							</Field>
						)}
					</form.Field>

					{result && result.failedPlans.length > 0 ? (
						<div
							role="alert"
							className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
						>
							<p className="font-medium">
								Обновлено {result.updated}, не удалось {result.failedPlans.length} тарифов:
							</p>
							<ul className="mt-1 list-disc pl-5">
								{result.failedPlans.map((f) => (
									<li key={f}>{f}</li>
								))}
							</ul>
						</div>
					) : null}

					<ResponsiveSheetFooter className="mt-2 px-0">
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
							disabled={bulk.isPending}
						>
							Отмена
						</Button>
						<Button type="submit" disabled={bulk.isPending || ratePlans.length === 0}>
							{bulk.isPending ? 'Применяем…' : 'Применить цену'}
						</Button>
					</ResponsiveSheetFooter>
				</form>
			</ResponsiveSheetContent>
		</ResponsiveSheet>
	)
}
