import type { IdentityMethod, RecognizePassportResponse } from '@horeca/shared'

/**
 * Per-field «нужна проверка» детектор для скан-формы заезда (2026 HITL state-of-
 * art — research Agent A: подсвечивать ТОЛЬКО слабые поля, направляя взгляд
 * оператора, а не «проверьте всё»).
 *
 * Yandex Vision НЕ отдаёт per-field confidence (research Agent C), поэтому сигнал
 * = присутствие + формат/санити (та же логика, что `computeHeuristicConfidence`
 * в mock-vision, но разложенная по полям). Флагаем ТОЛЬКО критичные для МВД-учёта
 * поля — иначе amber везде = шум, теряется смысл «немногих слабых».
 *
 * Pure (now инжектируется для тестов). Возвращает boolean per поле — true = подсветить
 * amber как «распознано неуверенно, проверьте» (НЕ блокирует сохранение, в отличие
 * от hard-валидации `invalid`).
 */
export interface PassportFieldReview {
	readonly surname: boolean
	readonly name: boolean
	readonly birthDate: boolean
	readonly citizenship: boolean
	readonly documentNumber: boolean
	readonly expirationDate: boolean
}

const MIN_AGE_YEARS = 14
const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000

/** Имя/фамилия подозрительны: пусто или нереальная длина (1 или >50). */
function nameSuspect(v: string | null): boolean {
	if (v === null) return true
	const t = v.trim()
	return t.length < 2 || t.length > 50
}

export function passportFieldReview(
	entities: RecognizePassportResponse['entities'],
	identityMethod: IdentityMethod = 'passport_paper',
	now: Date = new Date(),
): PassportFieldReview {
	const isZagran = identityMethod === 'passport_zagran'
	const expirationRequired = isZagran || identityMethod === 'driver_license'

	// birthDate: пусто / невалидно / в будущем / до 1900 / возраст < 14 (РФ-паспорт от 14).
	let birthDateReview = entities.birthDate === null
	if (entities.birthDate !== null) {
		const bd = new Date(entities.birthDate)
		if (Number.isNaN(bd.getTime())) {
			birthDateReview = true
		} else {
			const ageYears = (now.getTime() - bd.getTime()) / MS_PER_YEAR
			if (bd.getFullYear() < 1900 || bd.getTime() > now.getTime() || ageYears < MIN_AGE_YEARS) {
				birthDateReview = true
			}
		}
	}

	// documentNumber: пусто; для РФ-внутреннего паспорта — не серия+номер (4 цифры + 6 цифр).
	const doc = entities.documentNumber?.trim() ?? ''
	let documentNumberReview = doc.length === 0
	if (doc.length > 0 && identityMethod === 'passport_paper' && !/^\d{4}\s?\d{6}$/.test(doc)) {
		documentNumberReview = true
	}

	return {
		surname: nameSuspect(entities.surname),
		name: nameSuspect(entities.name),
		birthDate: birthDateReview,
		citizenship: entities.citizenshipIso3 === null,
		documentNumber: documentNumberReview,
		expirationDate: expirationRequired && entities.expirationDate === null,
	}
}
