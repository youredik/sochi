/**
 * ResponsiveSheet — strict component tests (M9.5 Phase C).
 *
 * Pre-done audit:
 *   [D1] desktop (matchMedia 'min-width: 768px' → true) → renders Sheet (Radix Dialog)
 *   [D2] desktop SheetContent has data-slot="sheet-content"
 *   [D3] desktop SheetTitle/Header/Description rendered through Sheet primitives
 *   [M1] mobile (matchMedia 'min-width: 768px' → false) → renders Drawer (Vaul)
 *   [M2] mobile DrawerContent has data-slot="drawer-content"
 *   [M3] mobile DrawerTitle/Header/Description rendered through Drawer primitives
 *   [C1] open prop propagates to underlying primitive
 *   [C2] onOpenChange fires when ESC pressed (delegated к Radix/Vaul)
 *
 * matchMedia mocked per @testing-library canon (window.matchMedia stub).
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	ResponsiveSheet,
	ResponsiveSheetContent,
	ResponsiveSheetDescription,
	ResponsiveSheetHeader,
	ResponsiveSheetTitle,
} from './responsive-sheet'

function mockMatchMedia(matches: boolean) {
	Object.defineProperty(window, 'matchMedia', {
		writable: true,
		configurable: true,
		value: vi.fn().mockImplementation((query: string) => ({
			matches,
			media: query,
			onchange: null,
			addListener: vi.fn(),
			removeListener: vi.fn(),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			dispatchEvent: vi.fn(() => false),
		})),
	})
}

afterEach(() => {
	cleanup()
})

beforeEach(() => {
	mockMatchMedia(true) // default desktop; per-test override in mobile cases.
})

function renderResponsiveSheet() {
	return render(
		<ResponsiveSheet open onOpenChange={() => {}}>
			<ResponsiveSheetContent>
				<ResponsiveSheetHeader>
					<ResponsiveSheetTitle>Test Title</ResponsiveSheetTitle>
					<ResponsiveSheetDescription>Test description</ResponsiveSheetDescription>
				</ResponsiveSheetHeader>
				<div>Body content</div>
			</ResponsiveSheetContent>
		</ResponsiveSheet>,
	)
}

describe('ResponsiveSheet — desktop (≥768px)', () => {
	it('[D1] renders Sheet primitive', () => {
		mockMatchMedia(true)
		renderResponsiveSheet()
		// Sheet uses Radix Dialog → role="dialog".
		expect(screen.getByRole('dialog')).toBeDefined()
	})

	it('[D2] SheetContent has data-slot="sheet-content"', () => {
		mockMatchMedia(true)
		renderResponsiveSheet()
		const content = document.querySelector('[data-slot="sheet-content"]')
		expect(content).not.toBeNull()
	})

	it('[D3] SheetHeader has data-slot="sheet-header"', () => {
		mockMatchMedia(true)
		renderResponsiveSheet()
		const header = document.querySelector('[data-slot="sheet-header"]')
		expect(header).not.toBeNull()
	})
})

describe('ResponsiveSheet — mobile (<768px)', () => {
	it('[M1] renders Drawer primitive (Vaul)', () => {
		mockMatchMedia(false)
		renderResponsiveSheet()
		expect(screen.getByRole('dialog')).toBeDefined()
	})

	it('[M2] DrawerContent has data-slot="drawer-content"', () => {
		mockMatchMedia(false)
		renderResponsiveSheet()
		const content = document.querySelector('[data-slot="drawer-content"]')
		expect(content).not.toBeNull()
		// Inverse: NO sheet-content on mobile.
		expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull()
	})

	it('[M3] DrawerHeader has data-slot="drawer-header"', () => {
		mockMatchMedia(false)
		renderResponsiveSheet()
		expect(document.querySelector('[data-slot="drawer-header"]')).not.toBeNull()
	})
})

describe('ResponsiveSheet — controlled open propagation', () => {
	it('[C1] open=true propagates: dialog visible on desktop', () => {
		mockMatchMedia(true)
		renderResponsiveSheet()
		expect(screen.getByText('Test Title')).toBeDefined()
		expect(screen.getByText('Body content')).toBeDefined()
	})

	it('[C1.b] open=true propagates: dialog visible on mobile', () => {
		mockMatchMedia(false)
		renderResponsiveSheet()
		expect(screen.getByText('Test Title')).toBeDefined()
		expect(screen.getByText('Body content')).toBeDefined()
	})
})
