/**
 * ReviewsPage — strict component tests covering every render state the e2e
 * happy-path doesn't: no-property onboarding, loading skeleton, error panel,
 * empty inbox, populated (summary + cards), multi-property selector.
 *
 * `useReviews` is mocked so each query state is driven deterministically; the
 * ReviewCard mutation hooks are stubbed (their behaviour is covered in
 * review-card.test.tsx + review.service.test.ts).
 */
import type { Property } from '@horeca/shared'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { ReviewDto } from '../hooks/use-reviews.ts'

type QueryState = {
	isPending: boolean
	isError: boolean
	error?: unknown
	data?: ReviewDto[]
}

let queryState: QueryState = { isPending: false, isError: false, data: [] }
const noopMutation = { mutate: () => {}, isPending: false }

await mock.module('../hooks/use-reviews.ts', () => ({
	useReviews: () => queryState,
	useGenerateReply: () => noopMutation,
	useSaveDraft: () => noopMutation,
	usePublishReply: () => noopMutation,
}))

import { ReviewsPage } from './reviews-page.tsx'

function prop(id: string, name: string): Property {
	return { id, name } as Property
}

function makeReview(overrides: Partial<ReviewDto> = {}): ReviewDto {
	return {
		id: 'rev_1',
		tenantId: 'org_1',
		channelCode: 'ostrovok',
		externalId: 'ext_1',
		propertyId: 'prop_1',
		guestName: 'Мария Иванова',
		ratingOverall: 5,
		content: 'Отличное место.',
		aiSentiment: null,
		aiTopics: null,
		suggestedReply: null,
		hostReply: null,
		status: 'new',
		reviewedAt: '2026-05-20T10:00:00.000Z',
		aiGeneratedAt: null,
		publishedAt: null,
		createdAt: '2026-05-20T10:00:00.000Z',
		updatedAt: '2026-05-20T10:00:00.000Z',
		...overrides,
	} as ReviewDto
}

beforeEach(() => {
	queryState = { isPending: false, isError: false, data: [] }
})
afterEach(() => cleanup())

describe('ReviewsPage', () => {
	it('[RP1] no properties → onboarding hint (no reviews query)', () => {
		render(<ReviewsPage properties={[]} />)
		expect(screen.getByText(/Сначала добавьте объект/)).not.toBeNull()
	})

	it('[RP2] loading → busy skeleton region', () => {
		queryState = { isPending: true, isError: false }
		render(<ReviewsPage properties={[prop('prop_1', 'Отель А')]} />)
		expect(screen.getByRole('status', { name: 'Загрузка отзывов' })).not.toBeNull()
	})

	it('[RP3] error → operator-friendly message (never raw)', () => {
		queryState = { isPending: false, isError: true, error: { code: 'WEIRD', message: 'raw' } }
		render(<ReviewsPage properties={[prop('prop_1', 'Отель А')]} />)
		expect(screen.getByText(/Не удалось загрузить отзывы/)).not.toBeNull()
		expect(screen.queryByText('raw')).toBeNull()
	})

	it('[RP4] empty inbox → "Отзывов пока нет"', () => {
		queryState = { isPending: false, isError: false, data: [] }
		render(<ReviewsPage properties={[prop('prop_1', 'Отель А')]} />)
		expect(screen.getByText(/Отзывов пока нет/)).not.toBeNull()
	})

	it('[RP5] populated → summary card + review card render', () => {
		queryState = { isPending: false, isError: false, data: [makeReview()] }
		render(<ReviewsPage properties={[prop('prop_1', 'Отель А')]} />)
		expect(screen.getByText('Сводка по отзывам')).not.toBeNull()
		expect(screen.getByText('Мария Иванова')).not.toBeNull()
	})

	it('[RP6] multiple properties → property selector shown', () => {
		queryState = { isPending: false, isError: false, data: [] }
		render(<ReviewsPage properties={[prop('prop_1', 'Отель А'), prop('prop_2', 'Отель Б')]} />)
		expect(screen.getByLabelText('Выбор объекта')).not.toBeNull()
	})

	it('[RP7] single property → no selector', () => {
		queryState = { isPending: false, isError: false, data: [] }
		render(<ReviewsPage properties={[prop('prop_1', 'Отель А')]} />)
		expect(screen.queryByLabelText('Выбор объекта')).toBeNull()
	})
})
