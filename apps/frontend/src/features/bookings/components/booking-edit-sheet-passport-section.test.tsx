/**
 * Sprint C+ Round 7 P0 — strict component tests на PassportScanSection
 * (rendered inside booking-edit-sheet ActionView).
 *
 * Per `feedback_critical_fix_test_coverage_canon` + `project_axe_a11y_gate`.
 *
 * Tests:
 *   [S1] foreign + no scan + not loading → red Alert «109-ФЗ» + CTA primary variant
 *   [S2] foreign + loading → loading-foreign Alert (fail-closed)
 *   [S3] foreign + active scan → green Alert with masked tail + Rescan CTA
 *   [S4] RU + no scan → ru-no-scan muted Alert (с 24h disclaimer)
 *   [S5] just-scanned alert — masks PII (никогда не full surname/name/docNumber)
 *   [S6] persist-error renders destructive Alert role=alert
 *   [S7] axe-core WCAG 2.2 AA — no violations across all 5 visual states
 *
 * Component is internal к booking-edit-sheet (not exported). Tests render
 * just the section через small wrapper-helper, не full booking flow.
 */
import { cleanup, render, screen } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, describe, expect, test } from 'bun:test'
import type { BookingGuestSnapshot } from '@horeca/shared'
import type { PassportScanResult } from '../../passport-scan/components/passport-scan-dialog.tsx'
import type { ActiveGuestDocument } from '../../passport-scan/hooks/use-active-guest-document.ts'
// PassportScanSection is internal — re-import via the public sheet barrel.
// Tests don't need ActionView (which depends on react-query / router); we
// import the helper directly via vite-resolvable path.

// We cannot import the internal helper directly (not exported). Two options:
// (a) export PassportScanSection from booking-edit-sheet.tsx, OR
// (b) test through ActionView fully wired.
// (a) lighter, no router/query mocks. Choose (a).
import { PassportScanSection } from './booking-edit-sheet.tsx'

afterEach(cleanup)

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

async function auditA11y(container: HTMLElement, context: string) {
	const results = await axe.run(container, {
		runOnly: { type: 'tag', values: WCAG_TAGS },
		rules: {
			'color-contrast': { enabled: false },
			'landmark-one-main': { enabled: false },
			region: { enabled: false },
		},
	})
	if (results.violations.length > 0) {
		console.error(`axe violations (${context}):`, JSON.stringify(results.violations, null, 2))
	}
	return results.violations
}

const FOREIGN_GUEST: BookingGuestSnapshot = {
	firstName: 'David',
	lastName: 'Wong',
	citizenship: 'CHN',
	documentType: 'Загранпаспорт',
	documentNumber: 'E12345678',
}
const RU_GUEST: BookingGuestSnapshot = {
	firstName: 'Иван',
	lastName: 'Иванов',
	middleName: 'Иванович',
	citizenship: 'RU',
	documentType: 'Паспорт РФ',
	documentNumber: '4608 123456',
}
const ACTIVE_DOC: ActiveGuestDocument = {
	id: 'gdoc_test',
	identityMethod: 'passport_zagran',
	documentNumberMaskedTail: '5678',
	citizenshipIso3: 'chn',
	scannedAt: '2026-05-24T10:00:00.000Z',
}
const LAST_SCAN: PassportScanResult = {
	identityMethod: 'passport_zagran',
	entities: {
		surname: 'Wong',
		name: 'David',
		middleName: null,
		gender: 'male',
		citizenshipIso3: 'chn',
		birthDate: '1990-01-01',
		birthPlace: null,
		documentNumber: 'E12345678',
		issueDate: '2020-01-01',
		expirationDate: '2030-01-01',
	},
	confidenceHeuristic: 0.85,
	outcome: 'success',
	rklStatus: 'clean',
	photoConsentLogId: 'cns_test',
	consent152fzVersion: '2026-05-23d',
	consent152fzAcceptedAt: '2026-05-24T10:00:00.000Z',
}

describe('PassportScanSection — visual states', () => {
	test('[S1] foreign + no scan + not loading → red Alert «109-ФЗ» + primary CTA', () => {
		render(
			<PassportScanSection
				guestSnapshot={FOREIGN_GUEST}
				activeDoc={null}
				isLoading={false}
				isForeign={true}
				isPending={false}
				lastScan={null}
				scanPersistError={null}
				onScanClick={() => {}}
			/>,
		)
		// `getByText` throws if not present — line itself = assertion
		// (canonical RTL pattern; ratchet bans weak boolean asserts).
		const alert = screen.getByText(/Скан документа обязателен/)
		expect(alert.tagName).toBe('DIV')
		// 109-ФЗ canonical citation verbatim, NOT ПП-1912 (which = КСР registry context).
		screen.getByText(/109-ФЗ ст\. 22 ч\. 3/)
		screen.getByText(/ПП РФ № 9/)
		screen.getByText(/18\.9 КоАП/)
		// CTA visible с правильной meta.
		const cta = screen.getByRole('button', { name: 'Сканировать паспорт' })
		expect(cta.tagName).toBe('BUTTON')
		expect(cta.getAttribute('data-slot')).toBe('open-scan-dialog')
	})

	test('[S2] foreign + loading → loading-foreign Alert (fail-closed messaging)', () => {
		render(
			<PassportScanSection
				guestSnapshot={FOREIGN_GUEST}
				activeDoc={null}
				isLoading={true}
				isForeign={true}
				isPending={false}
				lastScan={null}
				scanPersistError={null}
				onScanClick={() => {}}
			/>,
		)
		screen.getByText(/Проверяем наличие скана/)
		// Заявление о fail-closed — заезд блокирован до проверки.
		screen.getByText(/Заезд иностранного гостя заблокирован/)
	})

	test('[S3] foreign + active scan → green Alert with masked tail', () => {
		render(
			<PassportScanSection
				guestSnapshot={FOREIGN_GUEST}
				activeDoc={ACTIVE_DOC}
				isLoading={false}
				isForeign={true}
				isPending={false}
				lastScan={null}
				scanPersistError={null}
				onScanClick={() => {}}
			/>,
		)
		screen.getByText('Документ отсканирован')
		// Wong D. = lastName + first-initial.
		screen.getByText(/Wong D\..*Загранпаспорт.*…5678.*CHN/)
		// CTA label switched to «Пересканировать».
		const rescanBtn = screen.getByRole('button', { name: 'Пересканировать паспорт' })
		expect(rescanBtn.tagName).toBe('BUTTON')
	})

	test('[S4] RU + no scan → ru-no-scan Alert с 24h other-region disclaimer', () => {
		render(
			<PassportScanSection
				guestSnapshot={RU_GUEST}
				activeDoc={null}
				isLoading={false}
				isForeign={false}
				isPending={false}
				lastScan={null}
				scanPersistError={null}
				onScanClick={() => {}}
			/>,
		)
		// Не вводит operator в заблуждение «опционально» без context — теперь
		// explicit 24h disclosure для RU other-region per 109-ФЗ ст. 19.
		screen.getByText(/гражданина РФ из того же региона/)
		screen.getByText(/24 часов/)
		screen.getByText(/109-ФЗ ст\. 19/)
	})

	test('[S5] just-scanned alert — masks PII (NO full surname/name/docNumber)', () => {
		const { container } = render(
			<PassportScanSection
				guestSnapshot={FOREIGN_GUEST}
				activeDoc={null}
				isLoading={false}
				isForeign={true}
				isPending={false}
				lastScan={LAST_SCAN}
				scanPersistError={null}
				onScanClick={() => {}}
			/>,
		)
		// Title visible.
		screen.getByText(/OCR-данные сохранены/)
		// Masked: W. D. • №…5678. NEVER full PII.
		screen.getByText(/W\. D\. • №…5678/)
		// Adversarial: full PII strings MUST NOT appear anywhere в DOM.
		const html = container.innerHTML
		expect(html).not.toContain('Wong')
		expect(html).not.toContain('David')
		expect(html).not.toContain('E12345678')
	})

	test('[S6] persist-error renders destructive Alert role=alert', () => {
		render(
			<PassportScanSection
				guestSnapshot={FOREIGN_GUEST}
				activeDoc={null}
				isLoading={false}
				isForeign={true}
				isPending={false}
				lastScan={null}
				scanPersistError="Backend не вернул photoConsentLogId"
				onScanClick={() => {}}
			/>,
		)
		const errorAlerts = screen.getAllByRole('alert')
		const persistError = errorAlerts.find((a) => a.getAttribute('data-state') === 'persist-error')
		expect(persistError).not.toBeUndefined()
		expect(persistError?.textContent).toContain('Документ не сохранён')
		expect(persistError?.textContent).toContain('Backend не вернул photoConsentLogId')
	})
})

describe('PassportScanSection — axe-core WCAG 2.2 AA', () => {
	test('[S7-a] foreign-no-scan state → 0 violations', async () => {
		const { container } = render(
			<PassportScanSection
				guestSnapshot={FOREIGN_GUEST}
				activeDoc={null}
				isLoading={false}
				isForeign={true}
				isPending={false}
				lastScan={null}
				scanPersistError={null}
				onScanClick={() => {}}
			/>,
		)
		const violations = await auditA11y(container, 'foreign-no-scan')
		expect(violations).toHaveLength(0)
	})

	test('[S7-b] has-active-scan state → 0 violations', async () => {
		const { container } = render(
			<PassportScanSection
				guestSnapshot={FOREIGN_GUEST}
				activeDoc={ACTIVE_DOC}
				isLoading={false}
				isForeign={true}
				isPending={false}
				lastScan={null}
				scanPersistError={null}
				onScanClick={() => {}}
			/>,
		)
		const violations = await auditA11y(container, 'has-active-scan')
		expect(violations).toHaveLength(0)
	})

	test('[S7-c] ru-no-scan state → 0 violations', async () => {
		const { container } = render(
			<PassportScanSection
				guestSnapshot={RU_GUEST}
				activeDoc={null}
				isLoading={false}
				isForeign={false}
				isPending={false}
				lastScan={null}
				scanPersistError={null}
				onScanClick={() => {}}
			/>,
		)
		const violations = await auditA11y(container, 'ru-no-scan')
		expect(violations).toHaveLength(0)
	})

	test('[S7-d] loading-foreign state → 0 violations', async () => {
		const { container } = render(
			<PassportScanSection
				guestSnapshot={FOREIGN_GUEST}
				activeDoc={null}
				isLoading={true}
				isForeign={true}
				isPending={false}
				lastScan={null}
				scanPersistError={null}
				onScanClick={() => {}}
			/>,
		)
		const violations = await auditA11y(container, 'loading-foreign')
		expect(violations).toHaveLength(0)
	})

	test('[S7-e] persist-error + just-scanned compound state → 0 violations', async () => {
		const { container } = render(
			<PassportScanSection
				guestSnapshot={FOREIGN_GUEST}
				activeDoc={null}
				isLoading={false}
				isForeign={true}
				isPending={false}
				lastScan={LAST_SCAN}
				scanPersistError="error message"
				onScanClick={() => {}}
			/>,
		)
		const violations = await auditA11y(container, 'persist-error+just-scanned')
		expect(violations).toHaveLength(0)
	})
})
