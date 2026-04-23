import { useForm } from '@tanstack/react-form'
import { Button } from '@/components/ui/button'
import { TextField } from '../../forms/text-field'
import { useCreateRoomType } from '../hooks/use-setup-mutations'
import { useWizardStore } from '../wizard-store'

/**
 * Step 2 — room type. Creates an ARI-style room category (Standard,
 * Comfort, Suite…) under the just-created property. `inventoryCount`
 * is the physical unit count we allocate availability against; rooms
 * in step 3 are individual unit labels (204, 306A…) that check against
 * this.
 */
export function RoomTypeStep() {
	const propertyId = useWizardStore((s) => s.propertyId)
	const createRoomType = useCreateRoomType(propertyId)
	const setRoomTypeId = useWizardStore((s) => s.setRoomTypeId)

	const form = useForm({
		defaultValues: {
			name: 'Стандарт',
			maxOccupancy: 2,
			baseBeds: 2,
			extraBeds: 0,
			inventoryCount: 1,
		},
		// Server-side Zod (@hono/zod-validator) is the authoritative gate —
		// see property-step for rationale on skipping client validators.
		onSubmit: async ({ value }) => {
			const created = await createRoomType.mutateAsync(value)
			setRoomTypeId(created.id, value.inventoryCount)
		},
	})

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault()
				void form.handleSubmit()
			}}
			className="space-y-4"
			noValidate
		>
			<form.Field name="name">
				{(field) => (
					<TextField
						field={field}
						label="Название типа"
						placeholder="Стандарт / Люкс / Апартаменты"
					/>
				)}
			</form.Field>

			<div className="grid grid-cols-2 gap-4">
				<form.Field name="maxOccupancy">
					{(field) => (
						<TextField field={field} label="Макс. гостей" type="number" min={1} max={10} step={1} />
					)}
				</form.Field>
				<form.Field name="baseBeds">
					{(field) => (
						<TextField
							field={field}
							label="Основных мест"
							type="number"
							min={1}
							max={10}
							step={1}
						/>
					)}
				</form.Field>
			</div>

			<div className="grid grid-cols-2 gap-4">
				<form.Field name="extraBeds">
					{(field) => (
						<TextField field={field} label="Доп. мест" type="number" min={0} max={10} step={1} />
					)}
				</form.Field>
				<form.Field name="inventoryCount">
					{(field) => (
						<TextField
							field={field}
							label="Количество номеров"
							description="Сколько физических номеров этого типа"
							type="number"
							min={1}
							max={200}
							step={1}
						/>
					)}
				</form.Field>
			</div>

			<Button type="submit" size="lg" className="w-full" disabled={createRoomType.isPending}>
				{createRoomType.isPending ? 'Создаём…' : 'Далее — номера'}
			</Button>
		</form>
	)
}
