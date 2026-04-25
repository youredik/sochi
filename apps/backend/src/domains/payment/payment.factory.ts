import type { PaymentProvider } from '@horeca/shared'
import type { sql as SQL } from '../../db/index.ts'
import type { FolioService } from '../folio/folio.service.ts'
import { createPaymentRepo } from './payment.repo.ts'
import { createPaymentService } from './payment.service.ts'

type SqlInstance = typeof SQL

export function createPaymentFactory(
	sql: SqlInstance,
	provider: PaymentProvider,
	folioService: FolioService,
) {
	const repo = createPaymentRepo(sql)
	const service = createPaymentService(repo, provider, folioService)
	return { repo, service }
}

export type PaymentFactory = ReturnType<typeof createPaymentFactory>
