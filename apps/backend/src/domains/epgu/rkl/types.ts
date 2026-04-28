/**
 * RKL (Реестр Контролируемых Лиц) check adapter — channel-agnostic.
 *
 * Real impl: Контур.ФМС API (research/epgu-rkl.md §6.1).
 * Mock impl: M8.A.4 — 99/0.5/0.5 distribution + 50-300ms latency.
 *
 * Same interface for swap: factory binding в adapter registry.
 */

export interface RklCheckRequest {
	readonly documentType: 'passport_ru' | 'passport_zagran' | 'driver_license' | 'foreign_passport'
	readonly series: string | null // nullable для passport_zagran (нет series)
	readonly number: string
	readonly birthdate: string // YYYY-MM-DD
}

export interface RklCheckResponse {
	readonly status: 'clean' | 'match' | 'inconclusive'
	/** 'exact' | 'partial' — null when status='clean'. */
	readonly matchType: 'exact' | 'partial' | null
	/** Daily registry version from МВД (e.g. '2026-04-28.043'). */
	readonly registryRevision: string
	/** Check call latency, ms. */
	readonly latencyMs: number
	/** Полный raw response для audit. */
	readonly rawResponseJson: Record<string, unknown>
}

export interface RklCheckAdapter {
	readonly source: string // 'kontur_fms' | 'mock_rkl' | direct МВД когда соглашение будет
	check(req: RklCheckRequest): Promise<RklCheckResponse>
}
