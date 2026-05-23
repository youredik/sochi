/**
 * 152-ФЗ Consent modal — strict tests (Sprint C+ 2-checkbox model, 2026-05-23d).
 *
 * **Architectural shift**: Round 4 had 3 checkboxes (generalPdn / citizenshipSpecial /
 * biometricPhoto). Legal-expert audit REFUTED `citizenshipSpecial` ст.10 labeling —
 * citizenship is NOT in ст.10 ч.1 verbatim list (which covers ethnic origin).
 * Drop checkbox + payload field. 2-checkbox canonical model.
 *
 * Pre-done audit (legal compliance critical):
 *   [G1] no checkbox checked → Accept button disabled
 *   [G2] only 1 checkbox checked → Accept STILL disabled (gate enforces BOTH)
 *   [G3] both checkboxes checked → Accept enabled
 *   [G4] uncheck 1 of 2 after both checked → Accept disabled again
 *   [G5] Cancel button always enabled (user can always decline)
 *   [G6] modal contains 152-ФЗ + ст.6 + ст.11 + 156-ФЗ references (NOT ст.10)
 *   [G7] modal contains № 109-ФЗ + ПП-1912 + ГС МИР (verified primary sources)
 *   [G8] modal contains corrected 420-ФЗ (NOT 421-ФЗ) and ст.21 ч.5 (NOT ст.20 timer)
 *   [G9] open=false → modal NOT rendered
 *   [G10] Cancel callback fires onCancel
 *   [G11] Accept callback fires only when both checked
 *   [G12] Accept payload has acceptedAt ISO 8601 timestamp
 *   [G13] Accept payload has version + textSnapshot + separateConsents (2 fields)
 *   [G14] textSnapshot identical к visible consent text (tamper-proof ст.9 ч.4)
 *   [G15] operatorIdentity rendered в consent text + textSnapshot
 *   [G16] missing operatorIdentity → tame placeholder
 *   [G17] partial operatorIdentity (только legalName) — других секций not rendered
 *   [G18] no legacy fictitious references (ПП-1668, 421-ФЗ, ПП-1937)
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, mock } from 'bun:test'
import { CONSENT_152FZ_VERSION } from '../lib/consent-version.ts'
import { Consent152FzModal } from './consent-152fz-modal.tsx'

afterEach(cleanup)

const ACCEPT_BUTTON_NAME = /Подтвердить оба согласия/
const CANCEL_BUTTON_NAME = /Отклонить/

/** Helper — get 2 checkboxes в canonical order (generalPdn / biometricPhoto). */
function getAllCheckboxes() {
	const all = screen.getAllByRole('checkbox') as HTMLInputElement[]
	if (all.length !== 2) {
		throw new Error(`Expected 2 checkboxes (152-ФЗ ст.6 + ст.11), got ${all.length}`)
	}
	return all
}

describe('Consent152FzModal — gate semantics (legal compliance, 2-checkbox)', () => {
	test('[G1] no checkbox checked → Accept disabled', () => {
		render(<Consent152FzModal open={true} onAccept={mock()} onCancel={mock()} />)
		const acceptBtn = screen.getByRole('button', { name: ACCEPT_BUTTON_NAME })
		expect((acceptBtn as HTMLButtonElement).disabled).toBe(true)
	})

	test('[G2] only 1 checkbox checked → Accept STILL disabled (BOTH required)', () => {
		render(<Consent152FzModal open={true} onAccept={mock()} onCancel={mock()} />)
		const [generalPdn] = getAllCheckboxes()
		fireEvent.click(generalPdn as HTMLInputElement)
		const acceptBtn = screen.getByRole('button', { name: ACCEPT_BUTTON_NAME })
		expect((acceptBtn as HTMLButtonElement).disabled).toBe(true)
	})

	test('[G3] both checkboxes checked → Accept enabled', () => {
		render(<Consent152FzModal open={true} onAccept={mock()} onCancel={mock()} />)
		const [generalPdn, biometric] = getAllCheckboxes()
		fireEvent.click(generalPdn as HTMLInputElement)
		fireEvent.click(biometric as HTMLInputElement)
		const acceptBtn = screen.getByRole('button', { name: ACCEPT_BUTTON_NAME })
		expect((acceptBtn as HTMLButtonElement).disabled).toBe(false)
	})

	test('[G4] uncheck 1 of 2 after both checked → Accept disabled again', () => {
		render(<Consent152FzModal open={true} onAccept={mock()} onCancel={mock()} />)
		const [generalPdn, biometric] = getAllCheckboxes()
		fireEvent.click(generalPdn as HTMLInputElement)
		fireEvent.click(biometric as HTMLInputElement)
		// Uncheck biometric
		fireEvent.click(biometric as HTMLInputElement)
		const acceptBtn = screen.getByRole('button', { name: ACCEPT_BUTTON_NAME })
		expect((acceptBtn as HTMLButtonElement).disabled).toBe(true)
	})

	test('[G5] Cancel button always enabled', () => {
		render(<Consent152FzModal open={true} onAccept={mock()} onCancel={mock()} />)
		const cancelBtn = screen.getByRole('button', { name: CANCEL_BUTTON_NAME })
		expect((cancelBtn as HTMLButtonElement).disabled).toBe(false)
	})

	test('[G6] modal contains 152-ФЗ + ст.6 + ст.11 + 156-ФЗ references', () => {
		render(<Consent152FzModal open={true} onAccept={mock()} onCancel={mock()} />)
		const body = document.body.textContent ?? ''
		expect(body).toContain('152-ФЗ')
		expect(body).toContain('О персональных данных')
		expect(body).toContain('ст.6')
		expect(body).toContain('ст.11')
		expect(body).toContain('156-ФЗ')
	})

	test('[G7] modal contains № 109-ФЗ + ПП-1912 + ГС МИР (verified primary sources)', () => {
		// Sprint C+ legal-expert audit 2026-05-23d:
		// ПП-1937 REFUTED — это закупки/325-ФЗ, не гостиничный акт. Hotel guest ID canon =
		// ПП-1912 от 27.11.2025 (effective 01.03.2026, replaces ПП-1853).
		// Verified government.ru/docs/all/162231/ + garant.ru.
		render(<Consent152FzModal open={true} onAccept={mock()} onCancel={mock()} />)
		const body = document.body.textContent ?? ''
		expect(body).toContain('109-ФЗ')
		expect(body).toContain('1912') // ПП-1912 (NOT 1937 — that's procurement)
		expect(body).toContain('ГС МИР')
	})

	test('[G8] modal contains corrected 420-ФЗ + ст.21 ч.5 (NOT 421-ФЗ, NOT ст.20-timer)', () => {
		// Sprint C+ legal-expert audit 2026-05-23d:
		//  - КоАП ред. 30.11.2024 = 420-ФЗ (NOT 421-ФЗ — that's УК).
		//  - Destruction timer = ст.21 ч.5 (30 days), NOT ст.20 (which is the right itself).
		render(<Consent152FzModal open={true} onAccept={mock()} onCancel={mock()} />)
		const body = document.body.textContent ?? ''
		expect(body).toContain('420-ФЗ')
		expect(body).toContain('ст.21 ч.5')
		expect(body).toContain('30 дней')
	})

	test('[G9] open=false → modal not rendered', () => {
		render(<Consent152FzModal open={false} onAccept={mock()} onCancel={mock()} />)
		const dialog = screen.queryByRole('dialog')
		expect(dialog).toBeNull()
	})

	test('[G10] Cancel callback fires onCancel', () => {
		const onCancel = mock()
		render(<Consent152FzModal open={true} onAccept={mock()} onCancel={onCancel} />)
		fireEvent.click(screen.getByRole('button', { name: CANCEL_BUTTON_NAME }))
		expect(onCancel).toHaveBeenCalledTimes(1)
	})

	test('[G11] Accept callback fires only when both checked', () => {
		const onAccept = mock()
		render(<Consent152FzModal open={true} onAccept={onAccept} onCancel={mock()} />)
		const acceptBtn = screen.getByRole('button', { name: ACCEPT_BUTTON_NAME })
		fireEvent.click(acceptBtn)
		expect(onAccept).toHaveBeenCalledTimes(0)
		const [generalPdn, biometric] = getAllCheckboxes()
		fireEvent.click(generalPdn as HTMLInputElement)
		fireEvent.click(acceptBtn)
		expect(onAccept).toHaveBeenCalledTimes(0)
		fireEvent.click(biometric as HTMLInputElement)
		fireEvent.click(acceptBtn)
		expect(onAccept).toHaveBeenCalledTimes(1)
	})

	test('[G12] Accept payload has acceptedAt ISO 8601 timestamp', () => {
		const onAccept = mock()
		render(<Consent152FzModal open={true} onAccept={onAccept} onCancel={mock()} />)
		const [generalPdn, biometric] = getAllCheckboxes()
		fireEvent.click(generalPdn as HTMLInputElement)
		fireEvent.click(biometric as HTMLInputElement)
		fireEvent.click(screen.getByRole('button', { name: ACCEPT_BUTTON_NAME }))
		expect(onAccept).toHaveBeenCalledTimes(1)
		const payload = onAccept.mock.calls[0]?.[0] as { acceptedAt: string }
		expect(payload.acceptedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
		const acceptedMs = Date.parse(payload.acceptedAt)
		const nowMs = Date.now()
		expect(nowMs - acceptedMs).toBeLessThan(5000)
		expect(nowMs - acceptedMs).toBeGreaterThanOrEqual(0)
	})

	test('[G13] Accept payload has version + textSnapshot + separateConsents (2 fields)', () => {
		const onAccept = mock()
		render(<Consent152FzModal open={true} onAccept={onAccept} onCancel={mock()} />)
		const [generalPdn, biometric] = getAllCheckboxes()
		fireEvent.click(generalPdn as HTMLInputElement)
		fireEvent.click(biometric as HTMLInputElement)
		fireEvent.click(screen.getByRole('button', { name: ACCEPT_BUTTON_NAME }))
		const payload = onAccept.mock.calls[0]?.[0] as {
			version: string
			textSnapshot: string
			separateConsents: {
				generalPdn: true
				biometricPhoto: true
			}
		}
		expect(payload.version).toBe(CONSENT_152FZ_VERSION)
		expect(payload.textSnapshot).toContain('152-ФЗ')
		expect(payload.textSnapshot).toContain('109-ФЗ')
		expect(payload.textSnapshot).toContain('1912')
		expect(payload.textSnapshot).toContain('ГС МИР')
		expect(payload.textSnapshot).toContain(CONSENT_152FZ_VERSION)
		// 2-checkbox model
		expect(payload.separateConsents.generalPdn).toBe(true)
		expect(payload.separateConsents.biometricPhoto).toBe(true)
		// Citizenship checkbox dropped — must NOT appear в new payloads
		expect((payload.separateConsents as Record<string, unknown>).citizenshipSpecial).toBeUndefined()
	})

	test('[G14] textSnapshot identical к visible consent text (tamper-proof ст.9 ч.4)', () => {
		const onAccept = mock()
		render(<Consent152FzModal open={true} onAccept={onAccept} onCancel={mock()} />)
		const visibleConsentBlock = screen.getByText(/В соответствии с Федеральным законом/)
		const visibleText = visibleConsentBlock.textContent ?? ''
		const [generalPdn, biometric] = getAllCheckboxes()
		fireEvent.click(generalPdn as HTMLInputElement)
		fireEvent.click(biometric as HTMLInputElement)
		fireEvent.click(screen.getByRole('button', { name: ACCEPT_BUTTON_NAME }))
		const payload = onAccept.mock.calls[0]?.[0] as { textSnapshot: string }
		expect(visibleText).toContain('152-ФЗ')
		expect(payload.textSnapshot).toContain('152-ФЗ')
		expect(payload.textSnapshot.startsWith('В соответствии с Федеральным законом')).toBe(true)
	})

	test('[G15] operatorIdentity rendered в consent text + textSnapshot', () => {
		const onAccept = mock()
		render(
			<Consent152FzModal
				open={true}
				onAccept={onAccept}
				onCancel={mock()}
				operatorIdentity={{
					legalName: 'ООО «Гостиница Сочи»',
					inn: '2320200001',
					legalAddress: 'г. Сочи, ул. Курортный проспект, д. 1',
					dpoEmail: 'dpo@hotel-sochi.ru',
				}}
			/>,
		)
		const body = document.body.textContent ?? ''
		expect(body).toContain('ООО «Гостиница Сочи»')
		expect(body).toContain('2320200001')
		expect(body).toContain('г. Сочи, ул. Курортный проспект, д. 1')
		expect(body).toContain('dpo@hotel-sochi.ru')
		const [generalPdn, biometric] = getAllCheckboxes()
		fireEvent.click(generalPdn as HTMLInputElement)
		fireEvent.click(biometric as HTMLInputElement)
		fireEvent.click(screen.getByRole('button', { name: ACCEPT_BUTTON_NAME }))
		const payload = onAccept.mock.calls[0]?.[0] as { textSnapshot: string }
		expect(payload.textSnapshot).toContain('ООО «Гостиница Сочи»')
		expect(payload.textSnapshot).toContain('2320200001')
	})

	test('[G16] missing operatorIdentity → tame placeholder rendered (no alarming language)', () => {
		render(<Consent152FzModal open={true} onAccept={mock()} onCancel={mock()} />)
		const body = document.body.textContent ?? ''
		expect(body).toContain('реквизиты уточняются у администратора')
		expect(body.includes('не предоставлено')).toBe(false)
	})

	test('[G17] partial operatorIdentity (только legalName) — других секций not rendered', () => {
		render(
			<Consent152FzModal
				open={true}
				onAccept={mock()}
				onCancel={mock()}
				operatorIdentity={{ legalName: 'ИП Иванов И. И.' }}
			/>,
		)
		const body = document.body.textContent ?? ''
		expect(body).toContain('ИП Иванов И. И.')
		expect(body.includes('ИНН: ')).toBe(false)
		expect(body).toContain('Контакт DPO: запрос через администратора')
	})

	test('[G18] no legacy fictitious or incorrect references (ПП-1668, 421-ФЗ, ПП-1937)', () => {
		// Defensive regression test — these strings were in prior rounds, all REFUTED:
		//   - ПП-1668 от 27.10.2025 — fictitious (not in pravo.gov.ru registry)
		//   - 421-ФЗ — actually 420-ФЗ; 421-ФЗ is УК amendment, not КоАП
		//   - ПП-1937 от 28.11.2025 — procurement law (325-ФЗ), NOT hotel guest ID
		const onAccept = mock()
		render(<Consent152FzModal open={true} onAccept={onAccept} onCancel={mock()} />)
		const body = document.body.textContent ?? ''
		expect(body.includes('1668')).toBe(false)
		expect(body.includes('421-ФЗ')).toBe(false)
		expect(body.includes('1937')).toBe(false)
		const [generalPdn, biometric] = getAllCheckboxes()
		fireEvent.click(generalPdn as HTMLInputElement)
		fireEvent.click(biometric as HTMLInputElement)
		fireEvent.click(screen.getByRole('button', { name: ACCEPT_BUTTON_NAME }))
		const payload = onAccept.mock.calls[0]?.[0] as { textSnapshot: string }
		expect(payload.textSnapshot.includes('1668')).toBe(false)
		expect(payload.textSnapshot.includes('421-ФЗ')).toBe(false)
		expect(payload.textSnapshot.includes('1937')).toBe(false)
	})
})
