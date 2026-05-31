/**
 * ReviewCard — strict component tests (Layer 4 canon: behaviour, not snapshot).
 *
 * Hooks мокаются (мутации тестируются на service-слое) — здесь проверяем UI-
 * логику карточки: new → кнопка ИИ; drafted → textarea + публикация/сохранение
 * с trimmed-текстом; published → read-only без действий.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, type Mock, mock } from 'bun:test'
import type { ReviewDto } from '../hooks/use-reviews.ts'

const generateMutate: Mock<(v: { id: string }) => void> = mock(() => {})
const saveMutate: Mock<(v: { id: string; reply: string }) => void> = mock(() => {})
const publishMutate: Mock<(v: { id: string; reply: string }) => void> = mock(() => {})

await mock.module('../hooks/use-reviews.ts', () => ({
	useGenerateReply: () => ({ mutate: generateMutate, isPending: false }),
	useSaveDraft: () => ({ mutate: saveMutate, isPending: false }),
	usePublishReply: () => ({ mutate: publishMutate, isPending: false }),
}))

import { ReviewCard } from './review-card.tsx'

function makeReview(overrides: Partial<ReviewDto> = {}): ReviewDto {
	return {
		id: 'rev_1',
		tenantId: 'org_1',
		channelCode: 'ostrovok',
		externalId: 'ext_1',
		propertyId: 'prop_1',
		guestName: 'Мария Иванова',
		ratingOverall: 5,
		content: 'Прекрасное место, чисто и тихо.',
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

afterEach(() => {
	cleanup()
	generateMutate.mockClear()
	saveMutate.mockClear()
	publishMutate.mockClear()
})

describe('ReviewCard', () => {
	it('[C1] new review → shows guest, channel label, rating; "Подготовить ответ ИИ" present', () => {
		render(<ReviewCard review={makeReview()} propertyId="prop_1" />)
		expect(screen.getByText('Мария Иванова')).not.toBeNull()
		expect(screen.getByText('Островок')).not.toBeNull()
		expect(screen.getByLabelText('Оценка 5 из 5')).not.toBeNull()
		expect(screen.getByRole('button', { name: /Подготовить ответ ИИ/ })).not.toBeNull()
	})

	it('[C2] click "Подготовить ответ ИИ" → generate.mutate({ id })', () => {
		render(<ReviewCard review={makeReview()} propertyId="prop_1" />)
		fireEvent.click(screen.getByRole('button', { name: /Подготовить ответ ИИ/ }))
		expect(generateMutate).toHaveBeenCalledTimes(1)
		expect(generateMutate.mock.calls[0]?.[0]).toEqual({ id: 'rev_1' })
	})

	it('[C3] drafted review → textarea prefilled with suggestedReply + publish/save buttons', () => {
		render(
			<ReviewCard
				review={makeReview({
					status: 'drafted',
					aiSentiment: 'positive',
					aiTopics: ['чистота'],
					suggestedReply: 'Спасибо за тёплый отзыв!',
				})}
				propertyId="prop_1"
			/>,
		)
		const textarea = screen.getByLabelText('Ответ гостю') as HTMLTextAreaElement
		expect(textarea.value).toBe('Спасибо за тёплый отзыв!')
		expect(screen.getByRole('button', { name: /Опубликовать/ })).not.toBeNull()
		expect(screen.getByRole('button', { name: /Сохранить черновик/ })).not.toBeNull()
		// sentiment + topic badges surface
		expect(screen.getByText('Позитивный')).not.toBeNull()
		expect(screen.getByText('чистота')).not.toBeNull()
	})

	it('[C4] click "Опубликовать" → publish.mutate with trimmed reply', () => {
		render(
			<ReviewCard
				review={makeReview({ status: 'drafted', suggestedReply: 'Спасибо!' })}
				propertyId="prop_1"
			/>,
		)
		fireEvent.click(screen.getByRole('button', { name: /Опубликовать/ }))
		expect(publishMutate).toHaveBeenCalledTimes(1)
		expect(publishMutate.mock.calls[0]?.[0]).toEqual({ id: 'rev_1', reply: 'Спасибо!' })
	})

	it('[C5] published review → textarea read-only, no publish/save buttons', () => {
		render(
			<ReviewCard
				review={makeReview({
					status: 'published',
					suggestedReply: 'Спасибо!',
					hostReply: 'Благодарим за отзыв!',
					publishedAt: '2026-05-21T10:00:00.000Z',
				})}
				propertyId="prop_1"
			/>,
		)
		const textarea = screen.getByLabelText('Ответ гостю') as HTMLTextAreaElement
		expect(textarea.value).toBe('Благодарим за отзыв!')
		expect(textarea.readOnly).toBe(true)
		expect(screen.queryByRole('button', { name: /Опубликовать/ })).toBeNull()
		expect(screen.queryByRole('button', { name: /Сохранить черновик/ })).toBeNull()
	})

	it('[C6] empty-rating review renders "Без оценки" (no crash)', () => {
		render(<ReviewCard review={makeReview({ ratingOverall: null })} propertyId="prop_1" />)
		expect(screen.getByText('Без оценки')).not.toBeNull()
	})
})
