/**
 * `<PaymentMethodSelector>` — canonical payment method selector для widget Screen 3.
 *
 * Per `plans/m9_widget_4_canonical.md` §3 + behaviour-faithful Mock canon:
 *   - Payment method choice = canonical interface (works для Stub demo + future
 *     live ЮKassa). Same UI, same wire shape.
 *   - We do NOT collect card details на фронте (PCI SAQ-D scope avoidance).
 *     Stub provider returns synchronous `succeeded`. Live ЮKassa Widget v1
 *     opens iframe overlay для card capture (Track C2).
 *
 * Methods exposed: `card` (банковская карта), `sbp` (СБП). Restricted к
 * `widgetPaymentMethodSchema` enum. Mir Pay / Sber Pay / T-Pay / YooMoney —
 * Track C2 enhancement after empirical sandbox verification.
 *
 * Default selection: `card` (most common Сочи SMB payment method per 2026
 * research). Toggling между options resets any provider-specific state в screen.
 */

import type { WidgetPaymentMethod } from '@horeca/shared'
import { CreditCard, Smartphone } from 'lucide-react'
import { useId } from 'react'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'

export interface PaymentMethodSelectorProps {
	readonly value: WidgetPaymentMethod
	readonly onChange: (next: WidgetPaymentMethod) => void
	readonly disabled?: boolean
}

export function PaymentMethodSelector({
	value,
	onChange,
	disabled = false,
}: PaymentMethodSelectorProps) {
	const cardId = useId()
	const sbpId = useId()
	return (
		<fieldset
			className="space-y-3 rounded-lg border bg-card p-4 sm:p-5"
			data-testid="payment-method-selector"
			disabled={disabled}
		>
			<legend className="px-1 text-sm font-medium text-foreground">Способ оплаты</legend>

			<RadioGroup
				value={value}
				onValueChange={(next) => onChange(next as WidgetPaymentMethod)}
				className="space-y-2"
				aria-label="Способ оплаты"
			>
				<MethodOption
					id={cardId}
					value="card"
					label="Банковская карта"
					meta="Мир, Visa, Mastercard. Платёж принимает оператор платёжной системы по защищённому каналу."
					icon={<CreditCard className="size-5 text-muted-foreground" aria-hidden />}
				/>
				<MethodOption
					id={sbpId}
					value="sbp"
					label="СБП — Система быстрых платежей"
					meta="Оплата через банковское приложение по QR или ссылке. Перевод поступит мгновенно."
					icon={<Smartphone className="size-5 text-muted-foreground" aria-hidden />}
				/>
			</RadioGroup>
		</fieldset>
	)
}

function MethodOption({
	id,
	value,
	label,
	meta,
	icon,
}: {
	id: string
	value: WidgetPaymentMethod
	label: string
	meta: string
	icon: React.ReactNode
}) {
	return (
		<div
			className="flex items-start gap-3 rounded-md border bg-background p-3 transition has-[:checked]:border-primary has-[:checked]:bg-primary/5"
			data-testid={`pm-${value}`}
		>
			<RadioGroupItem id={id} value={value} className="mt-1" />
			<div className="flex flex-1 items-start gap-3">
				{icon}
				<div className="flex-1 space-y-0.5">
					<Label htmlFor={id} className="cursor-pointer text-sm font-medium">
						{label}
					</Label>
					<p className="text-xs text-muted-foreground">{meta}</p>
				</div>
			</div>
		</div>
	)
}
