/**
 * `<RoomsBulkAddSheet>` — bulk-add a contiguous range of rooms к a chosen
 * RoomType. Mirrors Bnovo / Cloudbeds / Mews «add rooms 201..210» pattern
 * (research 2026-05-14): single drawer, one form, partial-failure surfacing.
 *
 * Pre-done audit:
 *   - [R1] Hidden when open=false; renders когда open=true.
 *   - [F1] Submit disabled until startNumber/endNumber filled и valid.
 *   - [F2] On submit → `useBulkCreateRooms.mutate` с Promise.allSettled fanout.
 *   - [F3] Result shows N created + per-failure rows («номер 207 уже занят»).
 *   - [F4] Validation: endNumber ≥ startNumber; cap 500 per call.
 *   - [A1] `<ResponsiveSheetTitle>` обязателен.
 */
import { useForm, useStore } from '@tanstack/react-form'
import type { RoomType } from '@horeca/shared'
import { useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { Button } from '../../../components/ui/button.tsx'
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
import { useBulkCreateRooms } from '../hooks/use-rooms.ts'
import { intRangeFieldSchema } from '../../../lib/forms/int-range-field-schema.ts'

interface FormValues {
	startNumber: string
	endNumber: string
	floor: string
}

// `floor` bound mirrors `packages/shared/src/room.ts` `floorSchema =
// z.coerce.number().int().min(-5).max(50)`. allowEmpty: true because the
// field is documented as «Если пусто — этаж не присваивается».
// startNumber/endNumber upper bound semantic = практический room-number cap
// (resulting string must satisfy `roomNumberSchema` ≤20 chars + bulk-range
// ≤500); separate backlog item — needs cross-field refine.
const formSchema = z.object({
	startNumber: z
		.string()
		.regex(/^\d+$/, 'Целое число')
		.refine((v) => Number(v) >= 1, 'Минимум 1'),
	endNumber: z
		.string()
		.regex(/^\d+$/, 'Целое число')
		.refine((v) => Number(v) >= 1, 'Минимум 1'),
	floor: intRangeFieldSchema({ min: -5, max: 50, allowEmpty: true }),
})

export interface RoomsBulkAddSheetProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	propertyId: string
	roomType: RoomType | null
}

export function RoomsBulkAddSheet({
	open,
	onOpenChange,
	propertyId,
	roomType,
}: RoomsBulkAddSheetProps) {
	const [result, setResult] = useState<{
		created: number
		failed: ReadonlyArray<{ number: string; error: string }>
	} | null>(null)
	const bulk = useBulkCreateRooms(propertyId)

	const form = useForm({
		defaultValues: {
			startNumber: '',
			endNumber: '',
			floor: '1',
		} satisfies FormValues,
		onSubmit: async ({ value }) => {
			if (!roomType) return
			setResult(null)
			const start = Number(value.startNumber)
			const end = Number(value.endNumber)
			const floor = value.floor.trim() === '' ? undefined : Number(value.floor)
			try {
				const res = await bulk.mutateAsync({
					roomTypeId: roomType.id,
					startNumber: start,
					endNumber: end,
					...(floor !== undefined ? { floor } : {}),
				})
				setResult({ created: res.created.length, failed: res.failed })
				if (res.failed.length === 0) {
					toast.success(`Создано ${res.created.length} номеров`)
					form.reset()
					onOpenChange(false)
				} else {
					toast.warning(`Создано ${res.created.length}, не удалось ${res.failed.length}`)
				}
			} catch (err) {
				toast.error(err instanceof Error ? err.message : 'Не удалось создать номера')
			}
		},
	})

	// Reactive computation — subscribes к the store so rangeSize re-renders
	// when user types. Reading `form.state.values` directly captures only the
	// snapshot at first render (bug: submit button stays «Создать номеров» с
	// rangeSize=0 forever).
	const rangeSize = useStore(form.store, (state) => {
		const a = Number(state.values.startNumber)
		const b = Number(state.values.endNumber)
		if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a) return 0
		return b - a + 1
	})

	return (
		<ResponsiveSheet open={open} onOpenChange={onOpenChange}>
			<ResponsiveSheetContent side="right" className="sm:max-w-md">
				<ResponsiveSheetHeader>
					<ResponsiveSheetTitle>
						Добавить номера {roomType ? `в категорию «${roomType.name}»` : ''}
					</ResponsiveSheetTitle>
					<ResponsiveSheetDescription>
						Введите диапазон, например 201 и 210 — создадим 10 номеров с этими номерами на 2-м
						этаже.
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
							name="startNumber"
							validators={{
								onChange: ({ value }) =>
									formSchema.shape.startNumber.safeParse(value).error?.issues[0]?.message,
							}}
						>
							{(field) => (
								<Field data-invalid={field.state.meta.errors.length > 0 ? '' : undefined}>
									<FieldLabel htmlFor={field.name}>Первый номер</FieldLabel>
									<Input
										id={field.name}
										type="number"
										inputMode="numeric"
										min={1}
										value={field.state.value}
										onChange={(e) => field.handleChange(e.target.value)}
										placeholder="201"
									/>
									{field.state.meta.errors[0] ? (
										<FieldError>{String(field.state.meta.errors[0])}</FieldError>
									) : null}
								</Field>
							)}
						</form.Field>
						<form.Field
							name="endNumber"
							validators={{
								onChange: ({ value }) =>
									formSchema.shape.endNumber.safeParse(value).error?.issues[0]?.message,
							}}
						>
							{(field) => (
								<Field data-invalid={field.state.meta.errors.length > 0 ? '' : undefined}>
									<FieldLabel htmlFor={field.name}>Последний номер</FieldLabel>
									<Input
										id={field.name}
										type="number"
										inputMode="numeric"
										min={1}
										value={field.state.value}
										onChange={(e) => field.handleChange(e.target.value)}
										placeholder="210"
									/>
									{field.state.meta.errors[0] ? (
										<FieldError>{String(field.state.meta.errors[0])}</FieldError>
									) : null}
								</Field>
							)}
						</form.Field>
					</div>

					<form.Field
						name="floor"
						validators={{
							onChange: ({ value }) =>
								formSchema.shape.floor.safeParse(value).error?.issues[0]?.message,
						}}
					>
						{(field) => (
							<Field data-invalid={field.state.meta.errors.length > 0 ? '' : undefined}>
								<FieldLabel htmlFor={field.name}>Этаж (необязательно)</FieldLabel>
								<Input
									id={field.name}
									type="number"
									inputMode="numeric"
									min={-5}
									max={50}
									value={field.state.value}
									onChange={(e) => field.handleChange(e.target.value)}
								/>
								<FieldDescription>
									Если пусто — этаж не присваивается, заполнишь позже.
								</FieldDescription>
								{field.state.meta.errors[0] ? (
									<FieldError>{String(field.state.meta.errors[0])}</FieldError>
								) : null}
							</Field>
						)}
					</form.Field>

					{rangeSize > 0 ? (
						<p className="text-sm text-muted-foreground">
							Будет создано <span className="font-medium">{rangeSize}</span>{' '}
							{rangeSize === 1 ? 'номер' : 'номеров'}.
						</p>
					) : null}

					{result && result.failed.length > 0 ? (
						<div
							role="alert"
							className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
						>
							<p className="font-medium">
								Создано {result.created}, не удалось {result.failed.length}:
							</p>
							<ul className="mt-1 list-disc pl-5">
								{result.failed.map((f) => (
									<li key={f.number}>
										{f.number} — {f.error}
									</li>
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
						<Button type="submit" disabled={bulk.isPending || rangeSize === 0 || !roomType}>
							{bulk.isPending
								? 'Создаём…'
								: `Создать ${rangeSize || ''} ${rangeSize === 1 ? 'номер' : 'номеров'}`}
						</Button>
					</ResponsiveSheetFooter>
				</form>
			</ResponsiveSheetContent>
		</ResponsiveSheet>
	)
}
