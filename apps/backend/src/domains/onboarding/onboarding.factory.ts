import type { sql as SQL } from '../../db/index.ts'
import { createOnboardingService } from './onboarding.service.ts'

/**
 * Onboarding domain wiring. The service is repo-less — it writes property /
 * roomType / room / ratePlan rows directly inside a single
 * `sql.begin({idempotent: true})` block since repos aren't tx-aware (they
 * capture their own sql binding at construction time). All four entity
 * shapes are identical to what the existing per-domain repos write, so
 * Шахматка / property routes / room CRUD all read the new rows without
 * any further change.
 */
export function createOnboardingFactory(sql: typeof SQL) {
	const service = createOnboardingService(sql)
	return { service }
}

export type OnboardingFactory = ReturnType<typeof createOnboardingFactory>
