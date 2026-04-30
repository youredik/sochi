import { ru } from 'date-fns/locale'
import { CalendarIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { formatDateShort } from '@/lib/format-ru'

interface Props {
	value: string
	onChange: (iso: string) => void
}

/**
 * ChessboardDatePicker — jump-to-date picker (Bnovo-parity 2026/2027).
 *
 * **2026/2027 modern stack:**
 * - shadcn `Calendar` (react-day-picker v9.14+ latest stable, locale-respecting)
 * - `date-fns/locale` ru — proper Russian month/weekday names regardless of
 *   browser locale preference (Chromium ignores HTML lang для native input
 *   type=date — confirmed 2026-04-29; this canon eradicates that gap)
 * - Radix Popover для focus-trap + ESC dismiss
 *
 * Замена native `<input type="date">` (которая was rendering `mm/dd/yyyy`
 * на desktop Chromium игнорируя HTML lang="ru"). Calendar rendering full
 * ru-RU c полным a11y (Tab/Arrow nav + Enter select + Escape close, full
 * react-day-picker keyboard contract).
 */
export function ChessboardDatePicker({ value, onChange }: Props) {
	const [open, setOpen] = useState(false)
	// `value` is YYYY-MM-DD ISO; parse to local Date (NOT UTC — picker is
	// per-user-per-tenant local view).
	const selected = parseIsoLocal(value)

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button variant="outline" size="sm" aria-label="Перейти к дате">
					<CalendarIcon className="size-4" aria-hidden="true" />
					<span>{formatDateShort(value)}</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-auto p-0">
				<Calendar
					mode="single"
					selected={selected}
					{...(selected !== undefined && { defaultMonth: selected })}
					onSelect={(d) => {
						if (!d) return
						onChange(toIsoLocal(d))
						setOpen(false)
					}}
					locale={ru}
					weekStartsOn={1}
					autoFocus
				/>
			</PopoverContent>
		</Popover>
	)
}

function parseIsoLocal(iso: string): Date | undefined {
	const [y, m, d] = iso.split('-').map(Number)
	if (!y || !m || !d) return undefined
	return new Date(y, m - 1, d)
}

function toIsoLocal(d: Date): string {
	const y = d.getFullYear()
	const m = String(d.getMonth() + 1).padStart(2, '0')
	const day = String(d.getDate()).padStart(2, '0')
	return `${y}-${m}-${day}`
}
