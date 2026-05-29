/**
 * Central user-facing error message layer (2026-05-29, booking/guest UX refactor).
 *
 * Принцип: пользователю НИКОГДА не показывается сырой `error.message`. Тосты и
 * алерты берут текст ТОЛЬКО из этого словаря по стабильному `code` бэкенда
 * (`DomainError.code`), с дружелюбным RU-fallback для неизвестного.
 *
 * Почему: до этого фронт делал `toast.error(err.message)`, и внутренние строки
 * вроде «buildGuestCreateBody: documentNumber required» или английский
 * `DomainError.message` («Cannot transition booking from 'x' to 'y'») уезжали
 * в лицо администратору гостиницы. Аудит 2026-05-29 нашёл целый класс таких
 * утечек. Единый словарь устраняет дублирующиеся inline-switch'и в
 * use-booking-mutations / use-booking-transitions / use-folio-queries.
 *
 * Сырое `error.message` остаётся ТОЛЬКО для `logger` (диагностика), не для UI.
 */

import type { ApiError } from './api-errors.ts'

/** Дружелюбный generic, когда код неизвестен/отсутствует. */
const GENERIC = 'Не удалось выполнить действие. Попробуйте ещё раз.'

/**
 * Стабильные коды `DomainError` (backend `errors/domain.ts` + `http-mapping.ts`)
 * → операторский RU-текст. Покрывает booking / guest / inventory / folio /
 * payment / refund / property-block / compliance поверхности, которые трогает
 * фронт. Неизвестный код → GENERIC (но НИКОГДА не raw message).
 */
const CODE_TO_RU: Readonly<Record<string, string>> = {
	// — общие —
	VALIDATION_ERROR: 'Проверьте корректность введённых данных.',
	NOT_FOUND: 'Запись не найдена — возможно, её уже удалили. Обновите страницу.',
	FORBIDDEN: 'Недостаточно прав для этого действия.',
	CONFLICT: 'Действие конфликтует с текущим состоянием. Обновите страницу.',
	DB_ERROR: 'База данных временно недоступна. Повторите через несколько секунд.',
	INTERNAL: 'Внутренняя ошибка сервиса. Мы уже разбираемся — повторите позже.',
	IDEMPOTENCY_KEY_CONFLICT: 'Повторная отправка с другими данными. Обновите страницу и повторите.',
	// — инвентарь / номера / тарифы —
	ROOM_NUMBER_TAKEN: 'Номер с таким названием уже есть в этой гостинице.',
	RATE_PLAN_CODE_TAKEN: 'Тариф с таким кодом уже существует.',
	NO_INVENTORY: 'На эти даты нет свободных номеров выбранной категории.',
	// — бронирования —
	BOOKING_EXTERNAL_ID_TAKEN: 'Бронь с таким внешним номером уже существует.',
	INVALID_BOOKING_TRANSITION: 'Это действие недоступно для текущего статуса брони.',
	INVALID_BOOKING_AMEND_STATE: 'Бронь в этом статусе нельзя изменить таким образом.',
	ROOM_ASSIGNMENT_CONFLICT: 'Номер занят или не подходит под эту бронь. Выберите другой.',
	STALE_AVAILABILITY: 'Цена или доступность изменились. Обновите и попробуйте снова.',
	// — заезд / документы / МВД —
	PASSPORT_SCAN_REQUIRED:
		'Для иностранного гостя нужен скан документа до заезда. Откройте бронь → «Сканировать паспорт».',
	KSR_REGISTRY_NUMBER_MISSING:
		'Не заполнен реестровый номер КСР. Укажите его в профиле гостиницы перед приёмом броней.',
	GUEST_HOUSE_FZ127_NOT_REGISTERED:
		'Гостевой дом не зарегистрирован в реестре 127-ФЗ. Подайте заявку через Госуслуги.',
	// — блокировки номеров —
	PROPERTY_BLOCK_BOOKING_CONFLICT:
		'Нельзя заблокировать номер с активной бронью. Сначала перенесите бронь.',
	PROPERTY_BLOCK_BLOCK_OVERLAP:
		'Блокировка пересекается с уже существующей. Объедините или измените даты.',
	PROPERTY_BLOCK_PAST_IMMUTABLE: 'Прошедшую блокировку нельзя сократить задним числом.',
	// — счёт / оплаты / возвраты —
	INVALID_FOLIO_TRANSITION: 'Это действие недоступно для текущего состояния счёта.',
	FOLIO_HAS_DRAFT_LINES: 'В счёте есть непроведённые позиции — проведите или удалите их.',
	FOLIO_CURRENCY_MISMATCH: 'Валюта позиции не совпадает с валютой счёта.',
	FOLIO_VERSION_CONFLICT: 'Счёт изменился в другом окне. Обновите страницу.',
	INVALID_PAYMENT_TRANSITION: 'Это действие недоступно для текущего статуса платежа.',
	PAYMENT_VERSION_CONFLICT: 'Платёж изменился в другом окне. Обновите страницу.',
	REFUND_EXCEEDS_CAPTURE: 'Сумма возврата превышает сумму платежа.',
	INVALID_FOLIO_LINE_TRANSITION: 'Этот переход недоступен для позиции счёта.',
	INVALID_REFUND_TRANSITION: 'Это действие недоступно для текущего статуса возврата.',
	REFUND_VERSION_CONFLICT: 'Возврат изменился в другом окне. Обновите страницу.',
	REFUND_CAUSALITY_COLLISION: 'Возврат с такой причиной уже создан для этого платежа.',
	PAYMENT_IDEMPOTENCY_KEY_TAKEN: 'Платёж с таким ключом уже создан.',
	PROVIDER_PAYMENT_ID_TAKEN: 'Этот платёж уже зарегистрирован у провайдера.',
	PROVIDER_REFUND_ID_TAKEN: 'Этот возврат уже зарегистрирован у провайдера.',
	// — уведомления / виджет —
	NOTIFICATION_ALREADY_SENT: 'Уведомление уже отправлено — повторная отправка невозможна.',
	WIDGET_CONSENT_MISSING: 'Требуется согласие гостя на обработку персональных данных.',
	// — клиентская валидация (фронтовые билдеры) —
	CLIENT_VALIDATION: 'Проверьте корректность введённых данных.',
}

/** Узкий type-guard для ApiError-подобного объекта (есть строковый code/message). */
function isApiErrorLike(err: unknown): err is ApiError {
	return typeof err === 'object' && err !== null && 'message' in err
}

/**
 * Перевести любую ошибку в операторский RU-текст. НИКОГДА не возвращает
 * сырое `err.message`. Порядок: known code → словарь; иначе → GENERIC.
 *
 * @param err ApiError / Error / unknown из mutationFn / catch.
 * @param fallback необязательный контекстный fallback (например
 *   «Не удалось создать бронь») — используется вместо общего GENERIC, когда
 *   код неизвестен. Тоже НИКОГДА не содержит raw message.
 */
export function userMessageFor(err: unknown, fallback: string = GENERIC): string {
	if (isApiErrorLike(err) && typeof err.code === 'string') {
		// CLIENT_VALIDATION — наши собственные клиентские валидаторы (GuestInputError
		// и т.п.) с УЖЕ дружелюбным RU-текстом, который мы сами авторили (напр.
		// «Укажите имя гостя»). Это доверенный источник → показываем как есть.
		// Это единственное исключение из «никогда не показывать err.message».
		if (err.code === 'CLIENT_VALIDATION' && typeof err.message === 'string' && err.message) {
			return err.message
		}
		const mapped = CODE_TO_RU[err.code]
		if (mapped !== undefined) return mapped
	}
	return fallback
}

/** Прямой доступ к словарю для тестов / переиспользования. */
export const ERROR_CODE_MESSAGES = CODE_TO_RU
export const GENERIC_ERROR_MESSAGE = GENERIC
