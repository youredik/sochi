/**
 * `<CategoryFormSheet>` — RoomType create OR edit. Mode is implicit via
 * `existing` prop (null/undefined = create, RoomType = edit). DRY canon:
 * one form definition, two submit paths.
 *
 * Pre-done audit:
 *   - [R1] mode='create' — empty defaults; submit calls useCreateRoomType
 *   - [R2] mode='edit' — pre-filled from `existing`; submit calls useUpdateRoomType
 *          (patch с only changed fields by sending whole object)
 *   - [F1] Submit disabled while pending.
 *   - [F2] On success → onOpenChange(false) + toast.
 *   - [F3] Error → inline banner.
 *   - [A1] `<ResponsiveSheetTitle>` обязателен; varies by mode.
 */
import { useForm } from '@tanstack/react-form'
import type { RoomType } from '@horeca/shared'
import { useId, useState } from 'react'
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
import { Textarea } from '../../../components/ui/textarea.tsx'
import { useCreateRoomType, useUpdateRoomType } from '../hooks/use-room-types.ts'

interface FormValues {
	name: string
	description: string
	maxOccupancy: string
	baseBeds: string
	inventoryCount: string
}

const formSchema = z.object({
	name: z.string().min(1, 'Введите название').max(100, 'Не более 100 символов'),
	description: z.string().max(2000, 'Не более 2000 символов'),
	maxOccupancy: z.string().regex(/^\d+$/, 'Целое число'),
	baseBeds: z.string().regex(/^\d+$/, 'Целое число'),
	inventoryCount: z.string().regex(/^\d+$/, 'Целое число'),
})

export interface CategoryFormSheetProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	propertyId: string
	/** When provided → edit mode. Otherwise → create. */
	existing?: RoomType | null
}

export function CategoryFormSheet({
	open,
	onOpenChange,
	propertyId,
	existing,
}: CategoryFormSheetProps) {
	const errorId = useId()
	const [submitError, setSubmitError] = useState<string | null>(null)
	const create = useCreateRoomType(propertyId)
	const update = useUpdateRoomType(propertyId)
	const isEdit = existing != null
	const isPending = create.isPending || update.isPending

	const form = useForm({
		defaultValues: {
			name: existing?.name ?? '',
			description: existing?.description ?? '',
			maxOccupancy: String(existing?.maxOccupancy ?? 2),
			baseBeds: String(existing?.baseBeds ?? 1),
			inventoryCount: String(existing?.inventoryCount ?? 1),
		} satisfies FormValues,
		onSubmit: async ({ value }) => {
			setSubmitError(null)
			try {
				const payload = {
					name: value.name.trim(),
					description: value.description.trim() === '' ? undefined : value.description.trim(),
					maxOccupancy: Number(value.maxOccupancy),
					baseBeds: Number(value.baseBeds),
					extraBeds: existing?.extraBeds ?? 0,
					inventoryCount: Number(value.inventoryCount),
				}
				if (isEdit && existing) {
					await update.mutateAsync({ id: existing.id, patch: payload })
					toast.success('Категория обновлена')
				} else {
					await create.mutateAsync(payload)
					toast.success('Категория создана')
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
						{isEdit ? `Изменить «${existing?.name}»` : 'Новая категория номеров'}
					</ResponsiveSheetTitle>
					<ResponsiveSheetDescription>
						{isEdit
							? 'Поменяйте название, вместимость или количество мест.'
							: 'Например: «Стандартный», «Полулюкс», «Сюит».'}
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
							id={errorId}
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
							<Field data-invalid={field.state.meta.errors.length > 0 ? '' : undefined}>
								<FieldLabel htmlFor={field.name}>Название категории</FieldLabel>
								<Input
									id={field.name}
									type="text"
									value={field.state.value}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder="Стандартный"
									autoComplete="off"
									required
								/>
								{field.state.meta.errors[0] ? (
									<FieldError>{String(field.state.meta.errors[0])}</FieldError>
								) : null}
							</Field>
						)}
					</form.Field>

					<div className="grid grid-cols-3 gap-3">
						<form.Field
							name="maxOccupancy"
							validators={{
								onChange: ({ value }) =>
									formSchema.shape.maxOccupancy.safeParse(value).error?.issues[0]?.message,
							}}
						>
							{(field) => (
								<Field data-invalid={field.state.meta.errors.length > 0 ? '' : undefined}>
									<FieldLabel htmlFor={field.name}>Гостей</FieldLabel>
									<Input
										id={field.name}
										type="number"
										inputMode="numeric"
										min={1}
										max={20}
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
							name="baseBeds"
							validators={{
								onChange: ({ value }) =>
									formSchema.shape.baseBeds.safeParse(value).error?.issues[0]?.message,
							}}
						>
							{(field) => (
								<Field data-invalid={field.state.meta.errors.length > 0 ? '' : undefined}>
									<FieldLabel htmlFor={field.name}>Кроватей</FieldLabel>
									<Input
										id={field.name}
										type="number"
										inputMode="numeric"
										min={1}
										max={10}
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
							name="inventoryCount"
							validators={{
								onChange: ({ value }) =>
									formSchema.shape.inventoryCount.safeParse(value).error?.issues[0]?.message,
							}}
						>
							{(field) => (
								<Field data-invalid={field.state.meta.errors.length > 0 ? '' : undefined}>
									<FieldLabel htmlFor={field.name}>Сколько номеров</FieldLabel>
									<Input
										id={field.name}
										type="number"
										inputMode="numeric"
										min={0}
										max={500}
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

					<form.Field name="description">
						{(field) => (
							<Field>
								<FieldLabel htmlFor={field.name}>Описание (необязательно)</FieldLabel>
								<Textarea
									id={field.name}
									rows={3}
									maxLength={2000}
									value={field.state.value}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder="Уютный номер с видом на море…"
								/>
							</Field>
						)}
					</form.Field>

					<ResponsiveSheetFooter className="mt-2 px-0">
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
							disabled={isPending}
						>
							Отмена
						</Button>
						<Button type="submit" disabled={isPending}>
							{isPending ? 'Сохраняем…' : isEdit ? 'Сохранить' : 'Создать категорию'}
						</Button>
					</ResponsiveSheetFooter>
				</form>
			</ResponsiveSheetContent>
		</ResponsiveSheet>
	)
}
