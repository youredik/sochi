import { CalendarDaysIcon, CalendarIcon } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useChessboardPrefsStore, type ViewMode } from '../lib/chessboard-prefs-store'

/**
 * ChessboardViewModeSelector — Day/Month toggle (Bnovo-parity 2026).
 *
 * Radix ToggleGroup + lucide icons. Per plan §M9.3: viewMode persists в
 * Zustand `horeca-chessboard-prefs` (per-user-per-device, not URL — same
 * canon as windowDays). Default 'day' = current chessboard behavior;
 * 'month' = aggregated calendar view (UI-only signal в Phase B; downstream
 * grid layout switching — Phase C/D).
 *
 * a11y: ToggleGroup type="single" с aria-label, item с aria-pressed via
 * Radix data-state. WCAG 2.1.1 Keyboard: Arrow Left/Right через Radix.
 */
export function ChessboardViewModeSelector() {
	const viewMode = useChessboardPrefsStore((state) => state.viewMode)
	const setViewMode = useChessboardPrefsStore((state) => state.setViewMode)

	return (
		<ToggleGroup
			type="single"
			value={viewMode}
			onValueChange={(v) => {
				// Radix returns '' when same item clicked again; suppress reset.
				if (v === 'day' || v === 'month') setViewMode(v as ViewMode)
			}}
			aria-label="Режим просмотра шахматки"
			variant="outline"
			size="sm"
		>
			<ToggleGroupItem value="day" aria-label="День">
				<CalendarDaysIcon className="size-4" aria-hidden="true" />
				<span>День</span>
			</ToggleGroupItem>
			<ToggleGroupItem value="month" aria-label="Месяц">
				<CalendarIcon className="size-4" aria-hidden="true" />
				<span>Месяц</span>
			</ToggleGroupItem>
		</ToggleGroup>
	)
}
