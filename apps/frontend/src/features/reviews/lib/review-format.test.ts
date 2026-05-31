/**
 * Strict unit tests for review presentation mappers.
 */
import { describe, expect, test } from 'bun:test'
import {
	channelLabel,
	formatReviewDate,
	sentimentMeta,
	statusMeta,
	type BadgeVariant,
	type ReviewSentiment,
	type ReviewStatus,
} from './review-format.ts'

describe('channelLabel', () => {
	test('known codes → RU brand', () => {
		expect(channelLabel('ostrovok')).toBe('Островок')
		expect(channelLabel('yandexTravel')).toBe('Яндекс Путешествия')
		expect(channelLabel('avito')).toBe('Авито')
	})

	test('unknown code → passthrough (no crash, readable)', () => {
		expect(channelLabel('someNewChannel')).toBe('someNewChannel')
	})
})

describe('sentimentMeta', () => {
	test('each sentiment → exact label + design-system variant', () => {
		const cases: Record<ReviewSentiment, { label: string; variant: BadgeVariant }> = {
			positive: { label: 'Позитивный', variant: 'default' },
			negative: { label: 'Негативный', variant: 'destructive' },
			mixed: { label: 'Смешанный', variant: 'secondary' },
		}
		for (const [sentiment, expected] of Object.entries(cases)) {
			const meta = sentimentMeta(sentiment as ReviewSentiment)
			expect(meta.label).toBe(expected.label)
			expect(meta.variant).toBe(expected.variant)
		}
	})
})

describe('statusMeta', () => {
	test('each status → exact label + variant', () => {
		const cases: Record<ReviewStatus, { label: string; variant: BadgeVariant }> = {
			new: { label: 'Новый', variant: 'default' },
			drafted: { label: 'Черновик ответа', variant: 'secondary' },
			published: { label: 'Опубликован', variant: 'outline' },
		}
		for (const [status, expected] of Object.entries(cases)) {
			const meta = statusMeta(status as ReviewStatus)
			expect(meta.label).toBe(expected.label)
			expect(meta.variant).toBe(expected.variant)
		}
	})
})

describe('formatReviewDate', () => {
	test('valid ISO → non-empty RU date containing the year', () => {
		const out = formatReviewDate('2026-05-20T12:00:00.000Z')
		expect(out).not.toBe('')
		expect(out).toContain('2026')
	})

	test('invalid ISO → empty string (no "Invalid Date" leak)', () => {
		expect(formatReviewDate('not-a-date')).toBe('')
		expect(formatReviewDate('')).toBe('')
	})
})
