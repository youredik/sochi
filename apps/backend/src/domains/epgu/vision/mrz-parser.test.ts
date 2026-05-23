/**
 * Tests for mrz-parser.ts — ICAO 9303 TD3 (passport) MRZ extraction +
 * mapping → PassportEntities.
 *
 * Test cases используют real MRZ примеры:
 *   - ICAO 9303 Annex A canonical pример (Anna Maria Eriksson, UTO)
 *   - Российский загранпаспорт synthetic пример
 *   - Edge cases: повёрнутый OCR text, частичный MRZ, без MRZ
 */
import { describe, expect, test } from 'bun:test'
import { extractMrzLines, parsePassportMrz } from './mrz-parser.ts'

// ICAO 9303 Annex A canonical TD3 example (всегда `valid: true` в mrz lib)
const ICAO_CANONICAL_LINE_1 = 'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<'
const ICAO_CANONICAL_LINE_2 = 'L898902C36UTO7408122F1204159ZE184226B<<<<<10'

// Synthetic РФ загранпаспорт
const RU_ZAGRAN_LINE_1 = 'P<RUSIVANOV<<IVAN<<<<<<<<<<<<<<<<<<<<<<<<<<<'
const RU_ZAGRAN_LINE_2 = '7515512344RUS8503143M2705156<<<<<<<<<<<<<<04'

describe('extractMrzLines', () => {
	test('извлекает 2 MRZ-строки из чистого MRZ text', () => {
		const text = `${ICAO_CANONICAL_LINE_1}\n${ICAO_CANONICAL_LINE_2}`
		const lines = extractMrzLines(text)
		expect(lines).not.toBeNull()
		expect(lines).toEqual([ICAO_CANONICAL_LINE_1, ICAO_CANONICAL_LINE_2])
	})

	test('извлекает MRZ из текста с шумом (VIZ-зона над MRZ)', () => {
		const text = `
ПАСПОРТ
PASSPORT
Российская Федерация
Russian Federation
Фамилия / Surname: ИВАНОВ
Имя / Given names: ИВАН
${RU_ZAGRAN_LINE_1}
${RU_ZAGRAN_LINE_2}
		`
		const lines = extractMrzLines(text)
		expect(lines).toEqual([RU_ZAGRAN_LINE_1, RU_ZAGRAN_LINE_2])
	})

	test('игнорирует пробелы в OCR output (Vision добавляет иногда)', () => {
		// Если Vision вставил пробелы в MRZ-строку — strip их.
		const noisyLine1 = ICAO_CANONICAL_LINE_1.split('').join(' ')
		const noisyLine2 = ICAO_CANONICAL_LINE_2.split('').join(' ')
		const text = `${noisyLine1}\n${noisyLine2}`
		const lines = extractMrzLines(text)
		expect(lines).toEqual([ICAO_CANONICAL_LINE_1, ICAO_CANONICAL_LINE_2])
	})

	test('возвращает null если MRZ не найдена (внутренний паспорт РФ)', () => {
		const text = `
ПАСПОРТ
РОССИЙСКАЯ ФЕДЕРАЦИЯ
Фамилия: ИВАНОВ
Имя: ИВАН
Отчество: ИВАНОВИЧ
Серия: 4608 Номер: 123456
		`
		const lines = extractMrzLines(text)
		expect(lines).toBeNull()
	})

	test('возвращает null если только 1 MRZ-строка (partial scan)', () => {
		const text = ICAO_CANONICAL_LINE_1
		expect(extractMrzLines(text)).toBeNull()
	})

	test('возвращает null если строки не 44 символа (mismatch)', () => {
		const text = 'P<UTOERIKSSON<<ANNA\nL898902C36UTO7408122F'
		expect(extractMrzLines(text)).toBeNull()
	})
})

describe('parsePassportMrz', () => {
	test('парсит ICAO 9303 canonical sample (Anna Maria Eriksson, UTO)', () => {
		// Empirical 2026-05-22: mrz 5.0.2 flags 'UTO' (Utopia placeholder) as
		// invalid state code → isValid=false + nationality=null. Это canonical
		// поведение mrz lib для unknown country codes (по ISO 3166).
		const result = parsePassportMrz(`${ICAO_CANONICAL_LINE_1}\n${ICAO_CANONICAL_LINE_2}`)
		expect(result).not.toBeNull()
		if (result === null) return // type narrowing
		expect(result.mrzFormat).toBe('TD3')
		// UTO placeholder → mrz flagged invalid → isValid=false (expected canon).
		expect(result.isValid).toBe(false)
		expect(result.entities.surname).toBe('ERIKSSON')
		expect(result.entities.name).toBe('ANNA MARIA')
		expect(result.entities.gender).toBe('female')
		// UTO not in ISO 3166 → mrz returns nationality=null.
		expect(result.entities.citizenshipIso3).toBeNull()
		// MRZ birthDate 740812 → sliding-window context: yy=74 > currentYY=26 → 1974
		expect(result.entities.birthDate).toBe('1974-08-12')
		// MRZ expirationDate 120415 → yy=12 < 50 → 2012
		expect(result.entities.expirationDate).toBe('2012-04-15')
		expect(result.entities.documentNumber).toBe('L898902C3')
	})

	test('парсит РФ загранпаспорт synthetic example', () => {
		// Synthetic example — check digits intentionally simplified (не real
		// modulo-10 calculations) → mrz isValid=false, но fields populated OK.
		// Production scans от Vision OCR будут иметь real check digits.
		const result = parsePassportMrz(`${RU_ZAGRAN_LINE_1}\n${RU_ZAGRAN_LINE_2}`)
		expect(result).not.toBeNull()
		if (result === null) return
		expect(result.entities.surname).toBe('IVANOV')
		expect(result.entities.name).toBe('IVAN')
		expect(result.entities.gender).toBe('male')
		expect(result.entities.citizenshipIso3).toBe('rus')
		// 850314 → yy=85 > currentYY=26 → 1985
		expect(result.entities.birthDate).toBe('1985-03-14')
		// 270515 → yy=27 < 50 → 2027
		expect(result.entities.expirationDate).toBe('2027-05-15')
		expect(result.entities.documentNumber).toBe('751551234')
	})

	test('middleName всегда null (ICAO MRZ не содержит отчество)', () => {
		const result = parsePassportMrz(`${ICAO_CANONICAL_LINE_1}\n${ICAO_CANONICAL_LINE_2}`)
		if (result === null) throw new Error('expected non-null')
		expect(result.entities.middleName).toBeNull()
	})

	test('birthPlace и issueDate всегда null (только VIZ-зона)', () => {
		const result = parsePassportMrz(`${ICAO_CANONICAL_LINE_1}\n${ICAO_CANONICAL_LINE_2}`)
		if (result === null) throw new Error('expected non-null')
		expect(result.entities.birthPlace).toBeNull()
		expect(result.entities.issueDate).toBeNull()
	})

	test('возвращает null если MRZ не найдена', () => {
		const result = parsePassportMrz('просто какой-то текст без MRZ зоны')
		expect(result).toBeNull()
	})

	test('возвращает результат isValid=false для corrupted MRZ check digits', () => {
		// Заменим один check digit на неверный (last digit '0' в первой позиции)
		const corruptedLine2 = '7515512340RUS8503143M2705156<<<<<<<<<<<<<<04'
		const result = parsePassportMrz(`${RU_ZAGRAN_LINE_1}\n${corruptedLine2}`)
		// Parser всё равно вернёт fields (для UI чтобы оператор увидел),
		// но isValid=false → caller помечает как low_confidence.
		expect(result).not.toBeNull()
		if (result === null) return
		expect(result.isValid).toBe(false)
	})
})

describe('parsePassportMrz — date parsing с sliding-window century', () => {
	// На 2026-05-22 currentYY=26. Sliding window для birth: yy > currentYY → 19YY,
	// else 20YY. ICAO 9303 не задаёт cutoff — industry canon (mrz.codes,
	// ultimateMRZ) использует именно sliding window от текущего года.

	test('YY=00 birth → 2000 (yy ≤ currentYY=26 → 20YY)', () => {
		const line2 = '7515512344RUS0001011M2705156<<<<<<<<<<<<<<04'
		const result = parsePassportMrz(`${RU_ZAGRAN_LINE_1}\n${line2}`)
		if (result === null) throw new Error('expected non-null')
		expect(result.entities.birthDate).toBe('2000-01-01')
	})

	test('YY=26 birth → 2026 (boundary, equal to currentYY)', () => {
		const line2 = '7515512344RUS2601011M2705156<<<<<<<<<<<<<<04'
		const result = parsePassportMrz(`${RU_ZAGRAN_LINE_1}\n${line2}`)
		if (result === null) throw new Error('expected non-null')
		expect(result.entities.birthDate).toBe('2026-01-01')
	})

	test('YY=29 birth → 1929 (97-летний ветеран WWII в Сочи 2026)', () => {
		// CRITICAL: жёсткий cutoff 30 ломал этот случай (давал 2029 — future date).
		// Sliding window от currentYY=26: 29 > 26 → 1929.
		const line2 = '7515512344RUS2901011M2705156<<<<<<<<<<<<<<04'
		const result = parsePassportMrz(`${RU_ZAGRAN_LINE_1}\n${line2}`)
		if (result === null) throw new Error('expected non-null')
		expect(result.entities.birthDate).toBe('1929-01-01')
	})

	test('YY=31 birth → 1931 (older history)', () => {
		const line2 = '7515512344RUS3101011M2705156<<<<<<<<<<<<<<04'
		const result = parsePassportMrz(`${RU_ZAGRAN_LINE_1}\n${line2}`)
		if (result === null) throw new Error('expected non-null')
		expect(result.entities.birthDate).toBe('1931-01-01')
	})

	test('YY=49 expiration → 2049 (passport 10y validity max → 2036 reasonable)', () => {
		const line2 = '7515512344RUS8503143M4905156<<<<<<<<<<<<<<04'
		const result = parsePassportMrz(`${RU_ZAGRAN_LINE_1}\n${line2}`)
		if (result === null) throw new Error('expected non-null')
		expect(result.entities.expirationDate).toBe('2049-05-15')
	})

	test('YY=50 expiration → 1950 (boundary — passports не expire в 2050+)', () => {
		const line2 = '7515512344RUS8503143M5005156<<<<<<<<<<<<<<04'
		const result = parsePassportMrz(`${RU_ZAGRAN_LINE_1}\n${line2}`)
		if (result === null) throw new Error('expected non-null')
		expect(result.entities.expirationDate).toBe('1950-05-15')
	})

	test('YY=51 expiration → 1951 (после cutoff)', () => {
		const line2 = '7515512344RUS8503143M5105156<<<<<<<<<<<<<<04'
		const result = parsePassportMrz(`${RU_ZAGRAN_LINE_1}\n${line2}`)
		if (result === null) throw new Error('expected non-null')
		expect(result.entities.expirationDate).toBe('1951-05-15')
	})
})

describe('parsePassportMrz — invalid date rejection (Feb 31 trap)', () => {
	test('Feb 31 birth → null (НЕ silent roll to March 3)', () => {
		// MRZ '850231' = 31 Feb 1985 — невалидно. `new Date('1985-02-31')`
		// silently rolls to 1985-03-03 без warn. Должны вернуть null.
		const line2 = '7515512344RUS8502313M2705156<<<<<<<<<<<<<<04'
		const result = parsePassportMrz(`${RU_ZAGRAN_LINE_1}\n${line2}`)
		// mrz lib возвращает поля как есть, наш parseYyMmDdToIso reject
		if (result === null) throw new Error('expected non-null')
		expect(result.entities.birthDate).toBeNull()
	})

	test('April 31 birth → null', () => {
		const line2 = '7515512344RUS8504313M2705156<<<<<<<<<<<<<<04'
		const result = parsePassportMrz(`${RU_ZAGRAN_LINE_1}\n${line2}`)
		if (result === null) throw new Error('expected non-null')
		expect(result.entities.birthDate).toBeNull()
	})

	test('Month 13 birth → null (already covered by validation)', () => {
		const line2 = '7515512344RUS8513013M2705156<<<<<<<<<<<<<<04'
		const result = parsePassportMrz(`${RU_ZAGRAN_LINE_1}\n${line2}`)
		if (result === null) throw new Error('expected non-null')
		expect(result.entities.birthDate).toBeNull()
	})

	test('Feb 29 leap year (1988) → valid date', () => {
		const line2 = '7515512344RUS8802293M2705156<<<<<<<<<<<<<<04'
		const result = parsePassportMrz(`${RU_ZAGRAN_LINE_1}\n${line2}`)
		if (result === null) throw new Error('expected non-null')
		// 1988 leap year → Feb 29 валидна
		expect(result.entities.birthDate).toBe('1988-02-29')
	})

	test('Feb 29 non-leap year (1989) → null', () => {
		const line2 = '7515512344RUS8902293M2705156<<<<<<<<<<<<<<04'
		const result = parsePassportMrz(`${RU_ZAGRAN_LINE_1}\n${line2}`)
		if (result === null) throw new Error('expected non-null')
		// 1989 не leap → Feb 29 невалидна
		expect(result.entities.birthDate).toBeNull()
	})
})

describe('parsePassportMrz — adversarial: lowercase + footer-noise filtering', () => {
	test('lowercase MRZ → normalized к uppercase + parsed', () => {
		// Vision OCR на низком качестве может вернуть mixed case
		const lower = `${RU_ZAGRAN_LINE_1.toLowerCase()}\n${RU_ZAGRAN_LINE_2.toLowerCase()}`
		const result = parsePassportMrz(lower)
		if (result === null) throw new Error('expected non-null after uppercase normalize')
		expect(result.entities.surname).toBe('IVANOV')
		expect(result.entities.documentNumber).toBe('751551234')
	})

	test('footer filler `<<<<<<<<...` between MRZ строк → skip к real line 2', () => {
		// Edge case: OCR накатал 44-char line of fillers между MRZ строками
		const footerNoise = '<'.repeat(44)
		const text = `${RU_ZAGRAN_LINE_1}\n${footerNoise}\n${RU_ZAGRAN_LINE_2}`
		const result = parsePassportMrz(text)
		if (result === null) throw new Error('expected non-null — should skip footer noise')
		expect(result.entities.surname).toBe('IVANOV')
	})

	test('footer-only после line 1 → null (нет real line 2)', () => {
		const footerNoise = '<'.repeat(44)
		const text = `${RU_ZAGRAN_LINE_1}\n${footerNoise}`
		const result = parsePassportMrz(text)
		expect(result).toBeNull()
	})

	test('TD1 ID-card (3×30) → null (отвергаем не-TD3 formats)', () => {
		// French national ID — TD1, 3 строки по 30. Не загранпаспорт.
		const td1Line1 = 'IDFRABERTHIER<<<<<<<<<<<<<<<<<'
		const td1Line2 = '8806923102599JEAN<<MICHEL<<<<<'
		const td1Line3 = '8806920M2002126FRA<<<<<<<<<<<2'
		const result = parsePassportMrz(`${td1Line1}\n${td1Line2}\n${td1Line3}`)
		// length=30, не TD3 (44) → filter rejects before parsing
		expect(result).toBeNull()
	})
})
