import { useForm } from '@tanstack/react-form'
import { Button } from '@/components/ui/button'
import { TextField } from '../../forms/text-field'
import { useCreateRoom } from '../hooks/use-setup-mutations'
import { useWizardStore } from '../wizard-store'

/**
 * Step 3 — physical rooms. User enters room numbers (204, 306A…) and we
 * create them sequentially. Repeatable: after each successful create we
 * reset the form and increment the counter; user clicks "Готово" when
 * done to finish the wizard.
 *
 * Sequential rather than batch mode because:
 *   - small hotels (5-30 rooms) enter them once — one-at-a-time is fine
 *   - each mutation is idempotent at the DB level via (tenantId,
 *     roomTypeId, number) uniqueness; partial failure doesn't wedge
 *     the flow
 *   - future M5c+1 bulk-import (CSV) is a separate feature, not shoehorned
 */
export function RoomsStep() {
	const roomTypeId = useWizardStore((s) => s.roomTypeId)
	const roomsCreated = useWizardStore((s) => s.roomsCreated)
	const incRooms = useWizardStore((s) => s.incRooms)
	const finishRooms = useWizardStore((s) => s.finishRooms)
	const createRoom = useCreateRoom()

	const form = useForm({
		defaultValues: { number: '', floor: undefined as number | undefined },
		onSubmit: async ({ value, formApi }) => {
			if (!roomTypeId) return
			const input = {
				roomTypeId,
				number: value.number,
				...(value.floor !== undefined ? { floor: value.floor } : {}),
			}
			await createRoom.mutateAsync(input)
			incRooms()
			formApi.reset()
		},
	})

	return (
		<div className="space-y-5">
			<form
				onSubmit={(e) => {
					e.preventDefault()
					void form.handleSubmit()
				}}
				className="space-y-4"
				noValidate
			>
				<form.Field name="number">
					{(field) => <TextField field={field} label="Номер" placeholder="204" autoFocus />}
				</form.Field>
				<form.Field name="floor">
					{(field) => (
						<TextField
							field={field}
							label="Этаж (опционально)"
							type="number"
							min={-3}
							max={100}
							step={1}
						/>
					)}
				</form.Field>
				<Button type="submit" size="lg" className="w-full" disabled={createRoom.isPending}>
					{createRoom.isPending ? 'Добавляем…' : 'Добавить номер'}
				</Button>
			</form>

			<p className="text-muted-foreground text-center text-sm">
				Добавлено: <span className="font-medium">{roomsCreated}</span>
			</p>

			<Button
				type="button"
				variant="outline"
				size="lg"
				className="w-full"
				onClick={finishRooms}
				disabled={roomsCreated === 0}
			>
				Далее — тариф
			</Button>
		</div>
	)
}
