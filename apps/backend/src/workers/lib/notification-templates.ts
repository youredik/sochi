/**
 * Pure-lib notification templates — Russian-locale HTML + plain-text email
 * bodies, hand-rolled template literals (Mustache/Handlebars over-engineering
 * for 7 templates with 5 variables).
 *
 * **XSS hardening (CRITICAL)**: every variable rendered into HTML must pass
 * through `escapeHtml`. Guest names are user input — `<script>alert(1)</script>`
 * in a name reaches the email otherwise. Pre-commit unit-tests prove escape.
 *
 * **Plain-text alt MIME (MUST)**: SpamAssassin penalises HTML-only +0.5–1.0;
 * Mail.ru 2026 deliverability degrades без plain-text part. Templates emit
 * BOTH `html` and `text` from the same vars — never one branch only.
 *
 * **Subject conventions** (research synthesis 2026-04-26):
 *   - ≤ 40 characters
 *   - no emoji, no CAPS, no `!!!` (antispam triggers)
 *   - direct + transactional («Чек об оплате № 123»)
 *
 * **Salutation**: «Здравствуйте, {{name}}!» — neutral both day/evening.
 *
 * **152-ФЗ footer** for transactional (consent NOT required, but disclosure is):
 *   - Юр. наименование оператора + ИНН (resolve at dispatch from organization
 *     row; templates accept `senderOrgName` + `senderInn` vars)
 *   - "Это уведомление направлено в рамках договора оказания гостиничных
 *     услуг" (контекстная фраза)
 *   - Контакт оператора ПДн
 *
 * Templates do NOT include unsubscribe links for transactional kinds — RU
 * law (152-ФЗ + 38-ФЗ) does not require them and adding "Отписаться" UI for
 * receipts is confusing. `review_request` is a borderline case — phrased as
 * service follow-up, not marketing.
 */

import type { NotificationKind } from '@horeca/shared'

export interface RenderedEmail {
	subject: string
	html: string
	text: string
}

/* ----------------------------------------------------------------- escapeHtml */

const HTML_ESCAPES: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;',
}

/**
 * Escape HTML special characters in user-provided strings. Used for every
 * variable that lands in the `html` branch of a template; plain-text branch
 * does NOT need escaping (text/plain MIME is rendered verbatim).
 */
export function escapeHtml(input: string): string {
	return input.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch)
}

/* ----------------------------------------------------------------- vars shapes */

interface BaseVars {
	guestName: string
	propertyName: string
	senderOrgName: string
	senderInn: string
	senderEmail: string
}

export interface PaymentSucceededVars extends BaseVars {
	paymentNumber: string
	amountFormatted: string // e.g. "5 000,00 ₽"
	receiptQrUrl: string | null // 54-ФЗ QR link (if available at send time)
}

export interface PaymentFailedVars extends BaseVars {
	paymentNumber: string
	failureReason: string
	bookingId: string
}

export interface ReceiptConfirmedVars extends BaseVars {
	receiptNumber: string
	qrUrl: string
	amountFormatted: string
}

export interface ReceiptFailedVars extends BaseVars {
	receiptNumber: string
	failureReason: string
}

export interface BookingConfirmedVars extends BaseVars {
	bookingNumber: string
	checkInDate: string // RU-formatted: "25 апреля 2026"
	checkOutDate: string
	totalFormatted: string
}

export interface CheckinReminderVars extends BaseVars {
	bookingNumber: string
	checkInDate: string
	propertyAddress: string
}

export interface ReviewRequestVars extends BaseVars {
	bookingNumber: string
	yandexMapsReviewUrl: string
}

// M8.A.0.6 — public-widget guest journey (research §10.3 / §10.6 / §10.7).

export interface PreArrivalVars extends BaseVars {
	bookingNumber: string
	checkInDate: string // RU-formatted: "25 апреля 2026"
	checkInTime: string // e.g. "15:00"
	propertyAddress: string
	yandexMapsLink: string
	travelInstructions: string | null
}

export interface BookingCancelledVars extends BaseVars {
	bookingNumber: string
	checkInDate: string
	nights: number
	totalFormatted: string
	cancellationFeeFormatted: string | null
	refundAmountFormatted: string
	refundEtaDays: number
}

export interface BookingModifiedVars extends BaseVars {
	bookingNumber: string
	modificationSummary: string
	totalFormatted: string
	surchargeFormatted: string | null
	refundFormatted: string | null
	magicUrl: string
}

/**
 * M9.widget.5 / A3.1.c — guest-portal magic-link delivery.
 *
 * Per `plans/m9_widget_5_canonical.md` §D11 (strict transactional canon):
 *   - 38-ФЗ ст. 18 carve-out: NO cross-sell, NO marketing, NO unsubscribe
 *   - 152-ФЗ ст. 22.1 disclosure footer (operator + ИНН)
 *   - Tone «Вы / Ваш» formal
 *   - 24h ссылка validity disclosure + «не передавайте» privacy reminder
 */
export interface BookingMagicLinkVars extends BaseVars {
	bookingReference: string
	magicLinkUrl: string
}

export type TemplateVars = {
	payment_succeeded: PaymentSucceededVars
	payment_failed: PaymentFailedVars
	receipt_confirmed: ReceiptConfirmedVars
	receipt_failed: ReceiptFailedVars
	booking_confirmed: BookingConfirmedVars
	checkin_reminder: CheckinReminderVars
	review_request: ReviewRequestVars
	pre_arrival: PreArrivalVars
	booking_cancelled: BookingCancelledVars
	booking_modified: BookingModifiedVars
	booking_magic_link: BookingMagicLinkVars
}

/* ----------------------------------------------------------------- shared chrome */

function htmlChrome(bodyHtml: string, v: BaseVars): string {
	return `<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f7f7f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1a1a">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f7f8;padding:24px 0">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:8px;padding:32px">
${bodyHtml}
<tr><td style="padding-top:24px;border-top:1px solid #e6e6e6;font-size:12px;color:#666">
<p style="margin:8px 0">${escapeHtml(v.senderOrgName)}, ИНН ${escapeHtml(v.senderInn)}</p>
<p style="margin:8px 0">Это уведомление направлено в рамках договора оказания гостиничных услуг.</p>
<p style="margin:8px 0">Контакт оператора персональных данных: <a href="mailto:${escapeHtml(v.senderEmail)}" style="color:#0066cc">${escapeHtml(v.senderEmail)}</a></p>
</td></tr>
</table>
</td></tr></table>
</body></html>`
}

function textFooter(v: BaseVars): string {
	return `\n\n---\n${v.senderOrgName}, ИНН ${v.senderInn}\nЭто уведомление направлено в рамках договора оказания гостиничных услуг.\nКонтакт оператора ПДн: ${v.senderEmail}\n`
}

/* ----------------------------------------------------------------- templates */

export function renderTemplate<K extends NotificationKind>(
	kind: K,
	vars: TemplateVars[K],
): RenderedEmail {
	switch (kind) {
		case 'payment_succeeded':
			return renderPaymentSucceeded(vars as PaymentSucceededVars)
		case 'payment_failed':
			return renderPaymentFailed(vars as PaymentFailedVars)
		case 'receipt_confirmed':
			return renderReceiptConfirmed(vars as ReceiptConfirmedVars)
		case 'receipt_failed':
			return renderReceiptFailed(vars as ReceiptFailedVars)
		case 'booking_confirmed':
			return renderBookingConfirmed(vars as BookingConfirmedVars)
		case 'checkin_reminder':
			return renderCheckinReminder(vars as CheckinReminderVars)
		case 'review_request':
			return renderReviewRequest(vars as ReviewRequestVars)
		case 'pre_arrival':
			return renderPreArrival(vars as PreArrivalVars)
		case 'booking_cancelled':
			return renderBookingCancelled(vars as BookingCancelledVars)
		case 'booking_modified':
			return renderBookingModified(vars as BookingModifiedVars)
		case 'booking_magic_link':
			return renderBookingMagicLink(vars as BookingMagicLinkVars)
		default: {
			// Exhaustive guard — TS errors if a new kind is added without a case.
			const _exhaustive: never = kind
			throw new Error(`renderTemplate: unhandled kind ${String(_exhaustive)}`)
		}
	}
}

function renderPaymentSucceeded(v: PaymentSucceededVars): RenderedEmail {
	const subject = `Чек об оплате № ${v.paymentNumber}`
	const qrLine = v.receiptQrUrl
		? `<p>QR-код для проверки чека: <a href="${escapeHtml(v.receiptQrUrl)}" style="color:#0066cc">${escapeHtml(v.receiptQrUrl)}</a></p>`
		: ''
	const qrText = v.receiptQrUrl ? `\nQR-код для проверки чека: ${v.receiptQrUrl}` : ''
	const body = `<tr><td>
<h1 style="margin:0 0 16px;font-size:22px;font-weight:600">Платёж подтверждён</h1>
<p style="margin:0 0 12px">Здравствуйте, ${escapeHtml(v.guestName)}!</p>
<p style="margin:0 0 12px">Мы получили вашу оплату по платежу № <strong>${escapeHtml(v.paymentNumber)}</strong> на сумму <strong>${escapeHtml(v.amountFormatted)}</strong>.</p>
<p style="margin:0 0 12px">Гостиница: ${escapeHtml(v.propertyName)}</p>
${qrLine}
</td></tr>`
	return {
		subject,
		html: htmlChrome(body, v),
		text: `Здравствуйте, ${v.guestName}!\n\nМы получили вашу оплату по платежу № ${v.paymentNumber} на сумму ${v.amountFormatted}.\nГостиница: ${v.propertyName}${qrText}${textFooter(v)}`,
	}
}

function renderPaymentFailed(v: PaymentFailedVars): RenderedEmail {
	const subject = `Платёж не прошёл — № ${v.paymentNumber}`
	const body = `<tr><td>
<h1 style="margin:0 0 16px;font-size:22px;font-weight:600;color:#cc0000">Платёж не прошёл</h1>
<p style="margin:0 0 12px">Здравствуйте, ${escapeHtml(v.guestName)}!</p>
<p style="margin:0 0 12px">Платёж № <strong>${escapeHtml(v.paymentNumber)}</strong> по бронированию ${escapeHtml(v.bookingId)} не был проведён.</p>
<p style="margin:0 0 12px">Причина: ${escapeHtml(v.failureReason)}</p>
<p style="margin:0 0 12px">Свяжитесь с гостиницей ${escapeHtml(v.propertyName)} для уточнения деталей.</p>
</td></tr>`
	return {
		subject,
		html: htmlChrome(body, v),
		text: `Здравствуйте, ${v.guestName}!\n\nПлатёж № ${v.paymentNumber} по бронированию ${v.bookingId} не был проведён.\nПричина: ${v.failureReason}\nСвяжитесь с гостиницей ${v.propertyName} для уточнения деталей.${textFooter(v)}`,
	}
}

function renderReceiptConfirmed(v: ReceiptConfirmedVars): RenderedEmail {
	const subject = `Кассовый чек № ${v.receiptNumber}`
	const body = `<tr><td>
<h1 style="margin:0 0 16px;font-size:22px;font-weight:600">Кассовый чек 54-ФЗ</h1>
<p style="margin:0 0 12px">Здравствуйте, ${escapeHtml(v.guestName)}!</p>
<p style="margin:0 0 12px">Чек № <strong>${escapeHtml(v.receiptNumber)}</strong> на сумму <strong>${escapeHtml(v.amountFormatted)}</strong> зарегистрирован в ФНС.</p>
<p style="margin:0 0 12px">QR-код для проверки чека: <a href="${escapeHtml(v.qrUrl)}" style="color:#0066cc">${escapeHtml(v.qrUrl)}</a></p>
<p style="margin:0 0 12px">Гостиница: ${escapeHtml(v.propertyName)}</p>
</td></tr>`
	return {
		subject,
		html: htmlChrome(body, v),
		text: `Здравствуйте, ${v.guestName}!\n\nЧек № ${v.receiptNumber} на сумму ${v.amountFormatted} зарегистрирован в ФНС.\nQR-код для проверки чека: ${v.qrUrl}\nГостиница: ${v.propertyName}${textFooter(v)}`,
	}
}

function renderReceiptFailed(v: ReceiptFailedVars): RenderedEmail {
	const subject = `Ошибка регистрации чека № ${v.receiptNumber}`
	const body = `<tr><td>
<h1 style="margin:0 0 16px;font-size:22px;font-weight:600;color:#cc0000">Чек не зарегистрирован</h1>
<p style="margin:0 0 12px">Чек № <strong>${escapeHtml(v.receiptNumber)}</strong> не прошёл регистрацию в ФНС.</p>
<p style="margin:0 0 12px">Причина: ${escapeHtml(v.failureReason)}</p>
<p style="margin:0 0 12px">Гостиница: ${escapeHtml(v.propertyName)}. Требуется ручная корректировка фискального документа.</p>
</td></tr>`
	return {
		subject,
		html: htmlChrome(body, v),
		text: `Чек № ${v.receiptNumber} не прошёл регистрацию в ФНС.\nПричина: ${v.failureReason}\nГостиница: ${v.propertyName}. Требуется ручная корректировка фискального документа.${textFooter(v)}`,
	}
}

function renderBookingConfirmed(v: BookingConfirmedVars): RenderedEmail {
	const subject = `Бронирование № ${v.bookingNumber} подтверждено`
	const body = `<tr><td>
<h1 style="margin:0 0 16px;font-size:22px;font-weight:600">Бронирование подтверждено</h1>
<p style="margin:0 0 12px">Здравствуйте, ${escapeHtml(v.guestName)}!</p>
<p style="margin:0 0 12px">Спасибо за выбор гостиницы <strong>${escapeHtml(v.propertyName)}</strong>.</p>
<p style="margin:0 0 8px">Номер бронирования: <strong>${escapeHtml(v.bookingNumber)}</strong></p>
<p style="margin:0 0 8px">Заезд: <strong>${escapeHtml(v.checkInDate)}</strong></p>
<p style="margin:0 0 8px">Выезд: <strong>${escapeHtml(v.checkOutDate)}</strong></p>
<p style="margin:0 0 12px">Сумма: <strong>${escapeHtml(v.totalFormatted)}</strong></p>
<p style="margin:0 0 12px">Ждём вас!</p>
</td></tr>`
	return {
		subject,
		html: htmlChrome(body, v),
		text: `Здравствуйте, ${v.guestName}!\n\nСпасибо за выбор гостиницы ${v.propertyName}.\nНомер бронирования: ${v.bookingNumber}\nЗаезд: ${v.checkInDate}\nВыезд: ${v.checkOutDate}\nСумма: ${v.totalFormatted}\n\nЖдём вас!${textFooter(v)}`,
	}
}

function renderCheckinReminder(v: CheckinReminderVars): RenderedEmail {
	const subject = `Напоминание о заезде завтра`
	const body = `<tr><td>
<h1 style="margin:0 0 16px;font-size:22px;font-weight:600">Ждём вас завтра</h1>
<p style="margin:0 0 12px">Здравствуйте, ${escapeHtml(v.guestName)}!</p>
<p style="margin:0 0 12px">Напоминаем, что ${escapeHtml(v.checkInDate)} вы заезжаете в гостиницу <strong>${escapeHtml(v.propertyName)}</strong> (бронирование № ${escapeHtml(v.bookingNumber)}).</p>
<p style="margin:0 0 12px">Адрес: ${escapeHtml(v.propertyAddress)}</p>
<p style="margin:0 0 12px">Возьмите с собой паспорт. До встречи!</p>
</td></tr>`
	return {
		subject,
		html: htmlChrome(body, v),
		text: `Здравствуйте, ${v.guestName}!\n\nНапоминаем, что ${v.checkInDate} вы заезжаете в гостиницу ${v.propertyName} (бронирование № ${v.bookingNumber}).\nАдрес: ${v.propertyAddress}\n\nВозьмите с собой паспорт. До встречи!${textFooter(v)}`,
	}
}

function renderReviewRequest(v: ReviewRequestVars): RenderedEmail {
	const subject = `Поделитесь впечатлениями о визите`
	const body = `<tr><td>
<h1 style="margin:0 0 16px;font-size:22px;font-weight:600">Спасибо за визит</h1>
<p style="margin:0 0 12px">Здравствуйте, ${escapeHtml(v.guestName)}!</p>
<p style="margin:0 0 12px">Спасибо, что выбрали гостиницу <strong>${escapeHtml(v.propertyName)}</strong>. Нам важно ваше мнение — расскажите о вашем визите на Яндекс.Картах:</p>
<p style="margin:0 0 12px"><a href="${escapeHtml(v.yandexMapsReviewUrl)}" style="color:#0066cc;font-weight:600">Оставить отзыв</a></p>
<p style="margin:0 0 12px">Бронирование № ${escapeHtml(v.bookingNumber)}.</p>
</td></tr>`
	return {
		subject,
		html: htmlChrome(body, v),
		text: `Здравствуйте, ${v.guestName}!\n\nСпасибо, что выбрали гостиницу ${v.propertyName}. Нам важно ваше мнение — расскажите о вашем визите на Яндекс.Картах:\n${v.yandexMapsReviewUrl}\n\nБронирование № ${v.bookingNumber}.${textFooter(v)}`,
	}
}

// M8.A.0.6 — public-widget journey templates per research §10.

function renderPreArrival(v: PreArrivalVars): RenderedEmail {
	const subject = `Скоро ваш отдых в ${v.propertyName} — заезд через 3 дня`
	const travelLine = v.travelInstructions
		? `<p style="margin:0 0 12px"><strong>Как добраться:</strong> ${escapeHtml(v.travelInstructions)}</p>`
		: ''
	const travelText = v.travelInstructions ? `\nКак добраться: ${v.travelInstructions}` : ''
	const body = `<tr><td>
<h1 style="margin:0 0 16px;font-size:22px;font-weight:600">Через 3 дня ждём вас</h1>
<p style="margin:0 0 12px">Здравствуйте, ${escapeHtml(v.guestName)}!</p>
<p style="margin:0 0 12px">Через 3 дня ждём вас в <strong>${escapeHtml(v.propertyName)}</strong>.</p>
<p style="margin:0 0 12px">Заезд: <strong>${escapeHtml(v.checkInDate)}</strong> с ${escapeHtml(v.checkInTime)}</p>
<p style="margin:0 0 12px">Адрес: ${escapeHtml(v.propertyAddress)}</p>
<p style="margin:0 0 12px">Карта: <a href="${escapeHtml(v.yandexMapsLink)}" style="color:#0066cc">${escapeHtml(v.yandexMapsLink)}</a></p>
${travelLine}
<p style="margin:0 0 12px">Документы: паспорт РФ или загранпаспорт (по 109-ФЗ).</p>
<p style="margin:0 0 12px">Бронирование № ${escapeHtml(v.bookingNumber)}.</p>
</td></tr>`
	return {
		subject,
		html: htmlChrome(body, v),
		text: `Здравствуйте, ${v.guestName}!\n\nЧерез 3 дня ждём вас в ${v.propertyName}.\nЗаезд: ${v.checkInDate} с ${v.checkInTime}\nАдрес: ${v.propertyAddress}\nКарта: ${v.yandexMapsLink}${travelText}\n\nДокументы: паспорт РФ или загранпаспорт (по 109-ФЗ).\nБронирование № ${v.bookingNumber}.${textFooter(v)}`,
	}
}

function renderBookingCancelled(v: BookingCancelledVars): RenderedEmail {
	const subject = `Бронирование № ${v.bookingNumber} отменено`
	const feeLine = v.cancellationFeeFormatted
		? `<p style="margin:0 0 12px">Удержание по политике отмены: <strong>${escapeHtml(v.cancellationFeeFormatted)}</strong></p>`
		: ''
	const feeText = v.cancellationFeeFormatted
		? `\nУдержание по политике отмены: ${v.cancellationFeeFormatted}`
		: ''
	const nightsLabel = v.nights === 1 ? 'ночь' : v.nights < 5 ? 'ночи' : 'ночей'
	const etaLabel = v.refundEtaDays === 1 ? 'дня' : 'дней'
	const body = `<tr><td>
<h1 style="margin:0 0 16px;font-size:22px;font-weight:600">Бронирование отменено</h1>
<p style="margin:0 0 12px">Здравствуйте, ${escapeHtml(v.guestName)}!</p>
<p style="margin:0 0 12px">Подтверждаем отмену бронирования № <strong>${escapeHtml(v.bookingNumber)}</strong> в ${escapeHtml(v.propertyName)}.</p>
<p style="margin:0 0 12px">Заезд был запланирован на: ${escapeHtml(v.checkInDate)} (${v.nights} ${nightsLabel})</p>
<p style="margin:0 0 12px">Сумма брони: ${escapeHtml(v.totalFormatted)}</p>
${feeLine}
<p style="margin:0 0 12px">Возврат: <strong>${escapeHtml(v.refundAmountFormatted)}</strong> — поступит в течение ${v.refundEtaDays} рабочих ${etaLabel}.</p>
<p style="margin:0 0 12px">Будем рады видеть вас снова.</p>
</td></tr>`
	return {
		subject,
		html: htmlChrome(body, v),
		text: `Здравствуйте, ${v.guestName}!\n\nПодтверждаем отмену бронирования № ${v.bookingNumber} в ${v.propertyName}.\nЗаезд был запланирован на: ${v.checkInDate} (${v.nights} ${nightsLabel})\nСумма брони: ${v.totalFormatted}${feeText}\nВозврат: ${v.refundAmountFormatted} — поступит в течение ${v.refundEtaDays} рабочих ${etaLabel}.\n\nБудем рады видеть вас снова.${textFooter(v)}`,
	}
}

function renderBookingMagicLink(v: BookingMagicLinkVars): RenderedEmail {
	const subject = `Управление бронированием №${v.bookingReference}`
	const body = `<tr><td>
<h1 style="margin:0 0 16px;font-size:20px;font-weight:600">Управление бронированием №${escapeHtml(v.bookingReference)}</h1>
<p style="margin:0 0 16px;line-height:1.5">Здравствуйте! По вашему запросу мы отправляем ссылку для управления бронированием в <strong>${escapeHtml(v.propertyName)}</strong>.</p>
<p style="margin:0 0 24px;line-height:1.5">
<a href="${escapeHtml(v.magicLinkUrl)}" style="display:inline-block;padding:12px 24px;background:#0066cc;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:500">Открыть бронирование</a>
</p>
<p style="margin:0 0 16px;line-height:1.5;font-size:13px;color:#666">Если кнопка не работает, скопируйте ссылку:<br><a href="${escapeHtml(v.magicLinkUrl)}" style="color:#0066cc;word-break:break-all">${escapeHtml(v.magicLinkUrl)}</a></p>
<p style="margin:0 0 8px;line-height:1.5;font-size:13px;color:#666">Ссылка действительна 24 часа. Не передавайте её другим лицам — по ней доступны данные брони и платежа.</p>
<p style="margin:0;line-height:1.5;font-size:13px;color:#666">Если вы не запрашивали эту ссылку — просто проигнорируйте письмо.</p>
</td></tr>`
	const text = `Здравствуйте!

По вашему запросу мы отправляем ссылку для управления бронированием №${v.bookingReference} в ${v.propertyName}.

Перейдите по ссылке для просмотра деталей и управления:
${v.magicLinkUrl}

Ссылка действительна 24 часа. Не передавайте её другим лицам — по ней доступны данные брони и платежа.

Если вы не запрашивали эту ссылку — просто проигнорируйте письмо. Бронирование не изменится.${textFooter(v)}`
	return { subject, html: htmlChrome(body, v), text }
}

function renderBookingModified(v: BookingModifiedVars): RenderedEmail {
	const subject = `Изменения в бронировании № ${v.bookingNumber}`
	const surchargeLine = v.surchargeFormatted
		? `<p style="margin:0 0 12px">Доплата: <strong>${escapeHtml(v.surchargeFormatted)}</strong></p>`
		: ''
	const refundLine = v.refundFormatted
		? `<p style="margin:0 0 12px">Возврат: <strong>${escapeHtml(v.refundFormatted)}</strong></p>`
		: ''
	const surchargeText = v.surchargeFormatted ? `\nДоплата: ${v.surchargeFormatted}` : ''
	const refundText = v.refundFormatted ? `\nВозврат: ${v.refundFormatted}` : ''
	const body = `<tr><td>
<h1 style="margin:0 0 16px;font-size:22px;font-weight:600">Изменения в бронировании</h1>
<p style="margin:0 0 12px">Здравствуйте, ${escapeHtml(v.guestName)}!</p>
<p style="margin:0 0 12px">В бронировании № <strong>${escapeHtml(v.bookingNumber)}</strong> в ${escapeHtml(v.propertyName)} внесены изменения:</p>
<p style="margin:0 0 12px">${escapeHtml(v.modificationSummary)}</p>
<p style="margin:0 0 12px">Новая сумма: <strong>${escapeHtml(v.totalFormatted)}</strong></p>
${surchargeLine}
${refundLine}
<p style="margin:0 0 12px">Управлять бронированием: <a href="${escapeHtml(v.magicUrl)}" style="color:#0066cc">${escapeHtml(v.magicUrl)}</a></p>
</td></tr>`
	return {
		subject,
		html: htmlChrome(body, v),
		text: `Здравствуйте, ${v.guestName}!\n\nВ бронировании № ${v.bookingNumber} в ${v.propertyName} внесены изменения:\n${v.modificationSummary}\n\nНовая сумма: ${v.totalFormatted}${surchargeText}${refundText}\n\nУправлять бронированием: ${v.magicUrl}${textFooter(v)}`,
	}
}
