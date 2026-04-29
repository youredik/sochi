/**
 * `<DateRangePicker>` — public booking widget Screen 1 component.
 *
 * 2026 canon (per fresh research, plan §M9.widget.2):
 *   - `react-day-picker 9.14` mode="range"
 *   - Desktop: 2 months side-by-side (Airbnb gold standard)
 *   - Mobile: single month (vertical-scroll preferred, but daypicker doesn't
 *     ship vertical-scroll mode native — using single month + nav arrows
 *     gives equivalent UX; keyboard nav APG-grid compliant)
 *   - ru-RU locale via `date-fns/locale`
 *   - WAI-ARIA APG grid pattern (built-in to react-day-picker v9)
 *
 * Props are pure — no router coupling. Consumer (search-and-pick.tsx) maps
 * onChange to URL search params.
 */
import { ru } from 'date-fns/locale'
import { CalendarIcon } from 'lucide-react'
import { useState } from 'react'
import type { DateRange } from 'react-day-picker'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useMediaQuery } from '@/lib/use-media-query'
import { formatDateRange } from '../lib/widget-format.ts'

export interface DateRangePickerProps {
	readonly checkIn: string
	readonly checkOut: string
	readonly onChange: (next: { checkIn: string; checkOut: string }) => void
	readonly minDate?: string
	readonly maxNights?: number
	readonly disabled?: boolean
}

export function DateRangePicker({
	checkIn,
	checkOut,
	onChange,
	minDate,
	maxNights = 30,
	disabled = false,
}: DateRangePickerProps) {
	const [open, setOpen] = useState(false)
	// Per plan §M9.widget.2 + Airbnb 2026 canon: 2-month side-by-side desktop,
	// single-month mobile (NN/g 2024 vertical-flow recommendation).
	const isDesktop = useMediaQuery('(min-width: 768px)')

	const selected: DateRange = {
		from: parseIso(checkIn),
		to: parseIso(checkOut),
	}

	const handleSelect = (range: DateRange | undefined) => {
		if (!range) return
		const { from, to } = range
		if (!from) return
		// Single-day click during range selection (from, no to yet) — ignore until
		// user picks the second click.
		if (!to) return
		const fromIso = toIso(from)
		const toIsoStr = toIso(to)
		if (fromIso >= toIsoStr) return // sanity: must be < check-out
		onChange({ checkIn: fromIso, checkOut: toIsoStr })
		// Auto-close after full range chosen — Airbnb pattern
		setOpen(false)
	}

	const minDateParsed = minDate ? parseIso(minDate) : new Date()
	const maxDate = new Date()
	maxDate.setDate(maxDate.getDate() + 365)

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					variant="outline"
					size="lg"
					disabled={disabled}
					aria-label={`Выбрать даты заезда и выезда. Текущий выбор: ${formatDateRange(checkIn, checkOut)}`}
					className="h-auto w-full justify-start gap-3 px-4 py-3"
				>
					<CalendarIcon className="size-5 flex-shrink-0 text-muted-foreground" aria-hidden />
					<span className="flex flex-col items-start gap-0.5 text-left">
						<span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
							Даты проживания
						</span>
						<span className="text-sm font-medium tabular-nums">
							{formatDateRange(checkIn, checkOut)}
						</span>
					</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-auto p-0" sideOffset={4}>
				<Calendar
					mode="range"
					selected={selected}
					onSelect={handleSelect}
					numberOfMonths={isDesktop ? 2 : 1}
					locale={ru}
					weekStartsOn={1}
					disabled={[{ before: minDateParsed }, { after: maxDate }]}
					excludeDisabled
					min={1}
					max={maxNights}
					autoFocus
				/>
			</PopoverContent>
		</Popover>
	)
}

function parseIso(iso: string): Date {
	const [y, m, d] = iso.split('-').map(Number)
	if (!y || !m || !d) throw new Error(`invalid ISO date: ${iso}`)
	return new Date(y, m - 1, d)
}

function toIso(d: Date): string {
	const y = d.getFullYear()
	const m = String(d.getMonth() + 1).padStart(2, '0')
	const day = String(d.getDate()).padStart(2, '0')
	return `${y}-${m}-${day}`
}
