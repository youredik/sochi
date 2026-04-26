/**
 * Notifications admin queries + retry mutation.
 *
 * Per memory `project_m6_7_frontend_research.md` (TanStack Query 5.100):
 *   - `useSuspenseQuery` for required data (route loader prefetches).
 *   - `useMutation` для retry, with `onSuccess: invalidate(['admin','notifications'])`
 *     so list refreshes after the operator action.
 *   - `staleTime: 0` + `refetchOnWindowFocus` для list — outbox state moves
 *     fast (dispatcher polls 10s).
 */
import type {
	NotificationDetail,
	NotificationListPage,
	NotificationListParams,
} from '@horeca/shared'
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api.ts'

export const notificationsListQueryOptions = (params: NotificationListParams) =>
	queryOptions({
		queryKey: ['admin', 'notifications', 'list', params] as const,
		queryFn: async (): Promise<NotificationListPage> => {
			const query: Record<string, string> = { limit: String(params.limit) }
			if (params.status) query.status = params.status
			if (params.kind) query.kind = params.kind
			if (params.recipient) query.recipient = params.recipient
			if (params.from) query.from = params.from
			if (params.to) query.to = params.to
			if (params.cursor) query.cursor = params.cursor
			const res = await api.api.admin.notifications.$get({ query })
			if (!res.ok) {
				const status = (res as Response).status
				if (status === 403) throw new Error('Недостаточно прав')
				throw new Error(`notifications.list HTTP ${status}`)
			}
			const body = (await res.json()) as { data: NotificationListPage }
			return body.data
		},
		staleTime: 0,
		refetchOnWindowFocus: true,
	})

export const notificationDetailQueryOptions = (id: string) =>
	queryOptions({
		queryKey: ['admin', 'notifications', 'detail', id] as const,
		queryFn: async (): Promise<NotificationDetail> => {
			const res = await api.api.admin.notifications[':id'].$get({ param: { id } })
			if (!res.ok) {
				const status = (res as Response).status
				if (status === 404) throw new Error('Уведомление не найдено')
				if (status === 403) throw new Error('Недостаточно прав')
				throw new Error(`notification.get HTTP ${status}`)
			}
			const body = (await res.json()) as { data: NotificationDetail }
			return body.data
		},
		staleTime: 0,
		refetchOnWindowFocus: true,
	})

export function useRetryNotification() {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: async (id: string): Promise<NotificationDetail> => {
			const res = await api.api.admin.notifications[':id'].retry.$post({
				param: { id },
			})
			if (!res.ok) {
				const status = (res as Response).status
				if (status === 409) throw new Error('Уведомление уже отправлено — повторить нельзя')
				if (status === 404) throw new Error('Уведомление не найдено')
				if (status === 403) throw new Error('Недостаточно прав на повторную отправку')
				throw new Error(`notification.retry HTTP ${status}`)
			}
			const body = (await res.json()) as { data: NotificationDetail }
			return body.data
		},
		onSuccess: (_data, id) => {
			// Invalidate list (status changed) + detail of this row.
			queryClient.invalidateQueries({ queryKey: ['admin', 'notifications', 'list'] })
			queryClient.invalidateQueries({
				queryKey: ['admin', 'notifications', 'detail', id],
			})
		},
	})
}
