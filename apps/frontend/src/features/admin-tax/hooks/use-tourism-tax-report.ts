/**
 * Org-level tourism-tax report query — calls `GET /api/admin/tax/tourism/report`.
 *
 * **Stale strategy:**
 *   - `staleTime: 30_000` — отчёт по закрытому периоду статичен; для текущего
 *     квартала балансы могут двигаться, но 30 секунд достаточно для UX
 *     (бухгалтер не делает 100 запросов/мин). Refetch on focus = свежие данные
 *     при возврате в таб.
 *
 * Filter state (`from`/`to`/`propertyId?`) приходит из URL search params,
 * чтобы отчёт был shareable + back-button-навигацией дружелюбен.
 */
import type { TourismTaxOrgReport, TourismTaxOrgReportParams } from '@horeca/shared'
import { queryOptions } from '@tanstack/react-query'
import { api } from '../../../lib/api.ts'

export const tourismTaxOrgReportQueryOptions = (params: TourismTaxOrgReportParams) =>
	queryOptions({
		queryKey: ['admin', 'tax', 'tourism', 'report', params] as const,
		queryFn: async (): Promise<TourismTaxOrgReport> => {
			const res = await api.api.admin.tax.tourism.report.$get({
				query: {
					from: params.from,
					to: params.to,
					...(params.propertyId ? { propertyId: params.propertyId } : {}),
				},
			})
			// Hono RPC infers `res.status` as the success literal (200) — for
			// non-OK paths cast to plain Response semantics.
			if (!res.ok) {
				const status = (res as Response).status
				if (status === 403) throw new Error('Недостаточно прав для просмотра отчёта')
				throw new Error(`tourism-tax report HTTP ${status}`)
			}
			const body = (await res.json()) as { data: TourismTaxOrgReport }
			return body.data
		},
		staleTime: 30_000,
		refetchOnWindowFocus: true,
	})

/**
 * Build the absolute URL для XLSX export endpoint with current filters.
 * Used as `<a href={url} download>` — простейший workflow: browser GET с
 * cookie (credentials: 'include' через Hono client не работает для plain
 * `<a>`, но cookie SameSite=lax по дефолту отправляется с top-level
 * navigation, поэтому работает «as is»).
 */
export function buildTourismTaxXlsxUrl(params: TourismTaxOrgReportParams): string {
	const base = import.meta.env.VITE_API_URL ?? 'http://localhost:3001'
	const qs = new URLSearchParams({ from: params.from, to: params.to })
	if (params.propertyId) qs.set('propertyId', params.propertyId)
	return `${base}/api/admin/tax/tourism/export.xlsx?${qs.toString()}`
}
