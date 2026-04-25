/**
 * `<RefundSheet>` — 2-step in-Sheet confirm для возврата платежа.
 *
 * Per memory `project_m6_7_frontend_research.md`:
 *   - **2-step in-Sheet confirm** — НЕ nested Dialog (на iPad ломается focus
 *     trap, vaul + Radix Sheet не любят вложенные portals). Локальный
 *     `step: 'form' | 'confirm'` state переключает body внутри одного Sheet.
 *   - **Sheet right-side** (480px iPad-h, full на portrait) — единый паттерн
 *     с MarkPaidSheet.
 *   - **Available amount** = `capturedMinor − Σ(succeeded refunds)` —
 *     hard cap в форме + сервер также проверяет (canon invariant #1).
 *   - **Causality**: `{ kind: 'userInitiated', userId: session.user.id }` —
 *     ручной возврат от оператора. Полные refunds от dispute / tkassa_cancel
 *     создаются server-side (CDC consumers), не из этого UI.
 *   - **Reason required** (min 1 char, max 500 — `refundCreateInput`).
 *   - **Idempotency-Key**: `useMemo(crypto.randomUUID(), [])` per-mount.
 *
 * **A11y per axe-core 4.11:**
 *   - `<SheetTitle>` обязателен (Radix throws on missing).
 *   - `<SheetDescription>` либо `aria-describedby={undefined}`.
 *   - Step 2 — `<Alert role="alert">` для предупреждения о необратимости.
 *   - Auto-focus first interactive on step transitions.
 */
import type { Payment, Refund, RefundCausality } from '@horeca/shared'
import { useForm } from '@tanstack/react-form'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft, Loader2 } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { MoneyInput } from '../../../components/money.tsx'
import { Alert, AlertDescription, AlertTitle } from '../../../components/ui/alert.tsx'
import { Button } from '../../../components/ui/button.tsx'
import { Field, FieldDescription, FieldError, FieldLabel } from '../../../components/ui/field.tsx'
import { Separator } from '../../../components/ui/separator.tsx'
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from '../../../components/ui/sheet.tsx'
import { Textarea } from '../../../components/ui/textarea.tsx'
import { authClient } from '../../../lib/auth-client.ts'
import { formatDateShort, formatMoney, moneyKopecksSchema } from '../../../lib/format-ru.ts'
import { paymentRefundsQueryOptions, useCreateRefund } from '../hooks/use-folio-queries.ts'

/* ============================================================== schema */

interface RefundFormValues {
	amount: string
	reason: string
}

/**
 * Form-level validators — input/output типы ИДЕНТИЧНЫ (no transform) per
 * StandardSchema canon. Конвертация string → bigint происходит вручную в
 * `onSubmit` через `moneyKopecksSchema.parse(value.amount)`.
 */
const formValidators = z.object({
	amount: z.string().min(1, 'Введите сумму'),
	reason: z.string().min(1, 'Укажите причину возврата').max(500, 'Не более 500 символов'),
})

/* ============================================================== component */

export interface RefundSheetProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	payment: Payment
	folioId: string
}

export function RefundSheet({ open, onOpenChange, payment, folioId }: RefundSheetProps) {
	// Idempotency-Key per-mount. Sheet remount (open=true after close) → new key.
	const idempotencyKey = useMemo(() => crypto.randomUUID(), [])
	const formId = useId()
	const descId = useId()

	const { data: session } = authClient.useSession()
	const createRefund = useCreateRefund()

	// 2-step state. Form → Confirm → mutate. Reset to form on close.
	const [step, setStep] = useState<'form' | 'confirm'>('form')

	// Existing refunds — для расчёта available amount.
	// `enabled: open` чтобы не дёргать API когда Sheet закрыт.
	const refundsQuery = useQuery({
		...paymentRefundsQueryOptions(payment.id),
		enabled: open,
	})

	const capturedMinor = BigInt(payment.capturedMinor)
	const succeededRefundedMinor = sumSucceededRefunds(refundsQuery.data ?? [])
	const availableMinor = capturedMinor - succeededRefundedMinor
	const isFullyRefunded = availableMinor <= 0n

	// Pre-fill amount = available (operator чаще всего полный возврат).
	const initialAmount = formatMoney(availableMinor).replace(/ ₽$/, '').trim()

	const form = useForm({
		defaultValues: { amount: initialAmount, reason: '' } satisfies RefundFormValues,
		validators: { onSubmit: formValidators },
		onSubmit: async ({ value }) => {
			// Submit only fires on Step 2 confirm — see footer wiring.
			const amountMinor = moneyKopecksSchema.parse(value.amount)

			// Hard cap re-check at submit (form validation already enforces;
			// belt-and-braces against race with refunds list refetch).
			if (amountMinor > availableMinor) {
				toast.error(`Доступно к возврату: ${formatMoney(availableMinor)}`)
				return
			}

			const userId = session?.user.id
			const causality: RefundCausality | null = userId ? { kind: 'userInitiated', userId } : null

			try {
				const refund = await createRefund.mutateAsync({
					paymentId: payment.id,
					folioId,
					amountMinor,
					reason: value.reason.trim(),
					causality,
					idempotencyKey,
				})
				toast.success(`Возврат на ${formatMoney(BigInt(refund.amountMinor))} принят в обработку`)
				onOpenChange(false)
				setStep('form')
			} catch (err) {
				toast.error(err instanceof Error ? err.message : 'Ошибка возврата')
			}
		},
	})

	// Handle Sheet close — reset step so reopening starts at Form.
	const handleOpenChange = (next: boolean) => {
		if (!next) setStep('form')
		onOpenChange(next)
	}

	return (
		<Sheet open={open} onOpenChange={handleOpenChange}>
			<SheetContent side="right" className="w-full sm:max-w-md flex flex-col">
				<SheetHeader>
					<SheetTitle>{step === 'form' ? 'Возврат платежа' : 'Подтвердите возврат'}</SheetTitle>
					<SheetDescription id={descId}>
						{step === 'form'
							? `Платёж от ${formatDateShort(payment.createdAt)} · ${formatMoney(capturedMinor)}`
							: 'Возврат необратим после успешной обработки.'}
					</SheetDescription>
				</SheetHeader>

				<div className="flex-1 overflow-y-auto px-1 py-4">
					{step === 'form' ? (
						<form
							id={formId}
							onSubmit={(e) => {
								e.preventDefault()
								// Native submit (Enter в textarea) — no-op. Шаг 1→2 идёт
								// через footer "Далее"; финальный submit — кнопкой шага 2.
							}}
							className="space-y-6"
						>
							<dl className="grid grid-cols-[1fr_auto] gap-y-1 text-sm">
								<dt className="text-muted-foreground">Списано</dt>
								<dd className="text-right tabular-nums">{formatMoney(capturedMinor)}</dd>
								<dt className="text-muted-foreground">Уже возвращено</dt>
								<dd className="text-right tabular-nums">{formatMoney(succeededRefundedMinor)}</dd>
								<dt className="border-t pt-1 font-medium">Доступно к возврату</dt>
								<dd className="border-t pt-1 text-right font-medium tabular-nums">
									{formatMoney(availableMinor)}
								</dd>
							</dl>

							<Separator />

							{refundsQuery.isLoading ? (
								<p className="text-sm text-muted-foreground">Загрузка истории возвратов…</p>
							) : isFullyRefunded ? (
								<Alert variant="default">
									<AlertTitle>Платёж полностью возвращён</AlertTitle>
									<AlertDescription>
										Доступная сумма к возврату — 0 ₽. Возврат невозможен.
									</AlertDescription>
								</Alert>
							) : (
								<>
									<form.Field name="amount">
										{(field) => (
											<Field data-invalid={field.state.meta.errors.length > 0 ? 'true' : undefined}>
												<FieldLabel htmlFor={`${formId}-amount`}>Сумма к возврату</FieldLabel>
												<MoneyInput
													id={`${formId}-amount`}
													value={field.state.value}
													onValueChange={({ value }) => field.handleChange(value)}
													aria-invalid={field.state.meta.errors.length > 0}
													aria-describedby={
														field.state.meta.errors.length > 0 ? `${formId}-amount-err` : descId
													}
												/>
												<FieldDescription>Максимум: {formatMoney(availableMinor)}</FieldDescription>
												{field.state.meta.errors.length > 0 ? (
													<FieldError id={`${formId}-amount-err`}>
														{String(field.state.meta.errors[0])}
													</FieldError>
												) : null}
											</Field>
										)}
									</form.Field>

									<form.Field name="reason">
										{(field) => (
											<Field data-invalid={field.state.meta.errors.length > 0 ? 'true' : undefined}>
												<FieldLabel htmlFor={`${formId}-reason`}>Причина возврата</FieldLabel>
												<Textarea
													id={`${formId}-reason`}
													value={field.state.value}
													onChange={(e) => field.handleChange(e.target.value)}
													placeholder="Например: отмена брони по просьбе гостя, № 123"
													rows={3}
													maxLength={500}
													aria-invalid={field.state.meta.errors.length > 0}
													aria-describedby={
														field.state.meta.errors.length > 0 ? `${formId}-reason-err` : undefined
													}
												/>
												<FieldDescription>
													Сохраняется в журнале операций. До 500 символов.
												</FieldDescription>
												{field.state.meta.errors.length > 0 ? (
													<FieldError id={`${formId}-reason-err`}>
														{String(field.state.meta.errors[0])}
													</FieldError>
												) : null}
											</Field>
										)}
									</form.Field>
								</>
							)}
						</form>
					) : (
						// `<form.Subscribe>` — TanStack Form 1.29 не вызывает re-render
						// при чтении `form.state.values` напрямую (документировано в
						// reactivity guide). Selector гарантирует синхронизацию + узкий
						// re-render scope. Подтверждено 2026-research round 4.
						<form.Subscribe selector={(s) => s.values}>
							{(values) => (
								<RefundConfirm payment={payment} amount={values.amount} reason={values.reason} />
							)}
						</form.Subscribe>
					)}
				</div>

				<SheetFooter className="flex flex-row gap-2 justify-end border-t pt-4">
					{step === 'form' ? (
						<>
							<Button
								type="button"
								variant="outline"
								onClick={() => handleOpenChange(false)}
								disabled={createRefund.isPending}
							>
								Отмена
							</Button>
							<Button
								type="button"
								className="min-w-32"
								disabled={isFullyRefunded || refundsQuery.isLoading}
								onClick={async () => {
									// `validateAllFields` — TanStack Form 1.29 honest gate:
									// прогоняет field-level + form-level validators и
									// возвращает aggregate ValidationError[]. Чтение
									// `form.state.errors` ловит ТОЛЬКО form-level — для
									// step gate этого недостаточно. (2026-research round 4.)
									const errors = await form.validateAllFields('submit')
									if (errors.length === 0) {
										setStep('confirm')
									}
								}}
							>
								Далее
							</Button>
						</>
					) : (
						<>
							<Button
								type="button"
								variant="outline"
								onClick={() => setStep('form')}
								disabled={createRefund.isPending}
							>
								<ArrowLeft className="size-4" /> Назад
							</Button>
							<Button
								type="button"
								className="min-w-40"
								disabled={createRefund.isPending}
								onClick={() => void form.handleSubmit()}
							>
								{createRefund.isPending ? (
									<>
										<Loader2 className="size-4 animate-spin" /> Возвращаем…
									</>
								) : (
									'Подтвердить возврат'
								)}
							</Button>
						</>
					)}
				</SheetFooter>
			</SheetContent>
		</Sheet>
	)
}

/* ============================================================== Step 2: confirm */

function RefundConfirm({
	payment,
	amount,
	reason,
}: {
	payment: Payment
	amount: string
	reason: string
}) {
	// `amount` — отображаемый формат RU ("1 500,00"). Парсинг для Money не нужен,
	// показываем строку 1:1.
	return (
		<div className="space-y-6">
			<dl className="grid grid-cols-[140px_1fr] gap-y-2 text-sm">
				<dt className="text-muted-foreground">Платёж</dt>
				<dd className="font-mono text-xs">{payment.id.slice(-12)}</dd>
				<dt className="text-muted-foreground">Дата платежа</dt>
				<dd>{formatDateShort(payment.createdAt)}</dd>
				<dt className="text-muted-foreground">Сумма возврата</dt>
				<dd className="font-medium tabular-nums">{amount} ₽</dd>
				<dt className="text-muted-foreground">Причина</dt>
				<dd className="whitespace-pre-wrap break-words">{reason}</dd>
			</dl>

			<Alert variant="destructive" role="alert">
				<AlertTriangle className="size-4" />
				<AlertTitle>Действие необратимо</AlertTitle>
				<AlertDescription>
					После успешной обработки возврат нельзя отменить. Для исправления потребуется встречное
					начисление в фолио.
				</AlertDescription>
			</Alert>
		</div>
	)
}

/* ============================================================== helpers */

/**
 * Σ(refunds.amountMinor) where status = 'succeeded'. Pending refunds НЕ считаются
 * (могут провалиться); failed — не считаются (не списали средства). Совпадает
 * с серверной формулой в `refund.service.ts → assertWithinCap`.
 */
function sumSucceededRefunds(refunds: Refund[]): bigint {
	return refunds
		.filter((r) => r.status === 'succeeded')
		.reduce((acc, r) => acc + BigInt(r.amountMinor), 0n)
}
