/**
 * Sidebar primitive — strict tests (A.bis.1 shadcn sidebar local copy 2026-05-12).
 *
 * Pre-done audit (per `feedback_strict_tests.md`):
 *   useSidebar contract:
 *     [H1] useSidebar() throws outside provider
 *     [H2] useSidebar() inside provider returns full context shape
 *
 *   SidebarProvider state:
 *     [S1] defaultOpen=true → state="expanded"
 *     [S2] defaultOpen=false → state="collapsed"
 *     [S3] toggleSidebar() flips expanded↔collapsed
 *     [S4] setOpen(false) sets state="collapsed"
 *
 *   D20 cookie best-effort (plan §4 D20):
 *     [C1] toggle writes `sidebar_state=true|false`
 *     [C2] cookie carries max-age=604800 (7 days)
 *     [C3] cookie carries samesite=lax (CSRF baseline)
 *
 *   Keyboard shortcut (registry default Cmd+B / Ctrl+B):
 *     [K1] Cmd+B (metaKey) toggles
 *     [K2] Ctrl+B (ctrlKey) toggles
 *     [K3] 'a' + metaKey does NOT toggle (key narrowing)
 *     [K4] 'b' alone (no modifier) does NOT toggle (modifier narrowing)
 *
 *   PATCH-D12 mobile dismiss button (Issue shadcn-ui/ui#6761):
 *     [D12.1] mobile <Sheet> renders SheetClose with aria-label="Закрыть меню"
 *     [D12.2] dismiss button is focusable (tabindex != -1)
 *     [D12.3] dismiss button is a real <button> element (semantic + focusable)
 *     [D12.4] mobile sheet has Russian SheetTitle "Боковое меню" (sr-only)
 *     [D12.5] mobile sheet does NOT render English-default Sheet auto-close
 *
 *   PATCH-D13 controlled-prop guard (Issue shadcn-ui/ui#8176):
 *     [D13.1] passing `open` prop via TS bypass cast is silently ignored
 *     [D13.2] internal toggleSidebar still works after bypass attempt
 *
 *   PATCH-D14 single-provider canon (Issue shadcn-ui/ui#9335):
 *     [D14.1] single provider — no console.error in dev
 *     [D14.2] two simultaneous providers — console.error fired
 *     [D14.3] unmount-and-remount: cleanup releases instance, no leak
 *
 *   PATCH-D15 aria-label canon (plan §4 D15):
 *     [D15.1] SidebarMenuButton without aria-label → console.warn fired
 *     [D15.2] SidebarMenuButton with aria-label → NO warn
 *     [D15.3] SidebarMenuButton with aria-labelledby → NO warn
 *
 *   PATCH-D16 forced-colors (plan §4 D16):
 *     [D16.1] menu button class includes `forced-colors:border`
 *     [D16.2] menu button class includes `forced-colors:border-[ButtonText]`
 *
 *   collapsible enum FULL coverage (per `feedback_strict_tests.md`):
 *     [E1] collapsible="none" → simple div, NO Sheet, NO data-collapsible
 *     [E2] collapsible="offcanvas" desktop → persistent div w/ data-collapsible
 *     [E3] collapsible="icon" desktop → data-collapsible="icon" when collapsed
 *
 *   Triggers:
 *     [T1] SidebarTrigger click toggles sidebar
 *     [T2] SidebarRail click toggles sidebar
 *     [T3] SidebarTrigger has aria-label="Переключить меню" (RU canon)
 */
import * as React from 'react'
import { cleanup, render, screen, act } from '@testing-library/react'
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
	type MockInstance,
} from 'vitest'

import {
	Sidebar,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarProvider,
	SidebarRail,
	SidebarTrigger,
	useSidebar,
} from './sidebar'

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

let warnSpy: MockInstance
let errorSpy: MockInstance

/**
 * Mock window.matchMedia so `useMediaQuery('(min-width: 768px)')` returns
 * `desktop` by default. Mobile tests override per-test.
 */
function mockMatchMedia(isDesktop: boolean) {
	Object.defineProperty(window, 'matchMedia', {
		writable: true,
		configurable: true,
		value: vi.fn().mockImplementation((query: string) => ({
			matches: query.includes('min-width: 768px') ? isDesktop : false,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			dispatchEvent: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
		})),
	})
}

function clearCookie() {
	document.cookie = 'sidebar_state=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT'
}

beforeEach(() => {
	mockMatchMedia(true) // desktop default
	clearCookie()
	warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
	errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
	cleanup()
	warnSpy.mockRestore()
	errorSpy.mockRestore()
})

/**
 * Inline harness — exposes the live useSidebar() context via a ref so tests
 * can assert and drive state directly without DOM wrangling.
 */
function ContextProbe({
	send,
}: {
	send: (ctx: ReturnType<typeof useSidebar>) => void
}) {
	const ctx = useSidebar()
	send(ctx)
	return null
}

function renderWithProbe(opts?: { defaultOpen?: boolean }) {
	let captured: ReturnType<typeof useSidebar> | null = null
	const utils = render(
		<SidebarProvider defaultOpen={opts?.defaultOpen ?? true}>
			<ContextProbe send={(ctx) => (captured = ctx)} />
		</SidebarProvider>,
	)
	if (!captured) throw new Error('ContextProbe never received context')
	return { ...utils, get ctx() { return captured! } }
}

/* -------------------------------------------------------------------------- */
/*  useSidebar contract                                                       */
/* -------------------------------------------------------------------------- */

describe('Sidebar — useSidebar contract', () => {
	it('[H1] useSidebar() throws outside provider', () => {
		// Suppress React's error boundary noise for this expected throw.
		const restore = vi.spyOn(console, 'error').mockImplementation(() => {})
		expect(() =>
			render(<ContextProbe send={() => {}} />),
		).toThrowError('useSidebar must be used within a <SidebarProvider>.')
		restore.mockRestore()
	})

	it('[H2] useSidebar() inside provider exposes full context shape', () => {
		const probe = renderWithProbe()
		expect(typeof probe.ctx.state).toBe('string')
		expect(typeof probe.ctx.open).toBe('boolean')
		expect(typeof probe.ctx.setOpen).toBe('function')
		expect(typeof probe.ctx.openMobile).toBe('boolean')
		expect(typeof probe.ctx.setOpenMobile).toBe('function')
		expect(typeof probe.ctx.isMobile).toBe('boolean')
		expect(typeof probe.ctx.toggleSidebar).toBe('function')
	})
})

/* -------------------------------------------------------------------------- */
/*  SidebarProvider state                                                     */
/* -------------------------------------------------------------------------- */

describe('Sidebar — SidebarProvider state', () => {
	it('[S1] defaultOpen=true → state="expanded"', () => {
		const probe = renderWithProbe({ defaultOpen: true })
		expect(probe.ctx.state).toBe('expanded')
		expect(probe.ctx.open).toBe(true)
	})

	it('[S2] defaultOpen=false → state="collapsed"', () => {
		const probe = renderWithProbe({ defaultOpen: false })
		expect(probe.ctx.state).toBe('collapsed')
		expect(probe.ctx.open).toBe(false)
	})

	it('[S3] toggleSidebar() flips expanded↔collapsed', () => {
		const probe = renderWithProbe({ defaultOpen: true })
		expect(probe.ctx.state).toBe('expanded')
		act(() => probe.ctx.toggleSidebar())
		expect(probe.ctx.state).toBe('collapsed')
		act(() => probe.ctx.toggleSidebar())
		expect(probe.ctx.state).toBe('expanded')
	})

	it('[S4] setOpen(false) sets state="collapsed"', () => {
		const probe = renderWithProbe({ defaultOpen: true })
		act(() => probe.ctx.setOpen(false))
		expect(probe.ctx.state).toBe('collapsed')
		expect(probe.ctx.open).toBe(false)
	})
})

/* -------------------------------------------------------------------------- */
/*  D20 cookie best-effort                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Find the document.cookie property descriptor by walking the prototype
 * chain. happy-dom stores it on a Document base class proto that isn't always
 * the immediate `Object.getPrototypeOf(document)`. Returns null if not found.
 */
function findCookieDescriptor(): { target: object; desc: PropertyDescriptor } | null {
	let target: object | null = document
	while (target) {
		const desc = Object.getOwnPropertyDescriptor(target, 'cookie')
		if (desc) return { target, desc }
		target = Object.getPrototypeOf(target)
	}
	return null
}

/**
 * Wrap document.cookie setter so callers can inspect the raw `name=value;
 * max-age=...; samesite=...` string. Returns a `restore()` function — call
 * it in `finally` to revert. happy-dom's readable `document.cookie` strips
 * directives, so direct intercept is the only way to assert them.
 */
function spyOnCookieWrites(): { writes: string[]; restore: () => void } {
	const writes: string[] = []
	const found = findCookieDescriptor()
	if (!found || !found.desc.set) {
		throw new Error('document.cookie descriptor not found in prototype chain')
	}
	const originalSet = found.desc.set
	const originalGet = found.desc.get
	Object.defineProperty(document, 'cookie', {
		configurable: true,
		set(value: string) {
			writes.push(value)
			originalSet.call(document, value)
		},
		get() {
			return originalGet ? originalGet.call(document) : ''
		},
	})
	return {
		writes,
		restore() {
			// Configurable=true means delete reverts to prototype's accessor.
			delete (document as unknown as { cookie?: string }).cookie
		},
	}
}

describe('Sidebar — D20 cookie best-effort persistence', () => {
	it('[C1] toggle writes sidebar_state=true|false', () => {
		const probe = renderWithProbe({ defaultOpen: true })
		clearCookie()
		act(() => probe.ctx.setOpen(false))
		expect(document.cookie).toMatch(/sidebar_state=false/)
		act(() => probe.ctx.setOpen(true))
		expect(document.cookie).toMatch(/sidebar_state=true/)
	})

	it('[C2] cookie carries max-age=604800 (7-day SIDEBAR_COOKIE_MAX_AGE constant)', () => {
		const spy = spyOnCookieWrites()
		try {
			const probe = renderWithProbe({ defaultOpen: true })
			act(() => probe.ctx.setOpen(false))
			expect(spy.writes.some((w) => /max-age=604800/.test(w))).toBe(true)
		} finally {
			spy.restore()
		}
	})

	it('[C3] cookie carries samesite=lax (CSRF baseline)', () => {
		const spy = spyOnCookieWrites()
		try {
			const probe = renderWithProbe({ defaultOpen: true })
			act(() => probe.ctx.setOpen(false))
			expect(spy.writes.some((w) => /samesite=lax/i.test(w))).toBe(true)
		} finally {
			spy.restore()
		}
	})
})

/* -------------------------------------------------------------------------- */
/*  Keyboard shortcut                                                         */
/* -------------------------------------------------------------------------- */

describe('Sidebar — keyboard shortcut Cmd+B / Ctrl+B', () => {
	it('[K1] Cmd+B (metaKey) toggles', () => {
		const probe = renderWithProbe({ defaultOpen: true })
		expect(probe.ctx.state).toBe('expanded')
		act(() => {
			window.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'b', metaKey: true, cancelable: true }),
			)
		})
		expect(probe.ctx.state).toBe('collapsed')
	})

	it('[K2] Ctrl+B (ctrlKey) toggles', () => {
		const probe = renderWithProbe({ defaultOpen: true })
		act(() => {
			window.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, cancelable: true }),
			)
		})
		expect(probe.ctx.state).toBe('collapsed')
	})

	it('[K3] "a" + metaKey does NOT toggle (key narrowing)', () => {
		const probe = renderWithProbe({ defaultOpen: true })
		act(() => {
			window.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'a', metaKey: true, cancelable: true }),
			)
		})
		expect(probe.ctx.state).toBe('expanded')
	})

	it('[K4] "b" alone (no modifier) does NOT toggle (modifier narrowing)', () => {
		const probe = renderWithProbe({ defaultOpen: true })
		act(() => {
			window.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'b', cancelable: true }),
			)
		})
		expect(probe.ctx.state).toBe('expanded')
	})

	// PATCH-D27 (A.bis.5 fix-up — bug A1.1 from senior bug hunt 2026-05-12):
	// Cmd+B / Ctrl+B must NOT capture when the user is typing in a text
	// input surface. Verifies the four target classes guarded by the
	// keydown listener: <input>, <textarea>, <select>, contenteditable.
	it('[K5] Cmd+B with target=<input> does NOT toggle + does NOT preventDefault', () => {
		const probe = renderWithProbe({ defaultOpen: true })
		const input = document.createElement('input')
		document.body.appendChild(input)
		try {
			const event = new KeyboardEvent('keydown', {
				key: 'b',
				metaKey: true,
				cancelable: true,
				bubbles: true,
			})
			act(() => {
				input.dispatchEvent(event)
			})
			expect(probe.ctx.state).toBe('expanded') // unchanged
			expect(event.defaultPrevented).toBe(false) // input's bold shortcut preserved
		} finally {
			input.remove()
		}
	})

	it('[K6] Cmd+B with target=<textarea> does NOT toggle (input-capture guard)', () => {
		const probe = renderWithProbe({ defaultOpen: true })
		const ta = document.createElement('textarea')
		document.body.appendChild(ta)
		try {
			act(() => {
				ta.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'b',
						metaKey: true,
						cancelable: true,
						bubbles: true,
					}),
				)
			})
			expect(probe.ctx.state).toBe('expanded')
		} finally {
			ta.remove()
		}
	})

	it('[K7] Cmd+B with target=<select> does NOT toggle (input-capture guard)', () => {
		const probe = renderWithProbe({ defaultOpen: true })
		const sel = document.createElement('select')
		document.body.appendChild(sel)
		try {
			act(() => {
				sel.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'b',
						metaKey: true,
						cancelable: true,
						bubbles: true,
					}),
				)
			})
			expect(probe.ctx.state).toBe('expanded')
		} finally {
			sel.remove()
		}
	})

	it('[K8] Cmd+B with contenteditable target does NOT toggle (rich-text guard)', () => {
		const probe = renderWithProbe({ defaultOpen: true })
		const div = document.createElement('div')
		div.setAttribute('contenteditable', 'true')
		document.body.appendChild(div)
		try {
			act(() => {
				div.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'b',
						metaKey: true,
						cancelable: true,
						bubbles: true,
					}),
				)
			})
			expect(probe.ctx.state).toBe('expanded')
		} finally {
			div.remove()
		}
	})

	it('[K9] Cmd+B with target=<button> (non-input) STILL toggles (regression guard)', () => {
		// Sanity check that the K5-K8 guard isn't too greedy — clicking a
		// button on the page then pressing Cmd+B should still toggle.
		const probe = renderWithProbe({ defaultOpen: true })
		const btn = document.createElement('button')
		document.body.appendChild(btn)
		try {
			act(() => {
				btn.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'b',
						metaKey: true,
						cancelable: true,
						bubbles: true,
					}),
				)
			})
			expect(probe.ctx.state).toBe('collapsed')
		} finally {
			btn.remove()
		}
	})
})

/* -------------------------------------------------------------------------- */
/*  PATCH-D12 mobile dismiss button                                           */
/* -------------------------------------------------------------------------- */

describe('Sidebar — PATCH-D12 mobile dismiss button (#6761)', () => {
	function renderMobileSidebar() {
		mockMatchMedia(false) // mobile
		return render(
			<SidebarProvider defaultOpen>
				<SidebarOpener />
				<Sidebar collapsible="offcanvas">
					<div>Sidebar body</div>
				</Sidebar>
			</SidebarProvider>,
		)
	}

	function SidebarOpener() {
		const ctx = useSidebar()
		// Force mobile sheet open at render — simpler than user click.
		React.useEffect(() => {
			ctx.setOpenMobile(true)
		}, [ctx])
		return null
	}

	it('[D12.1] mobile <Sheet> renders dismiss button with aria-label="Закрыть меню"', () => {
		renderMobileSidebar()
		const dismiss = document.querySelector('[data-sidebar="dismiss"]')
		expect(dismiss).not.toBeNull()
		expect(dismiss?.getAttribute('aria-label')).toBe('Закрыть меню')
	})

	it('[D12.2] dismiss button is focusable (no tabindex=-1)', () => {
		renderMobileSidebar()
		const dismiss = document.querySelector('[data-sidebar="dismiss"]')
		expect(dismiss).not.toBeNull()
		// Real <button> default tabindex 0; explicit -1 would trap SR users.
		const tabIndex = dismiss?.getAttribute('tabindex')
		expect(tabIndex === null || Number(tabIndex) >= 0).toBe(true)
	})

	it('[D12.3] dismiss button is a real <button> element', () => {
		renderMobileSidebar()
		const dismiss = document.querySelector('[data-sidebar="dismiss"]')
		expect(dismiss?.tagName).toBe('BUTTON')
	})

	it('[D12.4] mobile sheet has Russian sr-only SheetTitle "Боковое меню"', () => {
		renderMobileSidebar()
		expect(screen.getByText('Боковое меню')).toBeDefined()
	})

	it('[D12.5] mobile sheet does NOT render English-default Sheet auto-close', () => {
		renderMobileSidebar()
		// Sheet's own auto-close has sr-only "Close" — must be suppressed
		// (our showCloseButton={false} + own Russian SheetClose).
		expect(screen.queryByText('Close')).toBeNull()
	})
})

/* -------------------------------------------------------------------------- */
/*  PATCH-D13 controlled-prop guard                                           */
/* -------------------------------------------------------------------------- */

describe('Sidebar — PATCH-D13 controlled-prop guard (#8176)', () => {
	it('[D13.1] passing `open` prop via TS bypass cast is silently ignored', () => {
		// Cast to any so TS does not block the bypass — runtime must still ignore it.
		// This proves removal is structural, not just type-level.
		const ProviderAny = SidebarProvider as unknown as React.FC<{
			defaultOpen: boolean
			open: boolean
			children: React.ReactNode
		}>
		let captured: ReturnType<typeof useSidebar> | null = null
		render(
			<ProviderAny defaultOpen={true} open={false}>
				<ContextProbe send={(ctx) => (captured = ctx)} />
			</ProviderAny>,
		)
		// `open={false}` would have forced collapsed if provider read it.
		// Since we never read it, defaultOpen=true wins.
		expect(captured!.state).toBe('expanded')
		expect(captured!.open).toBe(true)
	})

	it('[D13.2] internal toggleSidebar still works after a bypass attempt', () => {
		const ProviderAny = SidebarProvider as unknown as React.FC<{
			defaultOpen: boolean
			open: boolean
			onOpenChange: (open: boolean) => void
			children: React.ReactNode
		}>
		let captured: ReturnType<typeof useSidebar> | null = null
		const onOpenChangeSpy = vi.fn()
		render(
			<ProviderAny defaultOpen={true} open={true} onOpenChange={onOpenChangeSpy}>
				<ContextProbe send={(ctx) => (captured = ctx)} />
			</ProviderAny>,
		)
		act(() => captured!.toggleSidebar())
		expect(captured!.state).toBe('collapsed')
		// Bypassed onOpenChange must NOT receive notifications either —
		// provider holds zero references to forbidden callback.
		expect(onOpenChangeSpy).not.toHaveBeenCalled()
	})
})

/* -------------------------------------------------------------------------- */
/*  PATCH-D14 single-provider canon                                           */
/* -------------------------------------------------------------------------- */

describe('Sidebar — PATCH-D14 single-provider canon (#9335)', () => {
	it('[D14.1] single provider — no console.error', () => {
		render(
			<SidebarProvider>
				<ContextProbe send={() => {}} />
			</SidebarProvider>,
		)
		const offending = errorSpy.mock.calls.filter((args) =>
			String(args[0]).includes('Multiple <SidebarProvider>'),
		)
		expect(offending.length).toBe(0)
	})

	it('[D14.2] two simultaneous providers — console.error fired', () => {
		render(
			<>
				<SidebarProvider>
					<ContextProbe send={() => {}} />
				</SidebarProvider>
				<SidebarProvider>
					<ContextProbe send={() => {}} />
				</SidebarProvider>
			</>,
		)
		const offending = errorSpy.mock.calls.filter((args) =>
			String(args[0]).includes('Multiple <SidebarProvider>'),
		)
		expect(offending.length).toBeGreaterThanOrEqual(1)
	})

	it('[D14.3] unmount cleanup releases instance — second mount alone does NOT warn', () => {
		const first = render(
			<SidebarProvider>
				<ContextProbe send={() => {}} />
			</SidebarProvider>,
		)
		first.unmount()
		errorSpy.mockClear()
		render(
			<SidebarProvider>
				<ContextProbe send={() => {}} />
			</SidebarProvider>,
		)
		const offending = errorSpy.mock.calls.filter((args) =>
			String(args[0]).includes('Multiple <SidebarProvider>'),
		)
		expect(offending.length).toBe(0)
	})
})

/* -------------------------------------------------------------------------- */
/*  PATCH-D15 aria-label canon                                                */
/* -------------------------------------------------------------------------- */

describe('Sidebar — PATCH-D15 aria-label canon', () => {
	it('[D15.1] SidebarMenuButton without aria-label → console.warn fired', () => {
		render(
			<SidebarProvider>
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton>Шахматка</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarProvider>,
		)
		const offending = warnSpy.mock.calls.filter((args) =>
			String(args[0]).includes('without an explicit `aria-label`'),
		)
		expect(offending.length).toBeGreaterThanOrEqual(1)
	})

	it('[D15.2] SidebarMenuButton with aria-label → NO warn', () => {
		render(
			<SidebarProvider>
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton aria-label="Шахматка — занятость номеров">
							Шахматка
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarProvider>,
		)
		const offending = warnSpy.mock.calls.filter((args) =>
			String(args[0]).includes('without an explicit `aria-label`'),
		)
		expect(offending.length).toBe(0)
	})

	it('[D15.3] SidebarMenuButton with aria-labelledby → NO warn', () => {
		render(
			<SidebarProvider>
				<SidebarMenu>
					<SidebarMenuItem>
						<span id="lbl-grid">Шахматка</span>
						<SidebarMenuButton aria-labelledby="lbl-grid">
							Шахматка
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarProvider>,
		)
		const offending = warnSpy.mock.calls.filter((args) =>
			String(args[0]).includes('without an explicit `aria-label`'),
		)
		expect(offending.length).toBe(0)
	})

	// PATCH-D15 tightening (A.bis.5 fix-up — bug A1.2 from senior bug
	// hunt 2026-05-12): `typeof "" === "string"` is true, so an empty
	// or whitespace-only aria-label slipped through D15.2 logic and
	// silenced the dev-warn. SR users got NO accessible name. Treat
	// empty/whitespace string as «unlabelled».
	it('[D15.4] SidebarMenuButton with aria-label="" (empty) → console.warn fired', () => {
		render(
			<SidebarProvider>
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton aria-label="">Шахматка</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarProvider>,
		)
		const offending = warnSpy.mock.calls.filter((args) =>
			String(args[0]).includes('without an explicit `aria-label`'),
		)
		expect(offending.length).toBeGreaterThanOrEqual(1)
	})

	it('[D15.5] SidebarMenuButton with aria-label="   " (whitespace) → console.warn fired', () => {
		render(
			<SidebarProvider>
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton aria-label="   ">Шахматка</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarProvider>,
		)
		const offending = warnSpy.mock.calls.filter((args) =>
			String(args[0]).includes('without an explicit `aria-label`'),
		)
		expect(offending.length).toBeGreaterThanOrEqual(1)
	})

	it('[D15.6] SidebarMenuButton with aria-labelledby="" (empty) → console.warn fired', () => {
		render(
			<SidebarProvider>
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton aria-labelledby="">Шахматка</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarProvider>,
		)
		const offending = warnSpy.mock.calls.filter((args) =>
			String(args[0]).includes('without an explicit `aria-label`'),
		)
		expect(offending.length).toBeGreaterThanOrEqual(1)
	})
})

/* -------------------------------------------------------------------------- */
/*  PATCH-D16 forced-colors mode                                              */
/* -------------------------------------------------------------------------- */

describe('Sidebar — PATCH-D16 forced-colors (HCM) borders', () => {
	function renderButton() {
		return render(
			<SidebarProvider>
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton aria-label="Шахматка">
							Шахматка
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarProvider>,
		)
	}

	it('[D16.1] menu button class includes `forced-colors:border`', () => {
		renderButton()
		const btn = document.querySelector('[data-sidebar="menu-button"]')
		expect(btn).not.toBeNull()
		expect(btn?.getAttribute('class')).toContain('forced-colors:border')
	})

	it('[D16.2] menu button class includes `forced-colors:border-[ButtonText]`', () => {
		renderButton()
		const btn = document.querySelector('[data-sidebar="menu-button"]')
		expect(btn?.getAttribute('class')).toContain('forced-colors:border-[ButtonText]')
	})
})

/* -------------------------------------------------------------------------- */
/*  collapsible enum FULL coverage                                            */
/* -------------------------------------------------------------------------- */

describe('Sidebar — collapsible enum FULL coverage', () => {
	it('[E1] collapsible="none" → simple div, NO Sheet, NO data-collapsible', () => {
		render(
			<SidebarProvider>
				<Sidebar collapsible="none">
					<div>plain</div>
				</Sidebar>
			</SidebarProvider>,
		)
		const slot = document.querySelector('[data-slot="sidebar"]')
		expect(slot).not.toBeNull()
		expect(slot?.getAttribute('data-collapsible')).toBeNull()
		expect(screen.getByText('plain')).toBeDefined()
		// No mobile Sheet (data-mobile attribute) since collapsible="none".
		expect(document.querySelector('[data-mobile="true"]')).toBeNull()
	})

	it('[E2] collapsible="offcanvas" desktop → persistent div w/ data-collapsible attribute', () => {
		mockMatchMedia(true) // desktop
		render(
			<SidebarProvider defaultOpen={false}>
				<Sidebar collapsible="offcanvas">
					<div>persistent</div>
				</Sidebar>
			</SidebarProvider>,
		)
		const slot = document.querySelector('[data-slot="sidebar"]')
		// state="collapsed" + collapsible="offcanvas" → data-collapsible="offcanvas".
		expect(slot?.getAttribute('data-collapsible')).toBe('offcanvas')
		expect(slot?.getAttribute('data-state')).toBe('collapsed')
	})

	it('[E3] collapsible="icon" desktop collapsed → data-collapsible="icon"', () => {
		mockMatchMedia(true)
		render(
			<SidebarProvider defaultOpen={false}>
				<Sidebar collapsible="icon">
					<div>icon-rail</div>
				</Sidebar>
			</SidebarProvider>,
		)
		const slot = document.querySelector('[data-slot="sidebar"]')
		expect(slot?.getAttribute('data-collapsible')).toBe('icon')
	})

	it('[E4] collapsible="offcanvas" desktop EXPANDED → data-collapsible empty (only set when collapsed)', () => {
		mockMatchMedia(true)
		render(
			<SidebarProvider defaultOpen={true}>
				<Sidebar collapsible="offcanvas">
					<div>expanded</div>
				</Sidebar>
			</SidebarProvider>,
		)
		const slot = document.querySelector('[data-slot="sidebar"]')
		expect(slot?.getAttribute('data-collapsible')).toBe('')
		expect(slot?.getAttribute('data-state')).toBe('expanded')
	})
})

/* -------------------------------------------------------------------------- */
/*  Triggers                                                                  */
/* -------------------------------------------------------------------------- */

describe('Sidebar — Triggers', () => {
	it('[T1] SidebarTrigger click toggles sidebar', () => {
		let captured: ReturnType<typeof useSidebar> | null = null
		render(
			<SidebarProvider defaultOpen={true}>
				<ContextProbe send={(ctx) => (captured = ctx)} />
				<SidebarTrigger />
			</SidebarProvider>,
		)
		expect(captured!.state).toBe('expanded')
		const trigger = document.querySelector(
			'[data-sidebar="trigger"]',
		) as HTMLButtonElement
		expect(trigger).not.toBeNull()
		act(() => trigger.click())
		expect(captured!.state).toBe('collapsed')
	})

	it('[T2] SidebarRail click toggles sidebar', () => {
		let captured: ReturnType<typeof useSidebar> | null = null
		render(
			<SidebarProvider defaultOpen={true}>
				<ContextProbe send={(ctx) => (captured = ctx)} />
				<SidebarRail />
			</SidebarProvider>,
		)
		const rail = document.querySelector(
			'[data-sidebar="rail"]',
		) as HTMLButtonElement
		expect(rail).not.toBeNull()
		act(() => rail.click())
		expect(captured!.state).toBe('collapsed')
	})

	it('[T3] SidebarTrigger has aria-label="Переключить меню" (RU canon)', () => {
		render(
			<SidebarProvider>
				<SidebarTrigger />
			</SidebarProvider>,
		)
		const trigger = document.querySelector('[data-sidebar="trigger"]')
		expect(trigger?.getAttribute('aria-label')).toBe('Переключить меню')
	})
})

