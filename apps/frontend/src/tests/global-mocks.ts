/**
 * Global mocks — canonical Vitest 4 shared-mocks pattern.
 *
 * Adapted from stankoff-v2 `apps/frontend/src/tests/global-mocks.ts`
 * (commit 2afcef0 «refactor(frontend-tests): canonical Vitest 4 shared
 * mocks via setupFile», 2026-05-07). Adopted in sochi 2026-05-12 per
 * `feedback_stankoff_testing_innovations_adoption.md`.
 *
 * Why setupFile (per stankoff research 2026-05-07 + Vitest mocking guide):
 *   - Single source of truth for shared mocks (TanStack Router Link, sonner
 *     toast). No drift between per-file vi.mock duplicates.
 *   - Foundation for future `isolate: false` migration when project's
 *     test infra matures (currently isolate:true; happy-dom).
 *   - `vi.hoisted` declares mock fns at module-init; `vi.mock` factories
 *     close over them. Tests reference `globalMocks.X.mockReturnValue(...)`
 *     directly without `vi.mocked()` ceremony.
 *
 * Pattern (`globalThis`-pinned):
 *   `globalThis.__SOCHI_TEST_MOCKS__` holds the SAME object both inside
 *   the `vi.mock` factory closure AND on the exported `globalMocks` const.
 *   Without globalThis pin, factory-closure context vs export context
 *   evaluate vi.hoisted separately → two-mocks bug (verified empirically
 *   stankoff 2026-05-07).
 *
 * Per-file local `vi.mock` calls still work (they override). Migration
 * plan: each new test imports `globalMocks` and skips local mock; existing
 * 4 frontend test files migrate in batched cleanup commit (separate scope).
 */

import { cleanup } from '@testing-library/react'
import * as React from 'react'
import * as actualRouter from '@tanstack/react-router'
import { afterEach, beforeEach, mock } from 'bun:test'

declare global {
	var __SOCHI_TEST_MOCKS__: ReturnType<typeof createMocks> | undefined
}

function createMocks() {
	return {
		// TanStack Router — navigation hooks return jest.fn defaults so tests
		// can assert `globalMocks.navigate.toHaveBeenCalledWith(...)`.
		navigate: mock(),
		routerInvalidate: mock(),

		// sonner — toast notifications; tests assert call args without
		// caring about UI render (Toaster is null-rendered).
		toast: Object.assign(mock(), {
			success: mock(),
			error: mock(),
			info: mock(),
			warning: mock(),
			loading: mock(),
			promise: mock(),
			dismiss: mock(),
		}),
	}
}

if (globalThis.__SOCHI_TEST_MOCKS__ === undefined) {
	globalThis.__SOCHI_TEST_MOCKS__ = createMocks()
}
const _mocks = globalThis.__SOCHI_TEST_MOCKS__

export const globalMocks = _mocks

// Mock TanStack Router globally. Tests that need DIFFERENT Link behaviour
// (custom href synthesis, route-aware param substitution) MAY override
// per-file via local `vi.mock`. The global default suffices for tests that
// just check «link rendered» / «navigate called».
//
// Wrapper fns dispatch live to `_mocks.X` on each call — без wrappers
// vi.mock factory snapshots the vi.fn ref at factory time and downstream
// `globalMocks.navigate.mockReturnValue(...)` doesn't propagate
// (canonical stankoff observation 2026-05-07).
mock.module('@tanstack/react-router', () => {
	return {
		...actualRouter,
		useNavigate: () => _mocks.navigate,
		useRouter: () => ({
			navigate: _mocks.navigate,
			invalidate: _mocks.routerInvalidate,
		}),
		Link: ({
			children,
			to,
			params,
			activeProps: _activeProps,
			activeOptions: _activeOptions,
			onClick,
			...rest
		}: {
			children: React.ReactNode
			to?: string
			params?: Record<string, string>
			activeProps?: unknown
			activeOptions?: unknown
			onClick?: (e: React.MouseEvent) => void
			[k: string]: unknown
		}) => {
			// Param substitution mirrors TanStack `$slug` → real value.
			const href =
				typeof to === 'string' && params
					? Object.entries(params).reduce(
							(acc, [k, v]) => acc.replace(`$${k}`, encodeURIComponent(v)),
							to,
						)
					: typeof to === 'string'
						? to
						: '#'
			return React.createElement(
				'a',
				{
					href,
					onClick,
					...(rest as React.AnchorHTMLAttributes<HTMLAnchorElement>),
				},
				children,
			)
		},
	}
})

// Mock sonner globally. `Toaster` returns null (unit tests don't render
// notifications visually); `toast.*` are vi.fn so tests assert calls.
mock.module('sonner', () => ({
	toast: _mocks.toast,
	Toaster: () => null,
}))

// Reset call history every test (clear, NOT reset — preserves the vi.fn impls
// set above; resetAllMocks would wipe them and tests would crash).
beforeEach(() => {
	mock.clearAllMocks()
})

// Cleanup between tests (forward-compatible с future isolate:false).
// `cleanup()` unmounts React trees rendered by @testing-library/react.
// `useRealTimers()` restores real timers. Storage clears prevent draft-state
// leakage between tests — guarded for happy-dom.
afterEach(() => {
	cleanup()
	if (typeof window !== 'undefined') {
		try {
			window.localStorage?.clear?.()
			window.sessionStorage?.clear?.()
		} catch {
			// happy-dom Storage stub may throw on .clear() — non-blocking.
		}
	}
})
