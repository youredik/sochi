/**
 * Pure presentation mappers for the reviews surface (AI review-reply 2026-05-30).
 *
 * No React, no network — just code → human-readable RU labels + design-system
 * badge variants. Kept pure so it is exhaustively unit-testable and reused by
 * the card, the summary, and any future surface (MCP-rendered, email digest…).
 *
 * Цвета НЕ хардкодим: используем только варианты дизайн-системы Badge
 * (default / secondary / destructive / outline), не сырые tailwind-классы.
 */

export type ReviewSentiment = 'positive' | 'negative' | 'mixed'
export type ReviewStatus = 'new' | 'drafted' | 'published'

/** Вариант бейджа из дизайн-системы (`components/ui/badge.tsx`). */
export type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline'

/**
 * channelCode → бренд канала. Fallback = сам код (новый канал отрендерится
 * читаемо до того, как попадёт сюда). Если появится общий реестр каналов —
 * консолидировать сюда (пока канонического shared-реестра нет).
 */
const CHANNEL_LABELS: Readonly<Record<string, string>> = {
	ostrovok: 'Островок',
	yandexTravel: 'Яндекс Путешествия',
	avito: 'Авито',
	travelLine: 'TravelLine',
	bookingCom: 'Booking.com',
	expedia: 'Expedia',
	bnovo: 'Bnovo',
	sutochno: 'Суточно.ру',
	direct: 'Прямое бронирование',
}

export function channelLabel(channelCode: string): string {
	return CHANNEL_LABELS[channelCode] ?? channelCode
}

export interface SentimentMeta {
	readonly label: string
	readonly variant: BadgeVariant
}

const SENTIMENT_META: Readonly<Record<ReviewSentiment, SentimentMeta>> = {
	positive: { label: 'Позитивный', variant: 'default' },
	negative: { label: 'Негативный', variant: 'destructive' },
	mixed: { label: 'Смешанный', variant: 'secondary' },
}

export function sentimentMeta(sentiment: ReviewSentiment): SentimentMeta {
	return SENTIMENT_META[sentiment]
}

export interface StatusMeta {
	readonly label: string
	readonly variant: BadgeVariant
}

const STATUS_META: Readonly<Record<ReviewStatus, StatusMeta>> = {
	new: { label: 'Новый', variant: 'default' },
	drafted: { label: 'Черновик ответа', variant: 'secondary' },
	published: { label: 'Опубликован', variant: 'outline' },
}

export function statusMeta(status: ReviewStatus): StatusMeta {
	return STATUS_META[status]
}

/**
 * Дата отзыва в коротком RU-формате (без времени) — `ru-RU` локаль.
 * Невалидный ISO → пустая строка (никаких «Invalid Date» в лицо хозяину).
 */
export function formatReviewDate(iso: string): string {
	const d = new Date(iso)
	if (Number.isNaN(d.getTime())) return ''
	return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
}
