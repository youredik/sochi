/**
 * ResponsiveSheet — Sheet (desktop) ⇄ Vaul Drawer (mobile) wrapper.
 *
 * **M9.5 Phase C canonical (per plan §M9.2 deferred + Vercel Vaul 2026 canon):**
 * Бизнес-feature sheets (refund / markPaid / notification-detail / migration-
 * detail) must render как right-side Sheet на desktop (≥md, 768px) и как
 * bottom Drawer на mobile (<768px). Bottom-drawer = canonical thumb-reach
 * pattern для mobile, Sheet right = canonical desktop pattern (Linear/Vercel).
 *
 * **API:**
 * Drop-in replacement для `Sheet` exports — same component names + props.
 * Internal switch via `useMediaQuery('(min-width: 768px)')`.
 *
 * **Migration cost:** rename `Sheet` → `ResponsiveSheet` в imports. Сами
 * children prop'ы compat без изменений (open/onOpenChange/etc).
 *
 * **Why context-shared media query:** every primitive (Root/Content/Header/
 * Title/etc) needs to pick same primitive — sharing via Context ensures all
 * children agree, no double subscription per primitive instance.
 */
import { createContext, useContext, useMemo } from 'react'
import { useMediaQuery } from '@/lib/use-media-query'
import {
	Drawer,
	DrawerClose,
	DrawerContent,
	DrawerDescription,
	DrawerFooter,
	DrawerHeader,
	DrawerTitle,
	DrawerTrigger,
} from './drawer'
import {
	Sheet,
	SheetClose,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from './sheet'

interface ResponsiveCtx {
	isMobile: boolean
}

const Ctx = createContext<ResponsiveCtx>({ isMobile: false })

export function ResponsiveSheet({
	children,
	...props
}: React.ComponentProps<typeof Sheet>) {
	const isMobile = !useMediaQuery('(min-width: 768px)')
	const value = useMemo(() => ({ isMobile }), [isMobile])
	const Root = isMobile ? Drawer : Sheet
	return (
		<Ctx.Provider value={value}>
			<Root {...props}>{children}</Root>
		</Ctx.Provider>
	)
}

export function ResponsiveSheetTrigger(props: React.ComponentProps<typeof SheetTrigger>) {
	const { isMobile } = useContext(Ctx)
	return isMobile ? <DrawerTrigger {...props} /> : <SheetTrigger {...props} />
}

export function ResponsiveSheetClose(props: React.ComponentProps<typeof SheetClose>) {
	const { isMobile } = useContext(Ctx)
	return isMobile ? <DrawerClose {...props} /> : <SheetClose {...props} />
}

/**
 * `side` prop applies к desktop Sheet only; mobile Drawer always bottom
 * (canonical thumb-reach). `showCloseButton` defaults true on Sheet —
 * Drawer drag-handle replaces close affordance на mobile.
 */
export function ResponsiveSheetContent({
	side = 'right',
	showCloseButton,
	className,
	children,
	...props
}: React.ComponentProps<typeof SheetContent>) {
	const { isMobile } = useContext(Ctx)
	if (isMobile) {
		return (
			<DrawerContent className={className} {...props}>
				{children}
			</DrawerContent>
		)
	}
	return (
		<SheetContent
			side={side}
			{...(showCloseButton !== undefined ? { showCloseButton } : {})}
			className={className}
			{...props}
		>
			{children}
		</SheetContent>
	)
}

export function ResponsiveSheetHeader(props: React.ComponentProps<typeof SheetHeader>) {
	const { isMobile } = useContext(Ctx)
	return isMobile ? <DrawerHeader {...props} /> : <SheetHeader {...props} />
}

export function ResponsiveSheetFooter(props: React.ComponentProps<typeof SheetFooter>) {
	const { isMobile } = useContext(Ctx)
	return isMobile ? <DrawerFooter {...props} /> : <SheetFooter {...props} />
}

export function ResponsiveSheetTitle(props: React.ComponentProps<typeof SheetTitle>) {
	const { isMobile } = useContext(Ctx)
	return isMobile ? <DrawerTitle {...props} /> : <SheetTitle {...props} />
}

export function ResponsiveSheetDescription(
	props: React.ComponentProps<typeof SheetDescription>,
) {
	const { isMobile } = useContext(Ctx)
	return isMobile ? <DrawerDescription {...props} /> : <SheetDescription {...props} />
}
