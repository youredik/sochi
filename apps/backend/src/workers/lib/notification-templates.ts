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

export type TemplateVars = {
	payment_succeeded: PaymentSucceededVars
	payment_failed: PaymentFailedVars
	receipt_confirmed: ReceiptConfirmedVars
	receipt_failed: ReceiptFailedVars
	booking_confirmed: BookingConfirmedVars
	checkin_reminder: CheckinReminderVars
	review_request: ReviewRequestVars
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
