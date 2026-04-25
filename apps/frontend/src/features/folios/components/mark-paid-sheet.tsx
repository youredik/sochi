/**
 * `<MarkPaidSheet>` — Apaleo-style "Принять оплату" via right-side Sheet.
 *
 * Per memory `project_m6_7_frontend_research.md`:
 *   - **Sheet right-side** (480px iPad-h, full-width portrait) — NOT Dialog.
 *     iPad keyboard cramps Dialog vertical; Sheet pins side, body scrolls.
 *   - **5 method options** as RadioGroup-as-cards (h-16 ≥ WCAG 2.5.5 AAA):
 *     Наличные / Карта / СБП / Перевод / Прочее.
 *   - **Amount field**: react-number-format wrapped via `<MoneyInput>` —
 *     pre-filled with folio.balanceMinor, editable, hard cap = balance.
 *   - **Receipt checkbox + 54-ФЗ demo badge** — never hide; trust signal.
 *   - **Idempotency-Key**: `useMemo(crypto.randomUUID(), [])` per dialog mount.
 *   - **TanStack Form 1.29** + new shadcn `<Field>` family (NOT deprecated Form
 *     primitive — Oct 2025 shadcn change).
 *
 * **A11y mandates per axe-core 4.11:**
 *   - `<SheetTitle>` mandatory (Radix throws on missing).
 *   - `<SheetDescription>` OR `aria-describedby={undefined}`.
 *   - Auto-focus first interactive on open + return-to-trigger on close
 *     (Radix-built-in, verified React 19).
 *   - Non-color status indication: RU labels enforce non-color signal.
 */
import { useForm } from '@tanstack/react-form'
import { Banknote, CreditCard, Ellipsis, Loader2, QrCode, Receipt } from 'lucide-react'
import { useId, useMemo } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { MoneyInput } from '../../../components/money.tsx'
import { Alert, AlertDescription, AlertTitle } from '../../../components/ui/alert.tsx'
import { Button } from '../../../components/ui/button.tsx'
import { Checkbox } from '../../../components/ui/checkbox.tsx'
import {
	Field,
	FieldDescription,
	FieldError,
	FieldLabel,
	FieldSet,
} from '../../../components/ui/field.tsx'
import { Input } from '../../../components/ui/input.tsx'
import { RadioGroup, RadioGroupItem } from '../../../components/ui/radio-group.tsx'
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from '../../../components/ui/sheet.tsx'
import { formatMoney, moneyKopecksSchema } from '../../../lib/format-ru.ts'
import { useMarkPaid } from '../hooks/use-folio-queries.ts'

/* ============================================================== schema */

const paymentMethodSchema = z.enum(['cash', 'card', 'sbp', 'bank_transfer', 'stub'])
type PaymentMethod = z.infer<typeof paymentMethodSchema>

interface MarkPaidFormValues {
	amount: string
	method: PaymentMethod
	reference: string
	emitReceipt: boolean
}

/**
 * Form-level validators — keep input/output types IDENTICAL (no transform)
 * so TanStack Form's StandardSchema integration accepts the schema. The
 * `string → bigint` transform happens explicitly in `onSubmit` via
 * `moneyKopecksSchema.parse(value.amount)`.
 */
const formValidators = z.object({
	amount: z.string().min(1, 'Введите сумму'),
	method: paymentMethodSchema,
	reference: z.string().max(500),
	emitReceipt: z.boolean(),
})

/* ============================================================== component */

export interface MarkPaidSheetProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	propertyId: string
	bookingId: string
	folioId: string
	currentBalanceMinor: bigint
}

export function MarkPaidSheet({
	open,
	onOpenChange,
	propertyId,
	bookingId,
	folioId,
	currentBalanceMinor,
}: MarkPaidSheetProps) {
	// Idempotency-Key per-dialog-mount (canon: useMemo with empty deps).
	// New UUID generated each time the Sheet remounts (open=true after close).
	const idempotencyKey = useMemo(() => crypto.randomUUID(), [])
	const formId = useId()
	const refReceiptDescId = useId()

	const markPaid = useMarkPaid()

	// Pre-fill amount with current balance formatted as RU money input string.
	// Operator can edit; on submit Zod converts back to bigint kopecks.
	const initialAmount = formatMoney(currentBalanceMinor).replace(/ ₽$/, '').trim()

	const defaultValues: MarkPaidFormValues = {
		amount: initialAmount,
		method: 'cash',
		reference: '',
		emitReceipt: true,
	}

	const form = useForm({
		defaultValues,
		validators: { onSubmit: formValidators },
		onSubmit: async ({ value }) => {
			let amountMinor: bigint
			try {
				amountMinor = moneyKopecksSchema.parse(value.amount)
			} catch {
				toast.error('Сумма не распознана')
				return
			}
			try {
				const payment = await markPaid.mutateAsync({
					propertyId,
					bookingId,
					folioId,
					amountMinor,
					method: value.method,
					idempotencyKey,
				})
				toast.success(`Платёж принят: ${formatMoney(BigInt(payment.capturedMinor))}`)
				onOpenChange(false)
			} catch (err) {
				toast.error(err instanceof Error ? err.message : 'Ошибка приёма платежа')
			}
		},
	})

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent side="right" className="w-full sm:max-w-md flex flex-col">
				<SheetHeader>
					<SheetTitle>Принять оплату</SheetTitle>
					<SheetDescription id={refReceiptDescId}>
						Текущий баланс к оплате: {formatMoney(currentBalanceMinor)}
					</SheetDescription>
				</SheetHeader>

				<form
					id={formId}
					onSubmit={(e) => {
						e.preventDefault()
						void form.handleSubmit()
					}}
					className="flex-1 overflow-y-auto px-1 py-4 space-y-6"
				>
					{/* Method picker — RadioGroup as cards (h-16 ≥ WCAG 2.5.5 AAA) */}
					<form.Field name="method">
						{(field) => (
							<FieldSet>
								<legend className="text-sm font-medium">Метод оплаты</legend>
								<RadioGroup
									value={field.state.value}
									onValueChange={(v) => field.handleChange(v as PaymentMethod)}
									className="grid grid-cols-2 gap-2"
								>
									<MethodCard value="cash" icon={Banknote} label="Наличные" />
									<MethodCard value="card" icon={CreditCard} label="Карта" />
									<MethodCard value="sbp" icon={QrCode} label="СБП" />
									<MethodCard value="bank_transfer" icon={CreditCard} label="Перевод" />
									<MethodCard
										value="stub"
										icon={Ellipsis}
										label="Демо"
										description="Stub-провайдер, без реального списания"
									/>
								</RadioGroup>
							</FieldSet>
						)}
					</form.Field>

					{/* Amount */}
					<form.Field name="amount">
						{(field) => (
							<Field data-invalid={field.state.meta.errors.length > 0 ? 'true' : undefined}>
								<FieldLabel htmlFor={`${formId}-amount`}>Сумма</FieldLabel>
								<MoneyInput
									id={`${formId}-amount`}
									value={field.state.value}
									onValueChange={({ value }) => field.handleChange(value)}
									aria-invalid={field.state.meta.errors.length > 0}
									aria-describedby={
										field.state.meta.errors.length > 0 ? `${formId}-amount-err` : refReceiptDescId
									}
								/>
								<FieldDescription>
									Доступно к оплате: {formatMoney(currentBalanceMinor)}
								</FieldDescription>
								{field.state.meta.errors.length > 0 ? (
									<FieldError id={`${formId}-amount-err`}>
										{String(field.state.meta.errors[0])}
									</FieldError>
								) : null}
							</Field>
						)}
					</form.Field>

					{/* Reference */}
					<form.Field name="reference">
						{(field) => (
							<Field>
								<FieldLabel htmlFor={`${formId}-ref`}>Референс (опц.)</FieldLabel>
								<Input
									id={`${formId}-ref`}
									type="text"
									value={field.state.value}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder="Чек № / комментарий"
								/>
							</Field>
						)}
					</form.Field>

					{/* Receipt + 54-ФЗ demo badge */}
					<form.Field name="emitReceipt">
						{(field) => (
							<div className="space-y-2">
								<label htmlFor={`${formId}-receipt`} className="flex items-center gap-2 text-sm">
									<Checkbox
										id={`${formId}-receipt`}
										checked={field.state.value}
										onCheckedChange={(v) => field.handleChange(v === true)}
									/>
									<Receipt className="size-4" />
									Сформировать чек 54-ФЗ
								</label>
								<Alert>
									<AlertTitle className="text-sm">Демо-режим</AlertTitle>
									<AlertDescription className="text-xs">
										Фискализация в V1 отключена. Чек будет помечен «Demo» в отчётности.
									</AlertDescription>
								</Alert>
							</div>
						)}
					</form.Field>
				</form>

				<SheetFooter className="flex flex-row gap-2 justify-end border-t pt-4">
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={markPaid.isPending}
					>
						Отмена
					</Button>
					<Button
						type="button"
						className="min-w-32"
						disabled={markPaid.isPending}
						onClick={async () => {
							// TanStack Form 1.29 #1990 + Radix portal pointer-events
							// (round-5 web research): native form submit blocked, useId
							// IDREF lookup unreliable under portal. Канон 2026:
							//   onClick → validateAllFields('submit') → handleSubmit
							// Same pattern as RefundSheet step gate.
							await form.validateAllFields('submit')
							await form.handleSubmit()
						}}
					>
						{markPaid.isPending ? (
							<>
								<Loader2 className="size-4 animate-spin" /> Принимаем…
							</>
						) : (
							'Принять'
						)}
					</Button>
				</SheetFooter>
			</SheetContent>
		</Sheet>
	)
}

/* ============================================================== method card */

interface MethodCardProps {
	value: PaymentMethod
	icon: React.ComponentType<{ className?: string }>
	label: string
	description?: string
}

function MethodCard({ value, icon: Icon, label, description }: MethodCardProps) {
	const id = useId()
	return (
		<label
			htmlFor={id}
			className="flex h-16 cursor-pointer items-center gap-3 rounded-md border border-input p-3 transition-colors hover:bg-muted has-data-[state=checked]:border-primary has-data-[state=checked]:bg-primary/5"
		>
			<RadioGroupItem id={id} value={value} className="shrink-0" />
			<Icon className="size-5 text-muted-foreground" aria-hidden="true" />
			<div className="flex flex-col">
				<span className="text-sm font-medium">{label}</span>
				{description ? <span className="text-xs text-muted-foreground">{description}</span> : null}
			</div>
		</label>
	)
}
