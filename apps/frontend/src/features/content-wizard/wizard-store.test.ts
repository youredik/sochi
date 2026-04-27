/**
 * `useContentWizardStore` — strict tests per `feedback_strict_tests.md`.
 *
 * Test matrix:
 *   ─── Initial state ───────────────────────────────────────────────
 *     [I1] step starts at 'compliance'
 *
 *   ─── goTo (random access via progress indicator clicks) ───────────
 *     [G1-G6] goTo each of 6 ContentStep values transitions exactly
 *
 *   ─── next() (sequential progression) ─────────────────────────────
 *     [N1-N5] next from each non-terminal step → expected successor
 *     [N6]    next from 'done' → stays 'done' (terminal idempotent)
 *
 *   ─── reset() ─────────────────────────────────────────────────────
 *     [R1] reset from any step → 'compliance'
 *
 *   ─── ORDER + LABELS exhaustive (drift surface) ───────────────────
 *     [E1] CONTENT_WIZARD_STEPS has all 6 ContentStep values, in canonical order
 *     [E2] STEP_LABELS has every ContentStep key with non-empty label
 */
import { afterEach, describe, expect, test } from 'vitest'
import {
	CONTENT_WIZARD_STEPS,
	type ContentStep,
	STEP_LABELS,
	useContentWizardStore,
} from './wizard-store.ts'

afterEach(() => {
	useContentWizardStore.getState().reset()
})

describe('useContentWizardStore — initial state', () => {
	test('[I1] step starts at "compliance"', () => {
		expect(useContentWizardStore.getState().step).toBe('compliance')
	})
})

describe('useContentWizardStore — goTo', () => {
	const allSteps: ContentStep[] = [
		'compliance',
		'amenities',
		'descriptions',
		'media',
		'addons',
		'done',
	]
	test.each(allSteps)('goTo("%s") sets step to %s', (s) => {
		useContentWizardStore.getState().goTo(s)
		expect(useContentWizardStore.getState().step).toBe(s)
	})
})

describe('useContentWizardStore — next() sequence', () => {
	test('[N1] compliance → amenities', () => {
		useContentWizardStore.getState().goTo('compliance')
		useContentWizardStore.getState().next()
		expect(useContentWizardStore.getState().step).toBe('amenities')
	})
	test('[N2] amenities → descriptions', () => {
		useContentWizardStore.getState().goTo('amenities')
		useContentWizardStore.getState().next()
		expect(useContentWizardStore.getState().step).toBe('descriptions')
	})
	test('[N3] descriptions → media', () => {
		useContentWizardStore.getState().goTo('descriptions')
		useContentWizardStore.getState().next()
		expect(useContentWizardStore.getState().step).toBe('media')
	})
	test('[N4] media → addons', () => {
		useContentWizardStore.getState().goTo('media')
		useContentWizardStore.getState().next()
		expect(useContentWizardStore.getState().step).toBe('addons')
	})
	test('[N5] addons → done', () => {
		useContentWizardStore.getState().goTo('addons')
		useContentWizardStore.getState().next()
		expect(useContentWizardStore.getState().step).toBe('done')
	})
	test('[N6] done → done (terminal idempotent — never falls off the end)', () => {
		useContentWizardStore.getState().goTo('done')
		useContentWizardStore.getState().next()
		expect(useContentWizardStore.getState().step).toBe('done')
	})
})

describe('useContentWizardStore — reset', () => {
	test('[R1] reset from "addons" → "compliance"', () => {
		useContentWizardStore.getState().goTo('addons')
		useContentWizardStore.getState().reset()
		expect(useContentWizardStore.getState().step).toBe('compliance')
	})
	test('[R2] reset from "done" → "compliance"', () => {
		useContentWizardStore.getState().goTo('done')
		useContentWizardStore.getState().reset()
		expect(useContentWizardStore.getState().step).toBe('compliance')
	})
})

describe('useContentWizardStore — exhaustive enum coverage', () => {
	test('[E1] CONTENT_WIZARD_STEPS contains exactly 6 steps in canonical order', () => {
		expect(CONTENT_WIZARD_STEPS).toEqual([
			'compliance',
			'amenities',
			'descriptions',
			'media',
			'addons',
			'done',
		])
	})

	test('[E2] STEP_LABELS has a non-empty label for every ContentStep', () => {
		for (const s of CONTENT_WIZARD_STEPS) {
			expect(STEP_LABELS[s]).toBeTruthy()
			expect(STEP_LABELS[s].length).toBeGreaterThan(0)
		}
	})
})
