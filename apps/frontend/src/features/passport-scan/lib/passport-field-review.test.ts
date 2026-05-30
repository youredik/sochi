import { describe, expect, it } from 'bun:test'
import { passportFieldReview } from './passport-field-review.ts'

const NOW = new Date('2026-05-29T12:00:00Z')

const full = {
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

describe('passportFieldReview — per-field needs-review (amber)', () => {
	it('чистый РФ-паспорт → ни одного флага', () => {
		expect(passportFieldReview(full, 'passport_paper', NOW)).toEqual({
			surname: false,
			name: false,
			birthDate: false,
			citizenship: false,
			documentNumber: false,
			expirationDate: false,
		})
	})

	it('пустые фамилия/имя/номер/гражданство → флаги', () => {
		const r = passportFieldReview(
			{ ...full, surname: null, name: null, documentNumber: null, citizenshipIso3: null },
			'passport_paper',
			NOW,
		)
		expect(r.surname).toBe(true)
		expect(r.name).toBe(true)
		expect(r.documentNumber).toBe(true)
		expect(r.citizenship).toBe(true)
	})

	it('РФ-паспорт: номер не формата «серия+номер» → флаг; с/без пробела → ок', () => {
		expect(
			passportFieldReview({ ...full, documentNumber: 'ABC123' }, 'passport_paper', NOW)
				.documentNumber,
		).toBe(true)
		expect(
			passportFieldReview({ ...full, documentNumber: '4608123456' }, 'passport_paper', NOW)
				.documentNumber,
		).toBe(false)
	})

	it('дата рождения: будущая / возраст <14 / невалидная / пустая → флаг', () => {
		expect(
			passportFieldReview({ ...full, birthDate: '2030-01-01' }, 'passport_paper', NOW).birthDate,
		).toBe(true)
		expect(
			passportFieldReview({ ...full, birthDate: '2020-01-01' }, 'passport_paper', NOW).birthDate,
		).toBe(true)
		expect(
			passportFieldReview({ ...full, birthDate: 'не-дата' }, 'passport_paper', NOW).birthDate,
		).toBe(true)
		expect(passportFieldReview({ ...full, birthDate: null }, 'passport_paper', NOW).birthDate).toBe(
			true,
		)
	})

	it('имя длиной 1 или >50 символов → подозрительно', () => {
		expect(passportFieldReview({ ...full, name: 'И' }, 'passport_paper', NOW).name).toBe(true)
		expect(
			passportFieldReview({ ...full, surname: 'Я'.repeat(51) }, 'passport_paper', NOW).surname,
		).toBe(true)
	})

	it('загран: expirationDate обязателен (пусто → флаг); РФ-паспорт → не флаг', () => {
		expect(
			passportFieldReview({ ...full, expirationDate: null }, 'passport_zagran', NOW).expirationDate,
		).toBe(true)
		expect(
			passportFieldReview({ ...full, expirationDate: null }, 'passport_paper', NOW).expirationDate,
		).toBe(false)
	})

	it('загран: номер другого формата (9 цифр) НЕ флагается РФ-регексом', () => {
		expect(
			passportFieldReview({ ...full, documentNumber: '123456789' }, 'passport_zagran', NOW)
				.documentNumber,
		).toBe(false)
	})
})
