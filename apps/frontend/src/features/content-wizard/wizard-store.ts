import { create } from 'zustand'

/**
 * Content-wizard state — Zustand, NOT TanStack-Query-backed (UI ephemeral,
 * forgotten on reload is correct: stale draft re-appearing would confuse).
 *
 * Распологается отдельно от `setup` wizard:
 *   - `setup`   создаёт первичный property+roomType+rooms+ratePlan (M5c).
 *   - `content` обогащает property compliance/amenities/descriptions/media/
 *               addons (M8.A.0). Run-only-once-per-property через KSR-id
 *               проверку, после operator может зайти точечно по табам.
 *
 * Шаги: compliance → amenities → descriptions → media → addons → done.
 *
 * propertyId выбирается на entry-route (не на шаге — иначе UX ломается:
 * compliance — уровень tenant, остальные четыре — уровень property; разный
 * скоуп должен быть контекстом, а не первым шагом).
 */

export type ContentStep = 'compliance' | 'amenities' | 'descriptions' | 'media' | 'addons' | 'done'

interface WizardState {
	step: ContentStep
	goTo: (step: ContentStep) => void
	next: () => void
	reset: () => void
}

const ORDER: readonly ContentStep[] = [
	'compliance',
	'amenities',
	'descriptions',
	'media',
	'addons',
	'done',
] as const

export const useContentWizardStore = create<WizardState>((set, get) => ({
	step: 'compliance',
	goTo: (step) => set({ step }),
	next: () => {
		const idx = ORDER.indexOf(get().step)
		const nextStep = ORDER[idx + 1] ?? 'done'
		set({ step: nextStep })
	},
	reset: () => set({ step: 'compliance' }),
}))

export const CONTENT_WIZARD_STEPS = ORDER

export const STEP_LABELS: Record<ContentStep, string> = {
	compliance: 'Compliance',
	amenities: 'Удобства',
	descriptions: 'Описание',
	media: 'Фото',
	addons: 'Услуги',
	done: 'Готово',
}
