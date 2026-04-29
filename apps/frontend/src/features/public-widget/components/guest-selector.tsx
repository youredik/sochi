/**
 * `<GuestSelector>` — adults/children stepper inside Popover panel.
 *
 * Per plan §M9.widget.2 + Airbnb canon: stepper UI с min/max bounds,
 * children counter affects different pricing logic в downstream (М9.widget.3
 * extras может show baby cot if infants > 0).
 *
 * APG button-pattern compliant (aria-pressed disabled when at bound).
 */
import { Minus, Plus, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ruPlural } from '../lib/ru-plural.ts'

export interface GuestSelectorProps {
	readonly adults: number
	readonly childrenCount: number
	readonly onChange: (next: { adults: number; childrenCount: number }) => void
	readonly maxTotal?: number
	readonly disabled?: boolean
}

export function GuestSelector({
	adults,
	childrenCount,
	onChange,
	maxTotal = 6,
	disabled = false,
}: GuestSelectorProps) {
	const total = adults + childrenCount
	const adultsAtMin = adults <= 1
	const adultsAtMax = total >= maxTotal
	const childrenAtMin = childrenCount <= 0
	const childrenAtMax = total >= maxTotal

	const adultsLabel = ruPlural(adults, 'взрослый', 'взрослых', 'взрослых')
	const childrenLabel = ruPlural(childrenCount, 'ребёнок', 'ребёнка', 'детей')
	const guestsLabel = ruPlural(maxTotal, 'гость', 'гостя', 'гостей')
	const label = `${adults} ${adultsLabel}${childrenCount > 0 ? `, ${childrenCount} ${childrenLabel}` : ''}`

	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					variant="outline"
					size="lg"
					disabled={disabled}
					aria-label={`Выбрать количество гостей. Сейчас: ${label}`}
					className="h-auto w-full justify-start gap-3 px-4 py-3"
				>
					<Users className="size-5 flex-shrink-0 text-muted-foreground" aria-hidden />
					<span className="flex flex-col items-start gap-0.5 text-left">
						<span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
							Гости
						</span>
						<span className="text-sm font-medium tabular-nums">{label}</span>
					</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent align="start" sideOffset={4} className="w-72 p-4">
				<div className="space-y-4">
					<StepperRow
						label="Взрослые"
						sub="От 18 лет"
						value={adults}
						onMinus={() => onChange({ adults: adults - 1, childrenCount })}
						onPlus={() => onChange({ adults: adults + 1, childrenCount })}
						minusDisabled={adultsAtMin}
						plusDisabled={adultsAtMax}
						testId="guests-adults"
					/>
					<StepperRow
						label="Дети"
						sub="До 17 лет"
						value={childrenCount}
						onMinus={() => onChange({ adults, childrenCount: childrenCount - 1 })}
						onPlus={() => onChange({ adults, childrenCount: childrenCount + 1 })}
						minusDisabled={childrenAtMin}
						plusDisabled={childrenAtMax}
						testId="guests-children"
					/>
					<p className="text-xs text-muted-foreground">
						Максимум {maxTotal} {guestsLabel} в одном номере.
					</p>
				</div>
			</PopoverContent>
		</Popover>
	)
}

interface StepperRowProps {
	readonly label: string
	readonly sub: string
	readonly value: number
	readonly onMinus: () => void
	readonly onPlus: () => void
	readonly minusDisabled: boolean
	readonly plusDisabled: boolean
	readonly testId: string
}

function StepperRow({
	label,
	sub,
	value,
	onMinus,
	onPlus,
	minusDisabled,
	plusDisabled,
	testId,
}: StepperRowProps) {
	return (
		<div className="flex items-center justify-between">
			<div className="flex flex-col">
				<span className="text-sm font-medium">{label}</span>
				<span className="text-xs text-muted-foreground">{sub}</span>
			</div>
			<div className="flex items-center gap-3">
				<Button
					type="button"
					variant="outline"
					size="icon"
					onClick={onMinus}
					disabled={minusDisabled}
					aria-label={`Уменьшить ${label.toLowerCase()}`}
					data-testid={`${testId}-minus`}
					className="size-9 rounded-full"
				>
					<Minus className="size-4" aria-hidden />
				</Button>
				<span
					data-testid={`${testId}-value`}
					aria-live="polite"
					className="w-6 text-center text-sm font-medium tabular-nums"
				>
					{value}
				</span>
				<Button
					type="button"
					variant="outline"
					size="icon"
					onClick={onPlus}
					disabled={plusDisabled}
					aria-label={`Увеличить ${label.toLowerCase()}`}
					data-testid={`${testId}-plus`}
					className="size-9 rounded-full"
				>
					<Plus className="size-4" aria-hidden />
				</Button>
			</div>
		</div>
	)
}
