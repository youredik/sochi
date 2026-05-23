/**
 * РКЛ (Реестр Контролируемых Лиц) check для passport scan flow.
 *
 * Sprint B 2026-05-22 — закрывает gap C2 из round 3 review: после Vision
 * scan для не-РФ citizen нужна проверка МВД РКЛ. Без неё — operator
 * заселит иностранца из реестра → ст.18.9 КоАП до 500к ₽.
 *
 * Reuses existing `RklCheckAdapter` из `domains/epgu/rkl/types.ts` —
 * не дублируем interface. Mock adapter (`createMockRklCheck`) даёт
 * behaviour-faithful response в Phase 1; production swap = factory binding.
 *
 * RU citizens НЕ subject to РКЛ — это registry of foreign controlled persons
 * only per МВД RKL spec. Skip check для passport_paper или citizenshipIso3='rus'.
 *
 * GRACEFUL FAILURE: РКЛ check НЕ должен ронять весь scan flow. Если adapter
 * throws (network / Контур API down) — возвращаем 'check_failed' status,
 * operator увидит warning badge и решит manually. Scan response остаётся 200.
 */

import type { IdentityMethod } from '@horeca/shared'
import type { RklCheckAdapter, RklCheckRequest } from '../../rkl/types.ts'
import type { PassportEntities } from '../../vision/types.ts'

/** Extended status (наш scan-flow специфичный) — superset РКЛ adapter outcome. */
export type RklStatusForScan =
	| 'clean' // adapter подтвердил clean (или whitelist)
	| 'match' // adapter нашёл match — операторской attention требуется
	| 'inconclusive' // adapter не определился
	| 'check_failed' // adapter throw'нул / network error / insufficient data
	| 'skipped_ru' // RU citizen — РКЛ не applicable

export interface EvaluateRklInput {
	readonly detectedCountryIso3: string | null
	readonly entities: PassportEntities
	readonly identityMethod: IdentityMethod
}

export interface EvaluateRklResult {
	readonly status: RklStatusForScan
	readonly matchType: 'exact' | 'partial' | null
	/** RKL registry version если adapter call был сделан. */
	readonly registryRevision: string | null
	readonly latencyMs: number
}

/**
 * Skip-or-call decision + graceful failure. Returns в одной shape для UI.
 */
export async function evaluateRklForScan(
	rkl: RklCheckAdapter,
	input: EvaluateRklInput,
): Promise<EvaluateRklResult> {
	// RU citizens — РКЛ не applicable (registry foreign-only). Skip.
	if (
		input.identityMethod === 'passport_paper' ||
		input.entities.citizenshipIso3 === 'rus' ||
		input.detectedCountryIso3 === 'rus'
	) {
		return {
			status: 'skipped_ru',
			matchType: null,
			registryRevision: null,
			latencyMs: 0,
		}
	}

	// Insufficient data — нельзя проверить без documentNumber + birthDate.
	if (input.entities.documentNumber === null || input.entities.birthDate === null) {
		return {
			status: 'check_failed',
			matchType: null,
			registryRevision: null,
			latencyMs: 0,
		}
	}

	// Map identityMethod к RklCheckRequest documentType.
	const documentType: RklCheckRequest['documentType'] =
		input.identityMethod === 'passport_zagran'
			? 'passport_zagran'
			: input.identityMethod === 'driver_license'
				? 'driver_license'
				: 'foreign_passport'

	try {
		const result = await rkl.check({
			documentType,
			series: null, // загранпаспорт + foreign — без serial separation
			number: input.entities.documentNumber,
			birthdate: input.entities.birthDate,
		})
		return {
			status: result.status,
			matchType: result.matchType,
			registryRevision: result.registryRevision,
			latencyMs: result.latencyMs,
		}
	} catch {
		// Adapter throws — graceful degrade. НЕ throw наружу, scan flow продолжается.
		return {
			status: 'check_failed',
			matchType: null,
			registryRevision: null,
			latencyMs: 0,
		}
	}
}
