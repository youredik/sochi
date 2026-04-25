/**
 * `canRefundPayment` — определяет, доступен ли возврат для платежа.
 * Используется и в FolioPaymentsTable (per-row кнопка), и в folio route
 * (disabled check на balance card "Возврат").
 *
 * Per memory `project_payment_domain_canonical.md` invariant #1:
 *   - `succeeded`: full or partial refund разрешён до cap = capturedMinor
 *   - `partially_refunded`: дальнейший partial refund до cap
 *   - все остальные статусы: refund невозможен
 *
 * Логика повторяется на сервере (refund.service.ts → assertWithinCap), UI —
 * лишь fast-fail чтобы не показывать кнопку, дёргать API всё равно invariant
 * проверит.
 */
import type { Payment } from '@horeca/shared'

export function canRefundPayment(p: Payment): boolean {
	return p.status === 'succeeded' || p.status === 'partially_refunded'
}
