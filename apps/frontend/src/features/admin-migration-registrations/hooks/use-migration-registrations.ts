/**
 * Migration registrations admin queries + mutations.
 *
 * Per `project_m6_7_frontend_research.md` (TanStack Query 5.100):
 *   - useSuspenseQuery for required list (route loader prefetches)
 *   - useMutation для cancel + patch (operatorNote)
 *   - onSuccess invalidates ['admin', 'migration-registrations'] → list refresh
 *   - staleTime 0 + refetchOnWindowFocus — operator UI must be live
 *
 * Per `project_m8_a_6_ui_canonical.md` (M8.A.6 UI 2026 research):
 *   - URL-search drill-down via ?id=mreg_xxx → detail Sheet
 *   - Cancel требует reason (5..500 chars) — Zod-validated server-side
 *   - Patch operatorNote three-state (string|null|undefined → no change)
 */
import type { MigrationRegistration, MigrationRegistrationPatch } from '@horeca/shared'
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api.ts'

const LIST_KEY = ['admin', 'migration-registrations'] as const

export const migrationRegistrationsListQueryOptions = (limit = 100) =>
	queryOptions({
		queryKey: [...LIST_KEY, 'list', { limit }] as const,
		queryFn: async (): Promise<MigrationRegistration[]> => {
			const res = await api.api.v1['migration-registrations'].$get({
				query: { limit: String(limit) },
			})
			if (!res.ok) {
				const status = (res as Response).status
				if (status === 403) throw new Error('Недостаточно прав для просмотра миграционного учёта')
				throw new Error(`migration-registrations.list HTTP ${status}`)
			}
			const body = (await res.json()) as { data: MigrationRegistration[] }
			return body.data
		},
		staleTime: 0,
		refetchOnWindowFocus: true,
	})

export const migrationRegistrationDetailQueryOptions = (id: string) =>
	queryOptions({
		queryKey: [...LIST_KEY, 'detail', id] as const,
		queryFn: async (): Promise<MigrationRegistration> => {
			const res = await api.api.v1['migration-registrations'][':id'].$get({ param: { id } })
			if (!res.ok) {
				const status = (res as Response).status
				if (status === 404) throw new Error('Регистрация не найдена')
				if (status === 403) throw new Error('Недостаточно прав')
				throw new Error(`migration-registrations.detail HTTP ${status}`)
			}
			const body = (await res.json()) as { data: MigrationRegistration }
			return body.data
		},
		staleTime: 0,
		refetchOnWindowFocus: true,
	})

export function useCancelMigrationRegistration() {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
			const res = await api.api.v1['migration-registrations'][':id'].cancel.$post({
				param: { id },
				json: { reason },
			})
			if (!res.ok) {
				const status = (res as Response).status
				const body = (await res.json().catch(() => ({}))) as {
					error?: { code?: string; message?: string }
				}
				const msg = body.error?.message ?? `Отмена не удалась (HTTP ${status})`
				if (status === 409) throw new Error(`Конфликт состояния: ${msg}`)
				if (status === 403) throw new Error('Недостаточно прав для отмены')
				if (status === 404) throw new Error('Регистрация не найдена')
				throw new Error(msg)
			}
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: LIST_KEY })
		},
	})
}

export function usePatchMigrationRegistration() {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: async ({ id, patch }: { id: string; patch: MigrationRegistrationPatch }) => {
			const res = await api.api.v1['migration-registrations'][':id'].$patch({
				param: { id },
				json: patch,
			})
			if (!res.ok) {
				const status = (res as Response).status
				if (status === 400) throw new Error('Некорректный patch (Zod boundary)')
				if (status === 403) throw new Error('Недостаточно прав')
				if (status === 404) throw new Error('Регистрация не найдена')
				throw new Error(`migration-registrations.patch HTTP ${status}`)
			}
		},
		onSuccess: (_data, variables) => {
			void queryClient.invalidateQueries({ queryKey: LIST_KEY })
			void queryClient.invalidateQueries({
				queryKey: [...LIST_KEY, 'detail', variables.id],
			})
		},
	})
}
