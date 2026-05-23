/**
 * MRZ-парсер для загранпаспорта РФ (ICAO 9303 TD3 формат).
 *
 * Why: Yandex Vision `passport` model покрывает только паспорт РФ внутренний
 * + 19 стран СНГ/ЕС, но НЕ загранпаспорт РФ (research §1, 2026-05-22).
 * Загранпаспорт имеет MRZ зону внизу страницы с фото — 2 строки по 44 символа,
 * ICAO 9303 стандарт. Парсится 100% даже плохой камерой.
 *
 * Pipeline:
 *   1. Vision `recognizeText` (generic OCR, 0.13 ₽/scan — 5× дешевле passport)
 *      → возвращает plain text всего документа, включая MRZ строки.
 *   2. extractMrzLines() — фильтр строк 44-char с MRZ-pattern (`<` filler).
 *   3. mrz npm lib (5.0.2) — парсит две строки → structured fields.
 *   4. mapMrzFieldsToPassportEntities() — приводим к нашему PassportEntities.
 *
 * Покрывает 7 полей из 10:
 *   - surname (lastName), name (firstName), gender (sex)
 *   - citizenshipIso3 (nationality), birthDate, documentNumber, expirationDate
 *
 * НЕ в MRZ (оператор дозаполнит):
 *   - middleName (отчество — в ICAO нет)
 *   - birthPlace (только VIZ-зона)
 *   - issueDate (только VIZ; можно парсить из fullText regex, отложено к v2)
 *
 * Source: ICAO Doc 9303 Part 4 — Machine Readable Passport TD3 spec.
 */
// biome-ignore lint/correctness/noUnresolvedImports: mrz 5.0.2 exports `parse` via `export { default as parse }` re-export — biome's static analyzer doesn't follow nested defaults; tsgo + Bun resolve correctly.
import { parse as parseMRZ } from 'mrz'
// biome-ignore lint/correctness/noUnresolvedImports: `FieldRecords` re-exported through `export * from './types.js'` in mrz package — biome doesn't resolve wildcard type-only re-exports.
import type { FieldRecords } from 'mrz'
import type { PassportEntities } from './types.ts'

/** Сколько символов в строке MRZ (TD3 passport canon). */
const TD3_LINE_LENGTH = 44

/**
 * TD3 line 2 структура per ICAO 9303 Part 4:
 *   pos 0-8   — document number (9 chars, alphanumeric + filler `<`)
 *   pos 9     — document number check digit (0-9)
 *   pos 10-12 — nationality (3 letters)
 *   pos 13-18 — birth date YYMMDD
 *   ...
 *
 * Regex: первые 9 char alphanumeric/`<`, потом цифра (check digit), потом 3 буквы.
 * Это исключает ложный match если кандидат — footer `<<<<<<<` или другой 44-char
 * non-MRZ-line случайно matched базовый filter.
 */
const TD3_LINE_2_PATTERN = /^[A-Z0-9<]{9}\d[A-Z<]{3}/

/**
 * Извлечь MRZ-строки из произвольного текста (Vision recognizeText output).
 *
 * Эвристика:
 *   - Normalize к UPPER CASE (Vision occasionally emits lowercase на low-quality
 *     scans — без этого filter rejects все строки → 0% success).
 *   - Игнорировать пробелы (MRZ их не имеет — `<` filler вместо)
 *   - Длина строки = 44 (TD3 canon)
 *   - Содержит хотя бы один `<` (filler)
 *   - Только A-Z + 0-9 + `<` символы (после strip пробелов + uppercase)
 *   - Первая строка начинается с `P<` (document code)
 *   - Вторая строка matches TD3 line 2 pattern (doc number + check digit + nationality)
 *
 * Returns null если MRZ не найдена (документ не загран / повёрнут / blur).
 */
export function extractMrzLines(fullText: string): readonly string[] | null {
	const candidateLines = fullText
		.split('\n')
		.map((l) => l.replace(/\s/g, '').toUpperCase())
		.filter((l) => l.length === TD3_LINE_LENGTH && l.includes('<') && /^[A-Z0-9<]+$/.test(l))
	if (candidateLines.length < 2) return null
	// TD3 passport canon: первая строка ВСЕГДА начинается с 'P<' (document code 'P' +
	// filler). Adversarial defense vs uppercase'd VIZ-строки.
	const firstIdx = candidateLines.findIndex((l) => l.startsWith('P<'))
	if (firstIdx === -1) return null
	const first = candidateLines[firstIdx]
	// Line 2: проверяем что matches TD3 line 2 structure (не filler footer
	// или другая 44-char строка). Если firstIdx+1 не matches — пробуем
	// следующие кандидаты (rare: noise lines между MRZ).
	for (let i = firstIdx + 1; i < candidateLines.length; i++) {
		const candidate = candidateLines[i]
		if (candidate !== undefined && TD3_LINE_2_PATTERN.test(candidate)) {
			if (first === undefined) return null
			return [first, candidate]
		}
	}
	return null
}

export interface MrzParseOutput {
	readonly entities: PassportEntities
	/** TD1/TD2/TD3 etc — TD3 для загранпаспорта канон. */
	readonly mrzFormat: string | null
	/**
	 * Полная валидность MRZ — все check digits сошлись. Если false —
	 * вероятно OCR-ошибка, но fields всё равно заполнены (с low confidence).
	 */
	readonly isValid: boolean
}

/**
 * Распарсить MRZ из Vision recognizeText output.
 *
 * Returns null если:
 *   - MRZ-строки не найдены в тексте (не загранпаспорт?)
 *   - parseMRZ throws (corrupted MRZ)
 *
 * Caller mapping (outcome):
 *   - null → 'api_error' / 'low_confidence' (зависит от других факторов)
 *   - !isValid → 'low_confidence' (fields заполнены, но checksum failed)
 *   - isValid → 'success' / классифицируется по другим heuristics
 */
export function parsePassportMrz(fullText: string): MrzParseOutput | null {
	const lines = extractMrzLines(fullText)
	if (lines === null) return null
	try {
		// NB: autocorrect:true option в mrz 5.0.2 emp-verified breaks valid MRZ
		// recognition (gender/check-digit fields fail) per Sprint A test run
		// 2026-05-22. Defer к v2 — retry path при isValid=false с autocorrect.
		const result = parseMRZ(lines)
		// Reject не-TD3 formats (TD1 ID-cards, TD2, French/Swiss licenses) —
		// у них другая семантика полей и нет загранпаспортного use-case.
		// Загранпаспорт РФ всегда TD3.
		if (result.format !== 'TD3') return null
		return {
			entities: mapMrzFieldsToPassportEntities(result.fields),
			mrzFormat: result.format,
			isValid: result.valid,
		}
	} catch {
		return null
	}
}

function mapMrzFieldsToPassportEntities(fields: FieldRecords): PassportEntities {
	return {
		surname: fields.lastName ?? null,
		name: fields.firstName ?? null,
		middleName: null, // ICAO 9303 не содержит отчество
		gender: mapSex(fields.sex),
		citizenshipIso3:
			typeof fields.nationality === 'string' ? fields.nationality.toLowerCase() : null,
		birthDate: parseYyMmDdToIso(fields.birthDate, 'birth'),
		birthPlace: null, // только VIZ-зона
		documentNumber: fields.documentNumber ?? null,
		issueDate: null, // только VIZ-зона (оператор дозаполнит)
		expirationDate: parseYyMmDdToIso(fields.expirationDate, 'expiration'),
	}
}

function mapSex(sex: string | null | undefined): 'male' | 'female' | null {
	// mrz 5.0.2 already normalizes 'M'/'F' → 'male'/'female' before exposing.
	// Empirically verified 2026-05-22. Accept both forms для safety.
	if (sex === 'male' || sex === 'M') return 'male'
	if (sex === 'female' || sex === 'F') return 'female'
	return null
}

/**
 * YY MM DD (6 символов из MRZ) → YYYY-MM-DD ISO 8601.
 *
 * Century determination (MRZ хранит только 2 цифры года) per industry sliding-
 * window canon (не ICAO-mandated — нет публичной spec):
 *   - birth: YY > currentYY → 19YY (already happened), else 20YY (this century)
 *     → корректно для 97-летнего гостя (born 1929) — yy=29, 2026 currentYY=26,
 *       29>26 → 1929 ✓. И для 16-летнего (born 2010) — 10≤26 → 2010 ✓.
 *   - expiration: YY < 50 → 20YY, else 19YY
 *     (загранпаспорт valid max 10 лет, expiry никогда не 19XX в наше время)
 *
 * Day-vs-month validation: `new Date(yyyy-mm-dd)` НЕ rejects 31 Feb — silent
 * rolls в March 3, теряя данные. Используем Date construction + cross-check
 * day/month после.
 *
 * Returns null для невалидного формата (не 6 цифр / неверной даты).
 */
function parseYyMmDdToIso(
	yymmdd: string | null | undefined,
	context: 'birth' | 'expiration',
	now: Date = new Date(),
): string | null {
	if (typeof yymmdd !== 'string' || yymmdd.length !== 6 || !/^\d{6}$/.test(yymmdd)) return null
	const yy = Number.parseInt(yymmdd.slice(0, 2), 10)
	const mm = Number.parseInt(yymmdd.slice(2, 4), 10)
	const dd = Number.parseInt(yymmdd.slice(4, 6), 10)
	if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null
	let century: number
	if (context === 'birth') {
		const currentYY = now.getUTCFullYear() % 100
		century = yy > currentYY ? 1900 : 2000
	} else {
		century = yy < 50 ? 2000 : 1900
	}
	const fullYear = century + yy
	// Day-vs-month strict check: Date will silently roll Feb 31 → Mar 3.
	// We reconstruct и verify components stayed.
	const date = new Date(Date.UTC(fullYear, mm - 1, dd))
	if (
		date.getUTCFullYear() !== fullYear ||
		date.getUTCMonth() !== mm - 1 ||
		date.getUTCDate() !== dd
	) {
		return null
	}
	return `${fullYear}-${mm.toString().padStart(2, '0')}-${dd.toString().padStart(2, '0')}`
}
