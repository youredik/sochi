/**
 * `<FolioPaymentsTable>` — таблица платежей с per-row Refund триггером.
 *
 * Per canon: "Возврат" кнопка появляется только для `succeeded` или
 * `partially_refunded` payments — серверный invariant #1 (refund cap).
 *
 * Вынесен из folio route в отдельный файл per shadcn 4.5 + Fast Refresh канон.
 */
import type { Payment } from '@horeca/shared'
import { CreditCardIcon } from 'lucide-react'
import { EmptyState } from '../../../components/empty-state.tsx'
import { Money } from '../../../components/money.tsx'
import { RbacButton } from '../../../components/rbac-button.tsx'
import { Badge } from '../../../components/ui/badge.tsx'
import { formatDateShort } from '../../../lib/format-ru.ts'
import { useCan } from '../../../lib/use-can.ts'
import { canRefundPayment } from '../lib/can-refund-payment.ts'

export function FolioPaymentsTable({
	payments,
	onRefund,
}: {
	payments: Payment[]
	onRefund: (payment: Payment) => void
}) {
	// RBAC gate — staff CANNOT refund (industry canon: financial = manager+).
	// Server также блокирует requirePermission middleware'ом; этот hook — UX hint.
	const canRefund = useCan({ refund: ['create'] })
	if (payments.length === 0) {
		return (
			<EmptyState
				icon={CreditCardIcon}
				title="Платежей пока нет"
				description="Платёж появится здесь после успешного списания через ЮKassa или ручного отметки оплаты администратором."
			/>
		)
	}
	return (
		<div className="overflow-x-auto rounded-md border">
			<table className="w-full text-sm">
				<thead className="bg-muted/50">
					<tr className="text-left">
						<th className="p-2 font-medium">Дата</th>
						<th className="p-2 font-medium">Метод</th>
						<th className="p-2 font-medium">Статус</th>
						<th className="p-2 text-right font-medium">Сумма</th>
						<th className="p-2 font-medium">
							<span className="sr-only">Действие</span>
						</th>
					</tr>
				</thead>
				<tbody>
					{payments.map((p) => (
						<tr key={p.id} className="border-t">
							<td className="p-2 whitespace-nowrap">
								<time dateTime={p.createdAt}>{formatDateShort(p.createdAt)}</time>
							</td>
							<td className="p-2">{paymentMethodLabel(p.method)}</td>
							<td className="p-2">
								<PaymentStatusBadge status={p.status} />
							</td>
							<td className="p-2 text-right tabular-nums">
								<Money kopecks={BigInt(p.capturedMinor)} />
							</td>
							<td className="p-2 text-right">
								{canRefundPayment(p) ? (
									<RbacButton
										can={canRefund}
										deniedReason="Возврат: требуется роль Менеджер"
										type="button"
										variant="outline"
										size="sm"
										onClick={() => onRefund(p)}
									>
										Возврат
									</RbacButton>
								) : null}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	)
}

function paymentMethodLabel(method: string): string {
	switch (method) {
		case 'card':
			return 'Карта'
		case 'sbp':
			return 'СБП'
		case 'cash':
			return 'Наличные'
		case 'bank_transfer':
			return 'Перевод'
		case 'stub':
			return 'Демо'
		case 'digital_ruble':
			return 'Цифр. рубль'
		default:
			return method
	}
}

function PaymentStatusBadge({ status }: { status: string }) {
	// Per canon: icon + text + color (color alone = WCAG 1.4.1 fail).
	// RU labels enforce non-color signal.
	switch (status) {
		case 'created':
			return <Badge variant="outline">Создан</Badge>
		case 'pending':
			return <Badge variant="secondary">Ожидание</Badge>
		case 'waiting_for_capture':
			return <Badge variant="outline">Ожидает списания</Badge>
		case 'succeeded':
			return <Badge>Проведён</Badge>
		case 'partially_refunded':
			return <Badge variant="secondary">Возврат частичный</Badge>
		case 'refunded':
			return <Badge variant="secondary">Возвращён</Badge>
		case 'canceled':
			return <Badge variant="outline">Отменён</Badge>
		case 'failed':
			return <Badge variant="destructive">Ошибка</Badge>
		case 'expired':
			return <Badge variant="outline">Истёк</Badge>
		default:
			return <Badge variant="outline">{status}</Badge>
	}
}
