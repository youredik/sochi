import type { PaymentProvider } from '@horeca/shared'
import type { sql as SQL } from '../../db/index.ts'
import type { PaymentRepo } from '../payment/payment.repo.ts'
import { createRefundRepo } from './refund.repo.ts'
import { createRefundService } from './refund.service.ts'

type SqlInstance = typeof SQL

export function createRefundFactory(
	sql: SqlInstance,
	paymentRepo: PaymentRepo,
	provider: PaymentProvider,
) {
	const repo = createRefundRepo(sql)
	const service = createRefundService(repo, paymentRepo, provider)
	return { repo, service }
}

export type RefundFactory = ReturnType<typeof createRefundFactory>
