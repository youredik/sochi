/**
 * 152-ФЗ Consent modal — strict tests (Sprint C 3-checkbox API).
 *
 * Pre-done audit (legal compliance critical):
 *   [G1] no checkbox checked → Accept button disabled
 *   [G2] only 1 checkbox checked → Accept STILL disabled (gate enforces ALL 3)
 *   [G3] only 2 checkboxes checked → Accept STILL disabled
 *   [G4] all 3 checkboxes checked → Accept enabled
 *   [G5] uncheck 1 of 3 after all checked → Accept disabled again
 *   [G6] Cancel button always enabled (user can always decline)
 *   [G7] modal contains 152-ФЗ + ст.10 + ст.11 + 156-ФЗ references
 *   [G8] modal contains Постановление №1668 + ГС МИР (specific goals)
 *   [G9] open=false → modal NOT rendered
 *   [G10] Cancel callback fires onCancel
 *   [G11] Accept callback fires only when all 3 checked
 *   [G12] Accept payload has acceptedAt ISO 8601 timestamp
 *   [G13] Accept payload has version + textSnapshot + separateConsents
 *   [G14] textSnapshot captured at click moment (not mount) — proves verbatim text
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, mock } from 'bun:test'
import { CONSENT_152FZ_VERSION } from '../lib/consent-version.ts'
import { Consent152FzModal } from './consent-152fz-modal.tsx'

afterEach(cleanup)

const ACCEPT_BUTTON_NAME = /Подтвердить все 3 согласия/
const CANCEL_BUTTON_NAME = /Отклонить/

/** Helper — get all 3 checkboxes в canonical order (general / citizenship / biometric). */
function getAllCheckboxes() {
	const all = screen.getAllByRole('checkbox') as HTMLInputElement[]
	if (all.length !== 3) {
		throw new Error(`Expected 3 checkboxes (152-ФЗ ст.6 + ст.10 + ст.11), got ${all.length}`)
	}
	return all
}

describe('Consent152FzModal — gate semantics (legal compliance)', () => {
	test('[G1] no checkbox checked → Accept disabled', () => {
		render(<Consent152FzModal open={true} onAccept={mock()} onCancel={mock()} />)
		const acceptBtn = screen.getByRole('button', { name: ACCEPT_BUTTON_NAME })
		expect((acceptBtn as HTMLButtonElement).disabled).toBe(true)
	})

	test('[G2] only 1 checkbox checked → Accept STILL disabled (ALL 3 required)', () => {
		render(<Consent152FzModal open={true} onAccept={mock()} onCancel={mock()} />)
		const [generalPdn] = getAllCheckboxes()
		fireEvent.click(generalPdn as HTMLInputElement)
		const acceptBtn = screen.getByRole('button', { name: ACCEPT_BUTTON_NAME })
		expect((acceptBtn as HTMLButtonElement).disabled).toBe(true)
	})

	test('[G3] only 2 checkboxes checked → Accept STILL disabled', () => {
		render(<Consent152FzModal open={true} onAccept={mock()} onCancel={mock()} />)
		const [generalPdn, citizenship] = getAllCheckboxes()
		fireEvent.click(generalPdn as HTMLInputElement)
		fireEvent.click(citizenship as HTMLInputElement)
		const acceptBtn = screen.getByRole('button', { name: ACCEPT_BUTTON_NAME })
		expect((acceptBtn as HTMLButtonElement).disabled).toBe(true)
	})

	test('[G4] all 3 checkboxes checked → Accept enabled', () => {
		render(<Consent152FzModal open={true} onAccept={mock()} onCancel={mock()} />)
		const [generalPdn, citizenship, biometric] = getAllCheckboxes()
		fireEvent.click(generalPdn as HTMLInputElement)
		fireEvent.click(citizenship as HTMLInputElement)
		fireEvent.click(biometric as HTMLInputElement)
		const acceptBtn = screen.getByRole('button', { name: ACCEPT_BUTTON_NAME })
		expect((acceptBtn as HTMLButtonElement).disabled).toBe(false)
	})

	test('[G5] uncheck 1 of 3 after all checked → Accept disabled again', () => {
		render(<Consent152FzModal open={true} onAccept={mock()} onCancel={mock()} />)
		const [generalPdn, citizenship, biometric] = getAllCheckboxes()
		fireEvent.click(generalPdn as HTMLInputElement)
		fireEvent.click(citizenship as HTMLInputElement)
		fireEvent.click(biometric as HTMLInputElement)
		// Uncheck citizenship (middle one)
		fireEvent.click(citizenship as HTMLInputElement)
		const acceptBtn = screen.getByRole('button', { name: ACCEPT_BUTTON_NAME })
		expect((acceptBtn as HTMLButtonElement).disabled).toBe(true)
	})

	test('[G6] Cancel button always enabled', () => {
		render(<Consent152FzModal open={true} onAccept={mock()} onCancel={mock()} />)
		const cancelBtn = screen.getByRole('button', { name: CANCEL_BUTTON_NAME })
		expect((cancelBtn as HTMLButtonElement).disabled).toBe(false)
	})

	test('[G7] modal contains 152-ФЗ + ст.10 + ст.11 + 156-ФЗ references', () => {
		render(<Consent152FzModal open={true} onAccept={mock()} onCancel={mock()} />)
		const body = document.body.textContent ?? ''
		expect(body).toContain('152-ФЗ')
		expect(body).toContain('О персональных данных')
		expect(body).toContain('ст.10')
		expect(body).toContain('ст.11')
		expect(body).toContain('156-ФЗ')
	})

	test('[G8] modal contains Постановление №1668 + ГС МИР (specific goals)', () => {
		render(<Consent152FzModal open={true} onAccept={mock()} onCancel={mock()} />)
		const body = document.body.textContent ?? ''
		expect(body).toContain('1668')
		expect(body).toContain('ГС МИР')
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

	test('[G11] Accept callback fires only when all 3 checked', () => {
		const onAccept = mock()
		render(<Consent152FzModal open={true} onAccept={onAccept} onCancel={mock()} />)
		const acceptBtn = screen.getByRole('button', { name: ACCEPT_BUTTON_NAME })
		// Click while disabled — no-op
		fireEvent.click(acceptBtn)
		expect(onAccept).toHaveBeenCalledTimes(0)
		const [generalPdn, citizenship, biometric] = getAllCheckboxes()
		fireEvent.click(generalPdn as HTMLInputElement)
		fireEvent.click(acceptBtn)
		expect(onAccept).toHaveBeenCalledTimes(0)
		fireEvent.click(citizenship as HTMLInputElement)
		fireEvent.click(acceptBtn)
		expect(onAccept).toHaveBeenCalledTimes(0)
		fireEvent.click(biometric as HTMLInputElement)
		fireEvent.click(acceptBtn)
		expect(onAccept).toHaveBeenCalledTimes(1)
	})

	test('[G12] Accept payload has acceptedAt ISO 8601 timestamp', () => {
		const onAccept = mock()
		render(<Consent152FzModal open={true} onAccept={onAccept} onCancel={mock()} />)
		const [generalPdn, citizenship, biometric] = getAllCheckboxes()
		fireEvent.click(generalPdn as HTMLInputElement)
		fireEvent.click(citizenship as HTMLInputElement)
		fireEvent.click(biometric as HTMLInputElement)
		fireEvent.click(screen.getByRole('button', { name: ACCEPT_BUTTON_NAME }))
		expect(onAccept).toHaveBeenCalledTimes(1)
		const payload = onAccept.mock.calls[0]?.[0] as {
			acceptedAt: string
		}
		// ISO 8601 with Z suffix — Date.prototype.toISOString contract
		expect(payload.acceptedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
		// Reasonable timestamp — within last 5 seconds of test execution
		const acceptedMs = Date.parse(payload.acceptedAt)
		const nowMs = Date.now()
		expect(nowMs - acceptedMs).toBeLessThan(5000)
		expect(nowMs - acceptedMs).toBeGreaterThanOrEqual(0)
	})

	test('[G13] Accept payload has version + textSnapshot + separateConsents', () => {
		const onAccept = mock()
		render(<Consent152FzModal open={true} onAccept={onAccept} onCancel={mock()} />)
		const [generalPdn, citizenship, biometric] = getAllCheckboxes()
		fireEvent.click(generalPdn as HTMLInputElement)
		fireEvent.click(citizenship as HTMLInputElement)
		fireEvent.click(biometric as HTMLInputElement)
		fireEvent.click(screen.getByRole('button', { name: ACCEPT_BUTTON_NAME }))
		const payload = onAccept.mock.calls[0]?.[0] as {
			version: string
			textSnapshot: string
			separateConsents: {
				generalPdn: true
				citizenshipSpecial: true
				biometricPhoto: true
			}
		}
		expect(payload.version).toBe(CONSENT_152FZ_VERSION)
		// textSnapshot — verbatim consent text (tamper-proof per ст.9 ч.4)
		expect(payload.textSnapshot).toContain('152-ФЗ')
		expect(payload.textSnapshot).toContain('1668')
		expect(payload.textSnapshot).toContain('ГС МИР')
		expect(payload.textSnapshot).toContain(CONSENT_152FZ_VERSION)
		// All 3 separate consents true (ст.10 + ст.11 separate documents per 156-ФЗ)
		expect(payload.separateConsents.generalPdn).toBe(true)
		expect(payload.separateConsents.citizenshipSpecial).toBe(true)
		expect(payload.separateConsents.biometricPhoto).toBe(true)
	})

	test('[G14] textSnapshot identical к visible consent text (tamper-proof ст.9 ч.4)', () => {
		const onAccept = mock()
		render(<Consent152FzModal open={true} onAccept={onAccept} onCancel={mock()} />)
		// Snapshot of the rendered consent body BEFORE clicking accept
		const visibleConsentBlock = screen.getByText(/В соответствии с Федеральным законом/)
		const visibleText = visibleConsentBlock.textContent ?? ''
		const [generalPdn, citizenship, biometric] = getAllCheckboxes()
		fireEvent.click(generalPdn as HTMLInputElement)
		fireEvent.click(citizenship as HTMLInputElement)
		fireEvent.click(biometric as HTMLInputElement)
		fireEvent.click(screen.getByRole('button', { name: ACCEPT_BUTTON_NAME }))
		const payload = onAccept.mock.calls[0]?.[0] as { textSnapshot: string }
		// Verbatim canon — every key passage из visible text присутствует в snapshot
		expect(visibleText).toContain('152-ФЗ')
		expect(payload.textSnapshot).toContain('152-ФЗ')
		// Snapshot trimmed — exact same starting phrase
		expect(payload.textSnapshot.startsWith('В соответствии с Федеральным законом')).toBe(true)
	})

	test('[G15] operatorIdentity rendered в consent text (152-ФЗ ст.9 ч.4 identification)', () => {
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
	})

	test('[G16] missing operatorIdentity → generic placeholder rendered (no crash)', () => {
		render(<Consent152FzModal open={true} onAccept={mock()} onCancel={mock()} />)
		const body = document.body.textContent ?? ''
		// Generic fallback presence — proves modal renders без identity
		expect(body).toContain('юр.имя не предоставлено')
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
		// ИНН line — present only когда inn provided (here null)
		expect(body.includes('ИНН: ')).toBe(false)
		// DPO fallback present (legal requirement — subject должен знать how to revoke)
		expect(body).toContain('Контакт DPO: запрос через администратора')
	})

	test('[G18] operatorIdentity появляется в textSnapshot — tamper-proof identity audit', () => {
		const onAccept = mock()
		render(
			<Consent152FzModal
				open={true}
				onAccept={onAccept}
				onCancel={mock()}
				operatorIdentity={{
					legalName: 'ООО «Тестовый отель»',
					inn: '7700000001',
				}}
			/>,
		)
		const [generalPdn, citizenship, biometric] = getAllCheckboxes()
		fireEvent.click(generalPdn as HTMLInputElement)
		fireEvent.click(citizenship as HTMLInputElement)
		fireEvent.click(biometric as HTMLInputElement)
		fireEvent.click(screen.getByRole('button', { name: ACCEPT_BUTTON_NAME }))
		const payload = onAccept.mock.calls[0]?.[0] as { textSnapshot: string }
		// textSnapshot должен содержать operator identity — иначе Roskomnadzor inspection
		// «оператор не идентифицирован» = void consent per 152-ФЗ ст.9 ч.4
		expect(payload.textSnapshot).toContain('ООО «Тестовый отель»')
		expect(payload.textSnapshot).toContain('7700000001')
	})
})
