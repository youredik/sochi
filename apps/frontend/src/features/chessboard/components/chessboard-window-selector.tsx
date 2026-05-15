import { CalendarDaysIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useChessboardPrefsStore, type WindowDays } from '../lib/chessboard-prefs-store'

interface Option {
	value: WindowDays
	label: string
}

// G6 (2026-05-15) — Cloudbeds Spring 2026 canon extension: 4d / 1w / 2w / 3w
// added alongside existing Bnovo 3/15/30/fit. RU labels reuse «недел*» case
// для grammatic correctness (1 неделя / 2 недели / 3 недели).
const OPTIONS: readonly Option[] = [
	{ value: 3, label: '3 дня' },
	{ value: 4, label: '4 дня' },
	{ value: 7, label: '1 неделя' },
	{ value: 14, label: '2 недели' },
	{ value: 15, label: '15 дней' },
	{ value: 21, label: '3 недели' },
	{ value: 30, label: '30 дней' },
	{ value: 'fit', label: 'По ширине экрана' },
] as const

const VALUE_LABEL: Record<WindowDays, string> = {
	3: '3 дня',
	4: '4 дня',
	7: '1 неделя',
	14: '2 недели',
	15: '15 дней',
	21: '3 недели',
	30: '30 дней',
	fit: 'По экрану',
}

/**
 * ChessboardWindowSelector — выбор окна Шахматки 3/4/7/14/15/21/30/fit.
 *
 * **G6 (2026-05-15) — Cloudbeds Spring 2026 canon extension**: added 4d / 1w
 * / 2w / 3w alongside existing Bnovo 3/15/30/fit. Per `[[no-half-measures]]`
 * RU labels follow канон ГОСТ морфологии («1 неделя», «2/3 недели»). 15 retained
 * для backward-compat (previously-persisted value remains valid; operators
 * trained на 15-day fortnight). 7-day labeled «1 неделя» per Cloudbeds RU
 * canon (alias for the 7d value).
 *
 * Persisted в Zustand (per-user-per-device localStorage), НЕ URL search
 * params — Round 2 research canon: per-user preferences ≠ shareable state.
 *
 * `'fit'` value — auto-detect contained columns based on viewport width
 * (consumer responsibility — chessboard.tsx resolves 'fit' → numeric per
 * container ResizeObserver). Selector только sets pref; resolution downstream.
 */
export function ChessboardWindowSelector() {
	const windowDays = useChessboardPrefsStore((state) => state.windowDays)
	const setWindowDays = useChessboardPrefsStore((state) => state.setWindowDays)

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="outline" size="sm" aria-label="Размер окна Шахматки">
					<CalendarDaysIcon className="size-4" aria-hidden="true" />
					<span>{VALUE_LABEL[windowDays]}</span>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				{OPTIONS.map((opt) => (
					<DropdownMenuItem
						key={opt.value}
						onSelect={() => setWindowDays(opt.value)}
						aria-current={opt.value === windowDays ? 'true' : undefined}
					>
						{opt.label}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
