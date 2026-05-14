/**
 * `<RatePlanFormSheet>` — RatePlan create OR edit. Mode is implicit via
 * `existing` prop (null/undefined = create, RatePlan = edit). DRY canon:
 * one form definition, two submit paths.
 *
 * Pre-done audit:
 *   - [R1] mode='create' — empty defaults; submit calls useCreateRatePlan
 *   - [R2] mode='edit' — pre-filled from `existing`; submit calls useUpdateRatePlan
 *   - [F1] cancellationHours field appears only when isRefundable=true
 *          (server refines: refundable → cancellationHours required).
 *   - [F2] Code field uppercase + canonical regex (server-side mirror).
 *   - [A1] `<ResponsiveSheetTitle>` обязателен; varies by mode.
 */
import { useForm } from '@tanstack/react-form'
import type { MealsIncluded, RatePlan, RoomType } from '@horeca/shared'
import { useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { Button } from '../../../components/ui/button.tsx'
import { Checkbox } from '../../../components/ui/checkbox.tsx'
import { Field, FieldLabel } from '../../../components/ui/field.tsx'
import { Input } from '../../../components/ui/input.tsx'
import {
	ResponsiveSheet,
	ResponsiveSheetContent,
	ResponsiveSheetDescription,
	ResponsiveSheetFooter,
	ResponsiveSheetHeader,
	ResponsiveSheetTitle,
} from '../../../components/ui/responsive-sheet.tsx'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '../../../components/ui/select.tsx'
import { useCreateRatePlan, useUpdateRatePlan } from '../hooks/use-rate-plans.ts'

interface FormValues {
	name: string
	code: string
	roomTypeId: string
	isRefundable: boolean
	cancellationHours: string
	mealsIncluded: MealsIncluded
	minStay: string
}

const codeRegex = /^[A-Z][A-Z0-9_-]*$/

const formSchema = z.object({
	name: z.string().min(1, 'Введите название').max(200, 'Не более 200 символов'),
	code: z.string().regex(codeRegex, 'Только заглавные буквы, цифры, «-» и «_»; начинается с буквы'),
	roomTypeId: z.string().min(1, 'Выберите категорию'),
	cancellationHours: z.string().regex(/^\d+$/, 'Целое число').optional().or(z.literal('')),
	minStay: z.string().regex(/^\d+$/, 'Целое число'),
})

const MEAL_LABELS: Record<MealsIncluded, string> = {
	none: 'Без питания',
	breakfast: 'Завтрак',
	halfBoard: 'Полупансион',
	fullBoard: 'Полный пансион',
	allInclusive: 'Всё включено',
}

export interface RatePlanFormSheetProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	propertyId: string
	roomTypes: ReadonlyArray<RoomType>
	/** When provided → edit mode. Otherwise → create. */
	existing?: RatePlan | null
}

export function RatePlanFormSheet({
	open,
	onOpenChange,
	propertyId,
	roomTypes,
	existing,
}: RatePlanFormSheetProps) {
	const [submitError, setSubmitError] = useState<string | null>(null)
	const create = useCreateRatePlan(propertyId)
	const update = useUpdateRatePlan(propertyId)
	const isEdit = existing != null
	const isPending = create.isPending || update.isPending

	const form = useForm({
		defaultValues: {
			name: existing?.name ?? '',
			code: existing?.code ?? '',
			roomTypeId: existing?.roomTypeId ?? roomTypes[0]?.id ?? '',
			isRefundable: (existing?.isRefundable ?? true) as boolean,
			cancellationHours: String(existing?.cancellationHours ?? 24),
			mealsIncluded: (existing?.mealsIncluded ?? 'none') as MealsIncluded,
			minStay: String(existing?.minStay ?? 1),
		} satisfies FormValues,
		onSubmit: async ({ value }) => {
			setSubmitError(null)
			try {
				if (isEdit && existing) {
					await update.mutateAsync({
						id: existing.id,
						patch: {
							name: value.name.trim(),
							code: value.code.trim().toUpperCase(),
							isRefundable: value.isRefundable,
							cancellationHours: value.isRefundable ? Number(value.cancellationHours) : null,
							mealsIncluded: value.mealsIncluded,
							minStay: Number(value.minStay),
						},
					})
					toast.success('Тариф обновлён')
				} else {
					await create.mutateAsync({
						roomTypeId: value.roomTypeId,
						name: value.name.trim(),
						code: value.code.trim().toUpperCase(),
						isDefault: false,
						isRefundable: value.isRefundable,
						...(value.isRefundable ? { cancellationHours: Number(value.cancellationHours) } : {}),
						mealsIncluded: value.mealsIncluded,
						minStay: Number(value.minStay),
						currency: 'RUB',
					})
					toast.success('Тариф создан')
				}
				form.reset()
				onOpenChange(false)
			} catch (err) {
				setSubmitError(err instanceof Error ? err.message : String(err))
			}
		},
	})

	return (
		<ResponsiveSheet open={open} onOpenChange={onOpenChange}>
			<ResponsiveSheetContent side="right" className="sm:max-w-md">
				<ResponsiveSheetHeader>
					<ResponsiveSheetTitle>
						{isEdit ? `Изменить «${existing?.name}»` : 'Новый тариф'}
					</ResponsiveSheetTitle>
					<ResponsiveSheetDescription>
						{isEdit
							? 'Условия отмены, питание, минимум ночей. Категорию изменить нельзя — создайте новый тариф если нужна другая категория.'
							: 'Шаблон цены и условий: возвратность, питание, минимум ночей. Цены за конкретные даты — на странице «Цены и ограничения».'}
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
						name="name"
						validators={{
							onChange: ({ value }) =>
								formSchema.shape.name.safeParse(value).error?.issues[0]?.message,
						}}
					>
						{(field) => (
							<Field>
								<FieldLabel htmlFor={field.name}>Название</FieldLabel>
								<Input
									id={field.name}
									value={field.state.value}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder="Базовый, Невозвратный, Завтрак включён…"
									autoComplete="off"
									required
								/>
							</Field>
						)}
					</form.Field>

					<div className="grid grid-cols-2 gap-3">
						<form.Field
							name="code"
							validators={{
								onChange: ({ value }) =>
									formSchema.shape.code.safeParse(value).error?.issues[0]?.message,
							}}
						>
							{(field) => (
								<Field>
									<FieldLabel htmlFor={field.name}>Код тарифа</FieldLabel>
									<Input
										id={field.name}
										value={field.state.value}
										onChange={(e) => field.handleChange(e.target.value.toUpperCase())}
										onBlur={() => field.handleChange(field.state.value.trim().toUpperCase())}
										placeholder="BASE"
										autoComplete="off"
										required
									/>
								</Field>
							)}
						</form.Field>
						<form.Field name="roomTypeId">
							{(field) => (
								<Field>
									<FieldLabel htmlFor={field.name}>Категория</FieldLabel>
									<Select
										value={field.state.value}
										onValueChange={(v) => field.handleChange(v)}
										disabled={isEdit}
									>
										<SelectTrigger id={field.name}>
											<SelectValue placeholder="Выберите категорию" />
										</SelectTrigger>
										<SelectContent>
											{roomTypes.map((rt) => (
												<SelectItem key={rt.id} value={rt.id}>
													{rt.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</Field>
							)}
						</form.Field>
					</div>

					<form.Field name="isRefundable">
						{(field) => (
							<div className="flex items-center gap-2 text-sm">
								<Checkbox
									id={field.name}
									checked={field.state.value}
									onCheckedChange={(c) => field.handleChange(c === true)}
								/>
								<label htmlFor={field.name} className="cursor-pointer">
									Возвратный (можно отменить бронирование)
								</label>
							</div>
						)}
					</form.Field>

					<form.Subscribe selector={(s) => s.values.isRefundable}>
						{(isRefundable) =>
							isRefundable ? (
								<form.Field
									name="cancellationHours"
									validators={{
										onChange: ({ value }) =>
											formSchema.shape.cancellationHours.safeParse(value).error?.issues[0]?.message,
									}}
								>
									{(field) => (
										<Field>
											<FieldLabel htmlFor={field.name}>
												За сколько часов до заезда возможна бесплатная отмена
											</FieldLabel>
											<Input
												id={field.name}
												type="number"
												inputMode="numeric"
												min={0}
												max={720}
												value={field.state.value}
												onChange={(e) => field.handleChange(e.target.value)}
											/>
										</Field>
									)}
								</form.Field>
							) : null
						}
					</form.Subscribe>

					<div className="grid grid-cols-2 gap-3">
						<form.Field name="mealsIncluded">
							{(field) => (
								<Field>
									<FieldLabel htmlFor={field.name}>Питание</FieldLabel>
									<Select
										value={field.state.value}
										onValueChange={(v) => field.handleChange(v as MealsIncluded)}
									>
										<SelectTrigger id={field.name}>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{(Object.keys(MEAL_LABELS) as MealsIncluded[]).map((m) => (
												<SelectItem key={m} value={m}>
													{MEAL_LABELS[m]}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</Field>
							)}
						</form.Field>
						<form.Field
							name="minStay"
							validators={{
								onChange: ({ value }) =>
									formSchema.shape.minStay.safeParse(value).error?.issues[0]?.message,
							}}
						>
							{(field) => (
								<Field>
									<FieldLabel htmlFor={field.name}>Мин. ночей</FieldLabel>
									<Input
										id={field.name}
										type="number"
										inputMode="numeric"
										min={1}
										max={30}
										value={field.state.value}
										onChange={(e) => field.handleChange(e.target.value)}
									/>
								</Field>
							)}
						</form.Field>
					</div>

					<ResponsiveSheetFooter className="mt-2 px-0">
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
							disabled={isPending}
						>
							Отмена
						</Button>
						<Button type="submit" disabled={isPending || roomTypes.length === 0}>
							{isPending ? 'Сохраняем…' : isEdit ? 'Сохранить' : 'Создать тариф'}
						</Button>
					</ResponsiveSheetFooter>
				</form>
			</ResponsiveSheetContent>
		</ResponsiveSheet>
	)
}
