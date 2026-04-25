/**
 * `useCan(permissions)` — RBAC permission check для UI gating.
 *
 * Per memory `project_m6_7_frontend_research.md` round-6 (Apaleo + Cloudbeds +
 * Mews + 54-ФЗ canon):
 *   - Single source of truth: portable `hasPermission` из @horeca/shared/rbac
 *   - Same matrix client + server (no drift surface)
 *   - **UI gating != security**. Server gate в requirePermission middleware
 *     — load-bearing. Этот hook только UI hint для UX.
 *   - Returns `false` пока role не загружена (deny-by-default)
 *
 * Pairs с `<RbacButton>` для aria-disabled + tooltip pattern (NOT just
 * `disabled` — WCAG hostility per Smashing 2021/22 + CSS-Tricks canon).
 */
import { hasPermission, type MemberRole } from '@horeca/shared'
import { queryOptions, useQuery } from '@tanstack/react-query'
import { api } from './api.ts'

export const meQueryOptions = queryOptions({
	queryKey: ['me'] as const,
	queryFn: async () => {
		const res = await api.api.v1.me.$get()
		if (!res.ok) throw new Error(`me HTTP ${res.status}`)
		const body = (await res.json()) as {
			data: { userId: string; tenantId: string; role: MemberRole }
		}
		return body.data
	},
	staleTime: 30_000,
	refetchOnWindowFocus: true,
})

export function useCurrentRole(): MemberRole | undefined {
	const { data } = useQuery(meQueryOptions)
	return data?.role
}

/**
 * `useCan(permissions)` — boolean check whether current user satisfies all
 * requested permissions. Returns `false` while role loading (deny-by-default).
 *
 * Usage:
 *   const canRefund = useCan({ refund: ['create'] })
 *   <RbacButton can={canRefund} reason="Возврат: требуется роль Менеджер">…</RbacButton>
 */
export function useCan(permissions: Record<string, readonly string[]>): boolean {
	const role = useCurrentRole()
	if (!role) return false
	return hasPermission(role, permissions)
}
