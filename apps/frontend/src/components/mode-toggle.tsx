import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { Theme } from '@/lib/theme-store'
import { useThemeStore } from '@/lib/theme-store'

/**
 * ModeToggle — 3-way light/dark/system theme switcher.
 *
 * Canonical 2026 shadcn pattern (per `ui.shadcn.com/docs/dark-mode/vite`):
 *   - Button trigger с Sun/Moon icons (фотонная hover-cross-fade), `sr-only` label
 *   - DropdownMenu с 3 explicit choices (light/dark/system) — rejected 2-state
 *     toggle потому что system pref должен быть first-class option (Round 2 research)
 *   - `aria-label` на trigger button — screen reader announces «Theme»
 *   - lucide-react icons (уже в стеке) — НЕ вводим новый icon set
 *
 * Не используем `aria-current` на dropdown items (Radix DropdownMenu spec
 * не предусматривает selected state — для радио-выбора используется отдельный
 * `DropdownMenuRadioGroup`, но для 3 простых options обычный Item достаточен).
 */
export function ModeToggle() {
	const setTheme = useThemeStore((state) => state.setTheme)

	const handleSelect = (theme: Theme) => {
		setTheme(theme)
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="icon" aria-label="Тема оформления">
					<SunIcon className="size-4 scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
					<MoonIcon className="absolute size-4 scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
					<span className="sr-only">Переключить тему</span>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem onSelect={() => handleSelect('light')}>
					<SunIcon className="mr-2 size-4" />
					Светлая
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => handleSelect('dark')}>
					<MoonIcon className="mr-2 size-4" />
					Тёмная
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => handleSelect('system')}>
					<MonitorIcon className="mr-2 size-4" />
					Системная
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
