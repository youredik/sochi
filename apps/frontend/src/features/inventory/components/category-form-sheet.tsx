/**
 * `<CategoryFormSheet>` — create a new RoomType. Side-Sheet с TanStack Form,
 * mirroring the canonical CRUD-drawer pattern from
 * `features/folios/refund-sheet.tsx` (memory `m6_7_frontend_canonical`).
 *
 * Pre-done audit:
 *   - [R1] Hidden when `open=false`; renders когда `open=true`.
 *   - [F1] Submit disabled until name/maxOccupancy/baseBeds/inventoryCount filled.
 *   - [F2] On submit → `useCreateRoomType(propertyId).mutate` с trimmed name.
 *   - [F3] Success → onOpenChange(false) + toast «Категория создана».
 *   - [F4] Error → inline banner с err.message (fail-soft, не закрывает sheet).
 *   - [A1] Required: `<ResponsiveSheetTitle>` (Radix throws on missing).
 *   - [A2] `aria-describedby` paired с the slug-preview-helper id.
 */
import { useForm } from '@tanstack/react-form'
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
import { useCreateRoomType } from '../hooks/use-room-types.ts'

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
}

export function CategoryFormSheet({ open, onOpenChange, propertyId }: CategoryFormSheetProps) {
	const errorId = useId()
	const [submitError, setSubmitError] = useState<string | null>(null)
	const create = useCreateRoomType(propertyId)

	const form = useForm({
		defaultValues: {
			name: '',
			description: '',
			maxOccupancy: '2',
			baseBeds: '1',
			inventoryCount: '1',
		} satisfies FormValues,
		onSubmit: async ({ value }) => {
			setSubmitError(null)
			try {
				await create.mutateAsync({
					name: value.name.trim(),
					description: value.description.trim() === '' ? undefined : value.description.trim(),
					maxOccupancy: Number(value.maxOccupancy),
					baseBeds: Number(value.baseBeds),
					extraBeds: 0,
					inventoryCount: Number(value.inventoryCount),
				})
				toast.success('Категория создана')
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
					<ResponsiveSheetTitle>Новая категория номеров</ResponsiveSheetTitle>
					<ResponsiveSheetDescription>
						Например: «Стандартный», «Полулюкс», «Сюит». Можно создать несколько и поделить номера
						между ними.
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
								<Field>
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
								<Field>
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
								<Field>
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
							disabled={create.isPending}
						>
							Отмена
						</Button>
						<Button type="submit" disabled={create.isPending}>
							{create.isPending ? 'Создаём…' : 'Создать категорию'}
						</Button>
					</ResponsiveSheetFooter>
				</form>
			</ResponsiveSheetContent>
		</ResponsiveSheet>
	)
}
