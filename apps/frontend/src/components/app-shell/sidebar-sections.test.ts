/**
 * sidebar-sections — strict tests (A.bis.2 single source of truth).
 *
 * Pre-done audit (per `feedback_strict_tests.md`):
 *   Schema integrity:
 *     [I1] exactly 7 sections (no vapor / no disabled-future per D30)
 *     [I2] all section ids unique
 *     [I3] every section has labelRu (non-empty)
 *     [I4] every section has ariaLabelRu (non-empty, distinct from labelRu)
 *     [I5] every section has icon component (lucide forwardRef object)
 *     [I6] every section has TanStack route path starting `/o/$orgSlug/`
 *     [I7] only `profile` section has needsPropertyId=true (1 dynamic-param row)
 *     [I8] every section has isVisible function
 *     [I9] SIDEBAR_SECTIONS_BY_ID cardinality matches list
 *     [I10] frozen / readonly canon — no mutation accepted
 *
 *   RBAC × roles × sections matrix (21 visibility cells, exact-value):
 *     [V owner-grid..notifications]   — owner sees all 7
 *     [V manager-grid..notifications] — manager sees all 7 (no Settings; D29)
 *     [V staff-grid..notifications]   — staff sees 3 (grid + profile + guests)
 *
 *   Enum FULL coverage:
 *     [E1] role × section matrix dims = 3 × 7 = 21 cells (no rows omitted)
 *     [E2] expected staff-visible set = {grid, profile, guests} exact (3 not >=)
 *     [E3] expected owner-visible set = expected manager-visible set = full 7 exact
 */
import type { MemberRole } from '@horeca/shared'
import { describe, expect, it } from 'bun:test'
import { SIDEBAR_SECTIONS, SIDEBAR_SECTIONS_BY_ID } from './sidebar-sections'

const ALL_SECTION_IDS = [
	'grid',
	'receivables',
	'profile',
	'guests',
	'channels',
	'tax',
	'notifications',
] as const

const STAFF_VISIBLE = ['grid', 'profile', 'guests'] as const
const FULL_VISIBLE = ALL_SECTION_IDS

const VISIBILITY_MATRIX: Record<MemberRole, readonly (typeof ALL_SECTION_IDS)[number][]> = {
	owner: FULL_VISIBLE,
	manager: FULL_VISIBLE,
	staff: STAFF_VISIBLE,
}

/* -------------------------------------------------------------------------- */
/*  Schema integrity                                                          */
/* -------------------------------------------------------------------------- */

describe('sidebar-sections — schema integrity', () => {
	it('[I1] exactly 7 sections (no vapor / no disabled-future per D30)', () => {
		expect(SIDEBAR_SECTIONS.length).toBe(7)
	})

	it('[I2] all section ids unique', () => {
		const ids = SIDEBAR_SECTIONS.map((s) => s.id)
		expect(new Set(ids).size).toBe(7)
	})

	it('[I3] every section has labelRu (non-empty)', () => {
		for (const section of SIDEBAR_SECTIONS) {
			expect(typeof section.labelRu).toBe('string')
			expect(section.labelRu.length).toBeGreaterThan(0)
		}
	})

	it('[I4] every section has ariaLabelRu non-empty AND distinct from labelRu', () => {
		// Plan D15 — aria-label is canonical SR name, tooltip/text is secondary.
		// Equal aria-label and text label is the «no-effort accessibility» smell.
		for (const section of SIDEBAR_SECTIONS) {
			expect(typeof section.ariaLabelRu).toBe('string')
			expect(section.ariaLabelRu.length).toBeGreaterThan(0)
			expect(section.ariaLabelRu).not.toBe(section.labelRu)
		}
	})

	it('[I5] every section has icon component (lucide forwardRef object)', () => {
		for (const section of SIDEBAR_SECTIONS) {
			expect(section.icon).toBeDefined()
			// lucide icons are forwardRef objects (not plain functions).
			expect(['function', 'object']).toContain(typeof section.icon)
		}
	})

	it('[I6] every section has TanStack route path starting `/o/$orgSlug/`', () => {
		for (const section of SIDEBAR_SECTIONS) {
			expect(section.to.startsWith('/o/$orgSlug/')).toBe(true)
		}
	})

	it('[I7] exactly 1 section has needsPropertyId=true (profile)', () => {
		const dynamic = SIDEBAR_SECTIONS.filter((s) => s.needsPropertyId === true)
		expect(dynamic.length).toBe(1)
		expect(dynamic[0]?.id).toBe('profile')
		expect(dynamic[0]?.to).toBe('/o/$orgSlug/properties/$propertyId/content')
	})

	it('[I8] every section has isVisible function', () => {
		for (const section of SIDEBAR_SECTIONS) {
			expect(typeof section.isVisible).toBe('function')
		}
	})

	it('[I9] SIDEBAR_SECTIONS_BY_ID cardinality matches list (no missing/extra)', () => {
		expect(Object.keys(SIDEBAR_SECTIONS_BY_ID).length).toBe(7)
		for (const id of ALL_SECTION_IDS) {
			expect(SIDEBAR_SECTIONS_BY_ID[id]?.id).toBe(id)
		}
	})

	it('[I10] SIDEBAR_SECTIONS_BY_ID is frozen (Object.freeze canon)', () => {
		expect(Object.isFrozen(SIDEBAR_SECTIONS_BY_ID)).toBe(true)
	})
})

/* -------------------------------------------------------------------------- */
/*  RBAC × roles × sections matrix (21 visibility cells)                      */
/* -------------------------------------------------------------------------- */

describe('sidebar-sections — RBAC × 3 roles × 7 sections (21 visibility cells)', () => {
	for (const role of ['owner', 'manager', 'staff'] as const) {
		const expectedVisible = new Set(VISIBILITY_MATRIX[role])
		for (const id of ALL_SECTION_IDS) {
			const expected = expectedVisible.has(id)
			it(`[V ${role}-${id}] role=${role}, section=${id} → expected ${expected}`, () => {
				const section = SIDEBAR_SECTIONS_BY_ID[id]
				expect(section).toBeDefined()
				expect(section!.isVisible(role)).toBe(expected)
			})
		}
	}
})

/* -------------------------------------------------------------------------- */
/*  Enum FULL coverage (per feedback_strict_tests.md)                         */
/* -------------------------------------------------------------------------- */

describe('sidebar-sections — Enum FULL coverage', () => {
	it('[E1] role × section matrix dims = 3 × 7 = 21 cells covered', () => {
		// Sanity: matrix declared above iterates 3 roles × 7 ids = 21 cells.
		const cellCount = Object.keys(VISIBILITY_MATRIX).length * ALL_SECTION_IDS.length
		expect(cellCount).toBe(21)
	})

	it('[E2] staff-visible set EXACTLY {grid, profile, guests}', () => {
		const visible = SIDEBAR_SECTIONS.filter((s) => s.isVisible('staff'))
			.map((s) => s.id)
			.sort()
		expect(visible).toEqual([...STAFF_VISIBLE].sort())
	})

	it('[E3] owner-visible set = manager-visible set = ALL 7 sections (exact)', () => {
		const ownerVisible = SIDEBAR_SECTIONS.filter((s) => s.isVisible('owner'))
			.map((s) => s.id)
			.sort()
		const managerVisible = SIDEBAR_SECTIONS.filter((s) => s.isVisible('manager'))
			.map((s) => s.id)
			.sort()
		const expectedAll = [...FULL_VISIBLE].sort()
		expect(ownerVisible).toEqual(expectedAll)
		expect(managerVisible).toEqual(expectedAll)
		expect(ownerVisible).toEqual(managerVisible)
	})
})
