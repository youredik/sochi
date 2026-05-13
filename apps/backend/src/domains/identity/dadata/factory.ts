import type { AdapterMetadata } from '../../../lib/adapters/types.ts'
import { createMockDaData } from './mock-dadata.ts'
import { createRealDaData } from './real-dadata.ts'
import type { DaDataAdapter } from './types.ts'

export interface DaDataFactoryOptions {
	/** `DADATA_API_KEY` env value. Unset/empty → mock impl, registered as `mock`. */
	readonly apiKey?: string | undefined
	/** Override for tests; defaults to global `fetch`. */
	readonly fetchImpl?: typeof fetch
}

export interface DaDataFactoryResult {
	readonly adapter: DaDataAdapter
	readonly metadata: AdapterMetadata
}

/**
 * Pick mock vs real impl based on `DADATA_API_KEY` env presence.
 * Returns metadata alongside so `app.ts` registers a truthful row in
 * `/api/health/adapters` — mode reflects the actual binding.
 */
export function createDaDataAdapter(opts: DaDataFactoryOptions): DaDataFactoryResult {
	const key = opts.apiKey?.trim()
	if (!key) {
		return {
			adapter: createMockDaData(),
			metadata: {
				name: 'dadata.mock',
				category: 'identity-lookup',
				mode: 'mock',
				description:
					'In-process DaData stand-in для онбординга. Возвращает каноничный demo-набор организаций ' +
					'(Сочи / Сириус / Красная Поляна) per [[demo_strategy]] + [[behaviour_faithful_mock_canon]]. ' +
					'Replace с dadata.live установкой DADATA_API_KEY (free tier 10k req/day).',
			},
		}
	}
	return {
		adapter: createRealDaData({
			apiKey: key,
			...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
		}),
		metadata: {
			name: 'dadata.live',
			category: 'identity-lookup',
			mode: 'live',
			description:
				'DaData REST findById/party — auto-fill ИНН → имя/адрес/налог.режим для онбординга. ' +
				'Fail-soft: timeout/non-2xx/malformed → null + warn-log, UI fallback на ручной ввод.',
			providerVersion: 'v4.1',
		},
	}
}
