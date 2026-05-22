import type { AdapterMetadata } from '../../../lib/adapters/types.ts'
import { createMockDaData } from './mock-dadata.ts'
import { createRealDaData } from './real-dadata.ts'
import type { DaDataAdapter } from './types.ts'

export interface DaDataFactoryOptions {
	/** `DADATA_API_KEY` env value. Unset/empty → mock-only impl. */
	readonly apiKey?: string | undefined
	/** Override for tests; defaults to global `fetch`. */
	readonly fetchImpl?: typeof fetch
}

export interface DaDataFactoryResult {
	readonly adapter: DaDataAdapter
	readonly metadata: AdapterMetadata
}

/**
 * Pick adapter based on `DADATA_API_KEY` env presence:
 *
 *   - no key  → mock-only (canonical Сочи demo set).
 *   - has key → **hybrid**: mock-first, live fallback. Demo ИНН с префиксом
 *               `2320` (deliberately fictitious — see `mock-dadata.ts` header)
 *               resolve from in-process mock; everything else flows to live
 *               `suggestions.dadata.ru`. Без hybrid live API возвращает null
 *               на demo fixtures и ломает canonical demo prospect experience
 *               (`onboarding-90s.spec.ts` использует `2320000001`).
 *
 * Pattern mirror: email factory `DemoInboxAdapter` wraps Postbox downstream
 * — same «mock capture + live forward» canon per [[behaviour_faithful_mock_canon]].
 *
 * Metadata reflects actual binding so `/api/health/adapters` is truthful.
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
					'Replace с dadata.hybrid установкой DADATA_API_KEY (free tier 10k req/day).',
			},
		}
	}
	const mock = createMockDaData()
	const live = createRealDaData({
		apiKey: key,
		...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
	})
	const hybrid: DaDataAdapter = {
		async findByInn(inn) {
			const demoHit = await mock.findByInn(inn)
			if (demoHit !== null) return demoHit
			return live.findByInn(inn)
		},
	}
	return {
		adapter: hybrid,
		metadata: {
			name: 'dadata.hybrid',
			category: 'identity-lookup',
			mode: 'live',
			description:
				'Hybrid: in-process mock-first для каноничных demo ИНН (префикс 2320, deliberately fictitious) + ' +
				'DaData REST findById/party fallback для реальных ЕГРЮЛ/ЕГРИП lookup. ' +
				'Fail-soft: timeout/non-2xx/malformed live → null + warn-log, UI fallback на ручной ввод.',
			providerVersion: 'v4.1',
		},
	}
}
