import type { TenantCompliance, TenantCompliancePatch } from '@horeca/shared'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../../../lib/api.ts'
import { type ApiError, errorFromResponse } from '../../../lib/api-errors.ts'
import { logger } from '../../../lib/logger.ts'

/**
 * Wire shape — backend serializes `annualRevenueEstimateMicroRub` as a
 * string (BigInt-over-JSON). Hook unwraps to bigint via `BigInt(...)` so
 * domain code can math on it; submit re-serializes through
 * `int64WireSchema` on the server.
 */
type ComplianceWire = Omit<TenantCompliance, 'annualRevenueEstimateMicroRub'> & {
	annualRevenueEstimateMicroRub: string | null
}

function fromWire(c: ComplianceWire): TenantCompliance {
	return {
		...c,
		annualRevenueEstimateMicroRub:
			c.annualRevenueEstimateMicroRub === null ? null : BigInt(c.annualRevenueEstimateMicroRub),
	}
}

export const complianceQueryOptions = queryOptions({
	queryKey: ['me', 'compliance'] as const,
	queryFn: async (): Promise<TenantCompliance> => {
		const res = await api.api.v1.me.compliance.$get()
		if (!res.ok) {
			// 404 on first onboarding before any compliance row exists is
			// expected — surface as `null`-shape via repo error code instead
			// of throwing, so the form can render empty defaults.
			throw await errorFromResponse(res)
		}
		const body = (await res.json()) as { data: ComplianceWire }
		return fromWire(body.data)
	},
	staleTime: 30_000,
})

export function useCompliance() {
	return useQuery(complianceQueryOptions)
}

/**
 * Patch wire — bigint → string before send. Backend's `int64WireSchema`
 * accepts both, but we keep the wire JSON-clean and BigInt-safe at all
 * boundaries (no JSON.stringify(bigint) crashes from client logging).
 */
type CompliancePatchWire = Omit<TenantCompliancePatch, 'annualRevenueEstimateMicroRub'> & {
	annualRevenueEstimateMicroRub?: string | null
}

function patchToWire(p: TenantCompliancePatch): CompliancePatchWire {
	const { annualRevenueEstimateMicroRub, ...rest } = p
	if (annualRevenueEstimateMicroRub === undefined) return rest
	return {
		...rest,
		annualRevenueEstimateMicroRub:
			annualRevenueEstimateMicroRub === null ? null : annualRevenueEstimateMicroRub.toString(),
	}
}

export function usePatchCompliance() {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: async (
			input: TenantCompliancePatch,
		): Promise<{ data: TenantCompliance; warnings: string[] }> => {
			const res = await api.api.v1.me.compliance.$patch({
				// Backend's `int64WireSchema` accepts string|bigint and coerces.
				// hc client types reflect the bigint side; we send string.
				json: patchToWire(input) as unknown as TenantCompliancePatch,
			})
			if (!res.ok) throw await errorFromResponse(res)
			const body = (await res.json()) as { data: ComplianceWire; warnings: string[] }
			return { data: fromWire(body.data), warnings: body.warnings }
		},
		onSuccess: async ({ warnings }) => {
			await queryClient.invalidateQueries({ queryKey: complianceQueryOptions.queryKey })
			if (warnings.length === 0) {
				toast.success('Сохранено')
			} else {
				// Display the first warning prominently; others available in form.
				toast.warning(warnings[0] ?? 'Сохранено с предупреждениями')
			}
		},
		onError: (err: ApiError) => {
			logger.warn('compliance.patch failed', { code: err.code, message: err.message })
			toast.error(err.message)
		},
	})
}
