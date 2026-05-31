/**
 * Strict unit tests for summarizeReviews — pure derivation, exact values.
 */
import { describe, expect, test } from 'bun:test'
import { summarizeReviews, type SummarizableReview } from './review-summary.ts'

function r(overrides: Partial<SummarizableReview> = {}): SummarizableReview {
	return {
		ratingOverall: 5,
		aiSentiment: null,
		aiTopics: null,
		status: 'new',
		...overrides,
	}
}

describe('summarizeReviews', () => {
	test('empty input → zeroed summary, avgRating null', () => {
		const s = summarizeReviews([])
		expect(s.total).toBe(0)
		expect(s.newCount).toBe(0)
		expect(s.draftedCount).toBe(0)
		expect(s.publishedCount).toBe(0)
		expect(s.ratedCount).toBe(0)
		expect(s.avgRating).toBeNull()
		expect(s.sentiment).toEqual({ positive: 0, negative: 0, mixed: 0 })
		expect(s.topTopics).toEqual([])
	})

	test('counts statuses exactly', () => {
		const s = summarizeReviews([
			r({ status: 'new' }),
			r({ status: 'new' }),
			r({ status: 'drafted' }),
			r({ status: 'published' }),
		])
		expect(s.total).toBe(4)
		expect(s.newCount).toBe(2)
		expect(s.draftedCount).toBe(1)
		expect(s.publishedCount).toBe(1)
	})

	test('avgRating ignores null ratings, rounds to 0.1', () => {
		const s = summarizeReviews([
			r({ ratingOverall: 5 }),
			r({ ratingOverall: 4 }),
			r({ ratingOverall: 2 }),
			r({ ratingOverall: null }), // excluded from avg + ratedCount
		])
		expect(s.ratedCount).toBe(3)
		// (5 + 4 + 2) / 3 = 3.666… → 3.7
		expect(s.avgRating).toBe(3.7)
	})

	test('avgRating null when no rated reviews', () => {
		const s = summarizeReviews([r({ ratingOverall: null }), r({ ratingOverall: null })])
		expect(s.ratedCount).toBe(0)
		expect(s.avgRating).toBeNull()
	})

	test('sentiment counts only non-null', () => {
		const s = summarizeReviews([
			r({ aiSentiment: 'positive' }),
			r({ aiSentiment: 'positive' }),
			r({ aiSentiment: 'negative' }),
			r({ aiSentiment: 'mixed' }),
			r({ aiSentiment: null }),
		])
		expect(s.sentiment).toEqual({ positive: 2, negative: 1, mixed: 1 })
	})

	test('topTopics: top-3 by count desc, alphabetical tie-break, ru', () => {
		const s = summarizeReviews([
			r({ aiTopics: ['чистота', 'шум'] }),
			r({ aiTopics: ['чистота', 'локация'] }),
			r({ aiTopics: ['чистота', 'локация', 'персонал'] }),
			r({ aiTopics: null }),
		])
		// чистота=3, локация=2, then тие among count=1 (персонал, шум) → alpha
		expect(s.topTopics).toEqual([
			{ topic: 'чистота', count: 3 },
			{ topic: 'локация', count: 2 },
			{ topic: 'персонал', count: 1 }, // 'персонал' < 'шум' in ru collation
		])
	})

	test('topTopics caps at 3 even with more distinct topics', () => {
		const s = summarizeReviews([r({ aiTopics: ['чистота', 'шум', 'цена', 'завтрак', 'персонал'] })])
		expect(s.topTopics).toHaveLength(3)
	})
})
