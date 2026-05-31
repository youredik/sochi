/**
 * Reviews queries + mutations — TanStack Query 5 + typed hono RPC client.
 *
 * Тип `ReviewDto` выводится из контракта бэкенда (`InferResponseType`) — никакого
 * ручного дублирования DTO, ноль drift. Мутации патчат кэш списка возвращённым
 * authoritative-объектом (snappy UX без рефетча). Ошибки → `userMessageFor`
 * (оператор НИКОГДА не видит сырой message — канон user-message слоя).
 *
 *   list      GET  /properties/:propertyId/reviews
 *   generate  POST /reviews/:id/generate-reply   (YandexGPT-черновик)
 *   saveDraft PUT  /reviews/:id/reply
 *   publish   POST /reviews/:id/publish
 */

import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { InferResponseType } from 'hono/client'
import { toast } from 'sonner'
import { api } from '../../../lib/api.ts'
import { type ApiError, errorFromResponse } from '../../../lib/api-errors.ts'
import { logger } from '../../../lib/logger.ts'
import { userMessageFor } from '../../../lib/user-message.ts'

type ReviewOneOk = InferResponseType<(typeof api.api.v1.reviews)[':id']['$get'], 200>
/** Канонический wire-тип отзыва — единственный источник правды = backend route. */
export type ReviewDto = ReviewOneOk['data']

export const reviewsQueryKey = (propertyId: string) => ['reviews', { propertyId }] as const

export const reviewsQueryOptions = (propertyId: string) =>
	queryOptions({
		queryKey: reviewsQueryKey(propertyId),
		queryFn: async (): Promise<ReviewDto[]> => {
			const res = await api.api.v1.properties[':propertyId'].reviews.$get({ param: { propertyId } })
			if (!res.ok) throw await errorFromResponse(res)
			const body = (await res.json()) as { data: ReviewDto[] }
			return body.data
		},
		staleTime: 30_000,
	})

export function useReviews(propertyId: string) {
	return useQuery(reviewsQueryOptions(propertyId))
}

/**
 * Идемпотентный демо-провизионинг отзывов (POST — write-семантика, в отличие от
 * сидинга в GET). Сервер сам гейтит на demo-режим (для prod/уже-засеяно → no-op).
 * Зовётся reviews route loader, чтобы демо-визитёр увидел набор под своей property.
 */
export async function provisionDemoReviews(propertyId: string): Promise<void> {
	const res = await api.api.v1.properties[':propertyId'].reviews['provision-demo'].$post({
		param: { propertyId },
	})
	if (!res.ok) throw await errorFromResponse(res)
}

/** Заменить один отзыв в кэше списка возвращённым из мутации объектом. */
function usePatchReviewInList(propertyId: string) {
	const queryClient = useQueryClient()
	return (updated: ReviewDto) => {
		queryClient.setQueryData<ReviewDto[]>(reviewsQueryKey(propertyId), (prev) =>
			prev ? prev.map((r) => (r.id === updated.id ? updated : r)) : prev,
		)
	}
}

/** ИИ-черновик ответа (YandexGPT). */
export function useGenerateReply(propertyId: string) {
	const patch = usePatchReviewInList(propertyId)
	return useMutation({
		mutationFn: async (vars: { id: string }): Promise<ReviewDto> => {
			const res = await api.api.v1.reviews[':id']['generate-reply'].$post({
				param: { id: vars.id },
			})
			if (!res.ok) throw await errorFromResponse(res)
			const body = (await res.json()) as { data: ReviewDto }
			return body.data
		},
		onSuccess: (data) => {
			patch(data)
			toast.success('ИИ подготовил черновик ответа')
		},
		onError: (err: ApiError) => {
			logger.warn('review.generateReply failed', { code: err.code, message: err.message })
			toast.error(userMessageFor(err, 'Не удалось подготовить ответ'))
		},
	})
}

/** Сохранить правки хозяина без публикации. */
export function useSaveDraft(propertyId: string) {
	const patch = usePatchReviewInList(propertyId)
	return useMutation({
		mutationFn: async (vars: { id: string; reply: string }): Promise<ReviewDto> => {
			const res = await api.api.v1.reviews[':id'].reply.$put({
				param: { id: vars.id },
				json: { reply: vars.reply },
			})
			if (!res.ok) throw await errorFromResponse(res)
			const body = (await res.json()) as { data: ReviewDto }
			return body.data
		},
		onSuccess: (data) => {
			patch(data)
			toast.success('Черновик сохранён')
		},
		onError: (err: ApiError) => {
			logger.warn('review.saveDraft failed', { code: err.code, message: err.message })
			toast.error(userMessageFor(err, 'Не удалось сохранить черновик'))
		},
	})
}

/** Опубликовать ответ обратно в канал. */
export function usePublishReply(propertyId: string) {
	const patch = usePatchReviewInList(propertyId)
	return useMutation({
		mutationFn: async (vars: { id: string; reply: string }): Promise<ReviewDto> => {
			const res = await api.api.v1.reviews[':id'].publish.$post({
				param: { id: vars.id },
				json: { reply: vars.reply },
			})
			if (!res.ok) throw await errorFromResponse(res)
			const body = (await res.json()) as { data: ReviewDto }
			return body.data
		},
		onSuccess: (data) => {
			patch(data)
			toast.success('Ответ опубликован')
		},
		onError: (err: ApiError) => {
			logger.warn('review.publish failed', { code: err.code, message: err.message })
			toast.error(userMessageFor(err, 'Не удалось опубликовать ответ'))
		},
	})
}
