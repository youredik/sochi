/**
 * ConfirmStage — amber per-field «проверьте» advisory (2026 HITL, research Agent A).
 * Render-тесты: подсветка ДЕЙСТВИТЕЛЬНО показывается для слабых полей и НЕ блокирует
 * (≠ красная hard-валидация, которая gated на validationError).
 */
import type { PassportEntities } from '@horeca/shared'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { ConfirmStage } from './passport-scan-dialog.tsx'

afterEach(cleanup)

const base: PassportEntities = {
	surname: 'Иванов',
	name: 'Иван',
	middleName: 'Иванович',
	gender: 'male' as const,
	citizenshipIso3: 'rus',
	birthDate: '1984-06-15',
	birthPlace: 'г. Сочи',
	documentNumber: '4608 123456',
	issueDate: '2015-03-10',
	expirationDate: null,
}

const AMBER = 'Проверьте — распознано неуверенно'
const AMBER_CIT = 'Проверьте — гражданство не распознано'

function renderConfirm(entities: typeof base) {
	return render(
		<ConfirmStage
			entities={entities}
			confidenceHeuristic={0.6}
			outcome="low_confidence"
			rklStatus="clean"
			identityMethod="passport_paper"
			onChange={mock()}
			validationError={null}
		/>,
	)
}

describe('ConfirmStage — amber per-field advisory', () => {
	test('чистый РФ-паспорт → НИ ОДНОЙ amber-подсказки', () => {
		render(
			<ConfirmStage
				entities={base}
				confidenceHeuristic={0.9}
				outcome="success"
				rklStatus="clean"
				identityMethod="passport_paper"
				onChange={mock()}
				validationError={null}
			/>,
		)
		expect(screen.queryByText(AMBER)).toBeNull()
		expect(screen.queryByText(AMBER_CIT)).toBeNull()
	})

	test('пустая фамилия → amber виден, но НЕ красная блокирующая ошибка (non-blocking)', () => {
		renderConfirm({ ...base, surname: null })
		expect(screen.getAllByText(AMBER).length).toBeGreaterThan(0)
		// validationError=null → красная hard-ошибка НЕ показывается (amber её заменяет).
		expect(screen.queryByText('Заполните фамилию')).toBeNull()
	})

	test('гражданство не распознано → amber на CitizenshipSelect', () => {
		renderConfirm({ ...base, citizenshipIso3: null })
		expect(screen.getByText(AMBER_CIT)).not.toBeNull()
	})

	test('кривой номер РФ-паспорта → amber на поле номера', () => {
		renderConfirm({ ...base, documentNumber: 'ЖЖЖ' })
		expect(screen.getAllByText(AMBER).length).toBeGreaterThan(0)
	})

	test('авто-фокус на ПЕРВОЕ слабое поле (пустая фамилия → фокус на фамилии)', () => {
		renderConfirm({ ...base, surname: null })
		const surname = screen.getByLabelText(/Фамилия/) as HTMLInputElement
		expect(document.activeElement).toBe(surname)
	})

	test('несколько слабых → фокус на ПЕРВОМ по порядку (фамилия ок, имя+номер слабые → имя)', () => {
		renderConfirm({ ...base, name: null, documentNumber: 'ЖЖЖ' })
		const name = screen.getByLabelText(/^Имя/) as HTMLInputElement
		expect(document.activeElement).toBe(name)
	})
})
