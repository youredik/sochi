/**
 * Migration registration factory — wires repo + transport + rkl + service
 * into a single bag для использования в routes / CDC consumers / cron.
 *
 * Mock vs Live binding determined by adapter registry (M8.0 prep).
 * Service implements business logic; factory implements DI.
 */

import type { RklCheckAdapter } from '../rkl/types.ts'
import type { EpguTransport } from '../transport/types.ts'
import { createMigrationRegistrationRepo } from './registration.repo.ts'
import { createRegistrationService, type RegistrationIdGen } from './registration.service.ts'

export interface MigrationRegistrationFactoryDeps {
	readonly sql: Parameters<typeof createMigrationRegistrationRepo>[0]
	readonly transport: EpguTransport
	readonly rkl: RklCheckAdapter
	readonly idGen: RegistrationIdGen
}

export function createMigrationRegistrationFactory(deps: MigrationRegistrationFactoryDeps) {
	const repo = createMigrationRegistrationRepo(deps.sql)
	const service = createRegistrationService(
		{
			repo,
			transport: deps.transport,
			rkl: deps.rkl,
		},
		deps.idGen,
	)
	return { repo, service }
}

export type MigrationRegistrationFactory = ReturnType<typeof createMigrationRegistrationFactory>
