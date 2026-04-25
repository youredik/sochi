/**
 * `<RbacButton>` — RBAC-aware кнопка с aria-disabled + tooltip.
 *
 * Per memory `project_m6_7_frontend_research.md` round-6 (Apaleo + Cloudbeds +
 * Smashing 2021/22 + CSS-Tricks canon):
 *   - shadcn `<Button disabled>` использует native `disabled` — focus-blocked,
 *     screen-readers ничего не announce. **A11y-hostile.** WCAG 2.1.1: any
 *     control gated by permission must be discoverable + announce reason.
 *   - **Canon 2026**: aria-disabled="true" + visible как disabled + Tooltip с
 *     reason. Кнопка получает focus, screen-reader говорит "недоступно", user
 *     понимает почему.
 *   - Для can=true рендерится обычная `<Button>` — zero overhead.
 *
 * Pair with `useCan({ resource: ['action'] })` из lib/use-can.ts.
 *
 * Usage:
 *   const canRefund = useCan({ refund: ['create'] })
 *   <RbacButton can={canRefund} deniedReason="Возврат: требуется роль Менеджер"
 *               onClick={openRefund}>Возврат</RbacButton>
 */
import type { ComponentProps, MouseEvent } from 'react'
import { Button } from './ui/button.tsx'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip.tsx'

interface RbacButtonProps extends Omit<ComponentProps<typeof Button>, 'disabled'> {
	/** Whether current role grants the permission. Compute via `useCan(...)`. */
	can: boolean
	/** Tooltip text shown when `can === false`. RU locale, brief, actionable. */
	deniedReason?: string
}

export function RbacButton({
	can,
	deniedReason = 'Недоступно для вашей роли',
	children,
	onClick,
	className,
	...rest
}: RbacButtonProps) {
	if (can) {
		return (
			<Button onClick={onClick} className={className} {...rest}>
				{children}
			</Button>
		)
	}
	// Denied: aria-disabled + visual disabled style + tooltip с причиной.
	// Native `disabled` НЕ используем — a11y hostile (focus-blocked, no SR).
	const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
		e.preventDefault()
		e.stopPropagation()
	}
	return (
		<TooltipProvider delayDuration={150}>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						{...rest}
						aria-disabled="true"
						onClick={handleClick}
						className={`${className ?? ''} cursor-not-allowed opacity-50`}
					>
						{children}
					</Button>
				</TooltipTrigger>
				<TooltipContent>{deniedReason}</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	)
}
