/**
 * MockRklCheckAdapter — behaviour-faithful production-grade simulator.
 *
 * Mirror of Контур.ФМС API contract per research/epgu-rkl.md §6.
 * Distribution:
 *   * 99%   clean         — proceed, can register guest
 *   * 0.5%  match         — block (требует ОВМ ручной проверки)
 *   * 0.5%  inconclusive  — warning (partial match, имя совпадает)
 * Latency 50-300 мс (Контур API typical).
 *
 * Snapshot updates: simulated through `registryRevision` daily increment
 * (date-based: '2026-04-28.NNN' where NNN cycles 0-99 per call).
 *
 * Когда swap на real Контур.ФМС:
 *   - HTTP client + auth header (PAT or OAuth client_credentials)
 *   - Map response to RklCheckResponse
 *   - Same factory binding pattern, adapter registry change
 */
import type { RklCheckAdapter, RklCheckRequest, RklCheckResponse } from './types.ts'

export interface MockRklOptions {
	readonly random?: () => number
	readonly now?: () => number
	/** Override distribution для test scenarios. Default: canonical 99/0.5/0.5. */
	readonly forceStatus?: RklCheckResponse['status']
}

export function createMockRklCheck(opts: MockRklOptions = {}): RklCheckAdapter {
	const random = opts.random ?? Math.random
	const now = opts.now ?? Date.now
	let revisionCounter = 0
	return {
		source: 'mock_rkl',
		async check(req: RklCheckRequest): Promise<RklCheckResponse> {
			const latencyMs = 50 + Math.floor(random() * 250) // 50-300ms

			let status: RklCheckResponse['status']
			let matchType: RklCheckResponse['matchType']
			if (opts.forceStatus) {
				status = opts.forceStatus
				matchType = status === 'match' ? 'exact' : status === 'inconclusive' ? 'partial' : null
			} else {
				const roll = random()
				if (roll < 0.99) {
					status = 'clean'
					matchType = null
				} else if (roll < 0.995) {
					status = 'match'
					matchType = 'exact'
				} else {
					status = 'inconclusive'
					matchType = 'partial'
				}
			}

			// registryRevision: daily snapshot id matching МВД format.
			const today = new Date(now())
			const yyyy = today.getUTCFullYear().toString().padStart(4, '0')
			const mm = (today.getUTCMonth() + 1).toString().padStart(2, '0')
			const dd = today.getUTCDate().toString().padStart(2, '0')
			revisionCounter = (revisionCounter + 1) % 1000
			const registryRevision = `${yyyy}-${mm}-${dd}.${revisionCounter.toString().padStart(3, '0')}`

			return {
				status,
				matchType,
				registryRevision,
				latencyMs,
				rawResponseJson: {
					status,
					checked_at: today.toISOString(),
					registry_revision: registryRevision,
					document_type: req.documentType,
					...(matchType ? { match_type: matchType } : {}),
				},
			}
		},
	}
}
