import { CalendarIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { formatDateShort } from '@/lib/format-ru'

interface Props {
	value: string
	onChange: (iso: string) => void
}

/**
 * ChessboardDatePicker — jump-to-date picker (Bnovo-parity 2026).
 *
 * Radix Popover + native `<input type="date">` inside. Per plan §M9.3
 * decision: native picker preserves OS-level a11y + locale formatting на
 * mobile (iOS / Android wheel pickers, Windows calendar grid). Radix Popover
 * provides focus-trap + ESC dismiss; input handles actual date selection.
 *
 * a11y: trigger button с aria-label, popover content auto-focuses native
 * input, ESC closes via Radix. Locale autodetect — browser ставит ru-RU
 * picker если HTML lang="ru" (set in index.html).
 */
export function ChessboardDatePicker({ value, onChange }: Props) {
	const [open, setOpen] = useState(false)
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button variant="outline" size="sm" aria-label="Перейти к дате">
					<CalendarIcon className="size-4" aria-hidden="true" />
					<span>{formatDateShort(value)}</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-auto p-2">
				<input
					type="date"
					value={value}
					onChange={(e) => {
						const next = e.target.value
						if (next) {
							onChange(next)
							setOpen(false)
						}
					}}
					className="bg-background text-foreground rounded-md border p-2 text-sm"
					aria-label="Выберите дату для перехода"
				/>
			</PopoverContent>
		</Popover>
	)
}
