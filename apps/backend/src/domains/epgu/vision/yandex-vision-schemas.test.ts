/**
 * Yandex Vision pure-fn helpers — strict unit tests (P2, 2026-05).
 *
 * Coverage:
 *   - snakeToCamelEntityName: 10 canonical + unknown → null
 *   - parseDateDdMmYyyyToIso: happy / boundary / malformed
 *   - normalizeCitizenshipToIso3: all 20 whitelisted + Cyrillic + null
 *   - normalizeGender: all variants + ambiguous → null
 */

import { describe, expect, test } from 'bun:test'
import {
	normalizeCitizenshipToIso3,
	normalizeGender,
	parseDateDdMmYyyyToIso,
	snakeToCamelEntityName,
} from './yandex-vision-schemas.ts'

describe('snakeToCamelEntityName', () => {
	test('maps all 10 canonical entity names', () => {
		expect(snakeToCamelEntityName('surname')).toBe('surname')
		expect(snakeToCamelEntityName('name')).toBe('name')
		expect(snakeToCamelEntityName('middle_name')).toBe('middleName')
		expect(snakeToCamelEntityName('gender')).toBe('gender')
		expect(snakeToCamelEntityName('citizenship')).toBe('citizenshipIso3')
		expect(snakeToCamelEntityName('birth_date')).toBe('birthDate')
		expect(snakeToCamelEntityName('birth_place')).toBe('birthPlace')
		expect(snakeToCamelEntityName('number')).toBe('documentNumber')
		expect(snakeToCamelEntityName('issue_date')).toBe('issueDate')
		expect(snakeToCamelEntityName('expiration_date')).toBe('expirationDate')
	})

	test('returns null on unknown entity (forward-compat — future Yandex additions)', () => {
		expect(snakeToCamelEntityName('subdivision')).toBeNull()
		expect(snakeToCamelEntityName('issued_by')).toBeNull()
		expect(snakeToCamelEntityName('UNKNOWN')).toBeNull()
		expect(snakeToCamelEntityName('')).toBeNull()
	})

	test('case-sensitive — uppercase variants → null (canon: API returns snake_case lowercase)', () => {
		expect(snakeToCamelEntityName('Surname')).toBeNull()
		expect(snakeToCamelEntityName('BIRTH_DATE')).toBeNull()
	})
})

describe('parseDateDdMmYyyyToIso', () => {
	test('happy path — converts DD.MM.YYYY → YYYY-MM-DD', () => {
		expect(parseDateDdMmYyyyToIso('07.03.1985')).toBe('1985-03-07')
		expect(parseDateDdMmYyyyToIso('01.01.2000')).toBe('2000-01-01')
		expect(parseDateDdMmYyyyToIso('31.12.2024')).toBe('2024-12-31')
	})

	test('boundary year 1900 + 2100', () => {
		expect(parseDateDdMmYyyyToIso('15.06.1900')).toBe('1900-06-15')
		expect(parseDateDdMmYyyyToIso('15.06.2100')).toBe('2100-06-15')
	})

	test('out-of-range year rejected', () => {
		expect(parseDateDdMmYyyyToIso('01.01.1899')).toBeNull()
		expect(parseDateDdMmYyyyToIso('01.01.2101')).toBeNull()
	})

	test('invalid day rejected', () => {
		expect(parseDateDdMmYyyyToIso('00.01.2000')).toBeNull()
		expect(parseDateDdMmYyyyToIso('32.01.2000')).toBeNull()
	})

	test('invalid month rejected', () => {
		expect(parseDateDdMmYyyyToIso('15.00.2000')).toBeNull()
		expect(parseDateDdMmYyyyToIso('15.13.2000')).toBeNull()
	})

	test('malformed strings rejected', () => {
		expect(parseDateDdMmYyyyToIso('')).toBeNull()
		expect(parseDateDdMmYyyyToIso('1985-03-07')).toBeNull() // already ISO
		expect(parseDateDdMmYyyyToIso('7.3.1985')).toBeNull() // missing zero-padding
		expect(parseDateDdMmYyyyToIso('07/03/1985')).toBeNull() // wrong separator
		expect(parseDateDdMmYyyyToIso('not-a-date')).toBeNull()
	})

	test('trim whitespace', () => {
		expect(parseDateDdMmYyyyToIso('  07.03.1985  ')).toBe('1985-03-07')
	})
})

describe('normalizeCitizenshipToIso3', () => {
	test('all 20 whitelisted countries — English variants', () => {
		expect(normalizeCitizenshipToIso3('Russian Federation')).toBe('rus')
		expect(normalizeCitizenshipToIso3('Belarus')).toBe('blr')
		expect(normalizeCitizenshipToIso3('Kazakhstan')).toBe('kaz')
		expect(normalizeCitizenshipToIso3('Kyrgyzstan')).toBe('kgz')
		expect(normalizeCitizenshipToIso3('Tajikistan')).toBe('tjk')
		expect(normalizeCitizenshipToIso3('Uzbekistan')).toBe('uzb')
		expect(normalizeCitizenshipToIso3('Armenia')).toBe('arm')
		expect(normalizeCitizenshipToIso3('Azerbaijan')).toBe('aze')
		expect(normalizeCitizenshipToIso3('Moldova')).toBe('mda')
		expect(normalizeCitizenshipToIso3('Turkmenistan')).toBe('tkm')
		expect(normalizeCitizenshipToIso3('Ukraine')).toBe('ukr')
		expect(normalizeCitizenshipToIso3('Turkey')).toBe('tur')
		expect(normalizeCitizenshipToIso3('Israel')).toBe('isr')
		expect(normalizeCitizenshipToIso3('United States')).toBe('usa')
		expect(normalizeCitizenshipToIso3('United Kingdom')).toBe('gbr')
		expect(normalizeCitizenshipToIso3('Germany')).toBe('deu')
		expect(normalizeCitizenshipToIso3('France')).toBe('fra')
		expect(normalizeCitizenshipToIso3('Italy')).toBe('ita')
		expect(normalizeCitizenshipToIso3('Spain')).toBe('esp')
		expect(normalizeCitizenshipToIso3('China')).toBe('chn')
	})

	test('Cyrillic variants — RU canon', () => {
		expect(normalizeCitizenshipToIso3('Россия')).toBe('rus')
		expect(normalizeCitizenshipToIso3('Российская Федерация')).toBe('rus')
		expect(normalizeCitizenshipToIso3('Беларусь')).toBe('blr')
		expect(normalizeCitizenshipToIso3('Казахстан')).toBe('kaz')
	})

	test('ISO-3 alpha-3 codes passthrough (case-insensitive)', () => {
		expect(normalizeCitizenshipToIso3('rus')).toBe('rus')
		expect(normalizeCitizenshipToIso3('RUS')).toBe('rus')
		expect(normalizeCitizenshipToIso3('Rus')).toBe('rus')
	})

	test('unknown country → null', () => {
		expect(normalizeCitizenshipToIso3('Atlantis')).toBeNull()
		expect(normalizeCitizenshipToIso3('XYZ')).toBeNull()
		expect(normalizeCitizenshipToIso3('')).toBeNull()
	})

	test('trim + case-insensitive', () => {
		expect(normalizeCitizenshipToIso3('  Russia  ')).toBe('rus')
		expect(normalizeCitizenshipToIso3('GERMANY')).toBe('deu')
	})
})

describe('normalizeGender', () => {
	test('male variants', () => {
		expect(normalizeGender('male')).toBe('male')
		expect(normalizeGender('Male')).toBe('male')
		expect(normalizeGender('M')).toBe('male')
		expect(normalizeGender('м')).toBe('male')
		expect(normalizeGender('муж')).toBe('male')
		expect(normalizeGender('муж.')).toBe('male')
	})

	test('female variants', () => {
		expect(normalizeGender('female')).toBe('female')
		expect(normalizeGender('Female')).toBe('female')
		expect(normalizeGender('F')).toBe('female')
		expect(normalizeGender('ж')).toBe('female')
		expect(normalizeGender('жен')).toBe('female')
		expect(normalizeGender('жен.')).toBe('female')
	})

	test('ambiguous → null', () => {
		expect(normalizeGender('')).toBeNull()
		expect(normalizeGender('other')).toBeNull()
		expect(normalizeGender('X')).toBeNull()
		expect(normalizeGender('unknown')).toBeNull()
	})

	test('trim whitespace', () => {
		expect(normalizeGender('  male  ')).toBe('male')
		expect(normalizeGender('  ж  ')).toBe('female')
	})
})
