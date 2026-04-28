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

const OPTIONS: readonly Option[] = [
	{ value: 3, label: '3 дня' },
	{ value: 7, label: '7 дней' },
	{ value: 15, label: '15 дней' },
	{ value: 30, label: '30 дней' },
	{ value: 'fit', label: 'По ширине экрана' },
] as const

const VALUE_LABEL: Record<WindowDays, string> = {
	3: '3 дня',
	7: '7 дней',
	15: '15 дней',
	30: '30 дней',
	fit: 'По экрану',
}

/**
 * ChessboardWindowSelector — выбор окна Шахматки 3/7/15/30/fit.
 *
 * Bnovo-parity 2026 (per `help.bnovo.ru/knowledgebase/planing/`): 5 windowDays
 * options. Default 15 — matches existing chessboard.tsx WINDOW_DAYS canon
 * (преserved через useChessboardPrefsStore initial state).
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
