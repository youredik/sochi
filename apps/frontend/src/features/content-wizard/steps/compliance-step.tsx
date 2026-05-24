import {
	checkGuestHouseInvariant,
	checkTaxRegimeInvariant,
	isNpdLimitExceeded,
	isUsnThresholdAtRisk,
	type KsrCategory,
	ksrCategoryValues,
	type LegalEntityType,
	legalEntityTypeValues,
	type TaxRegime,
	type TenantCompliancePatch,
	taxRegimeValues,
} from '@horeca/shared'
import { useForm } from '@tanstack/react-form'
import { useId, useMemo } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { freshIdempotencyKey } from '../../../lib/idempotency.ts'
import { useCan } from '../../../lib/use-can.ts'
import { useCompliance, usePatchCompliance } from '../hooks/use-compliance.ts'
import { useContentWizardStore } from '../wizard-store.ts'

/**
 * Step 1 — Compliance form (org-level, owner-only).
 *
 * Backend gates `compliance:update` to owner per 152-ФЗ ст. 22 (DPA holder
 * = legal entity owner; manager has read-only for tax-regime guidance UI).
 * Frontend mirrors via `useCan` for UX hint; server is the load-bearing gate.
 *
 * Fields wired to `TenantCompliancePatch` schema (three-state: undefined =
 * keep, null = clear, value = set). Empty inputs map to null (explicit clear)
 * because user just typing then erasing should not preserve the prior value
 * — match Apaleo's "save what you see" UX.
 *
 * Cross-field invariants run on submit + display in the response's
 * `warnings` array (server-side authoritative). We pre-compute client-side
 * for inline hints (instant feedback) but never block submit on them.
 *
 * Threshold warnings (УСН-60M, НПД-3.8M) advisory; computed from
 * `annualRevenueEstimateMicroRub` field directly so the operator sees the
 * red flag *before* submitting.
 */

const KSR_CATEGORY_LABELS: Record<KsrCategory, string> = {
	hotel: 'Гостиница',
	aparthotel: 'Апарт-отель',
	mini_hotel: 'Мини-гостиница',
	guest_house: 'Гостевой дом',
	sanatorium: 'Санаторий',
	rest_house: 'Дом отдыха',
	hostel: 'Хостел',
	camping: 'Кемпинг',
	tourist_center: 'Турбаза',
	recreation_complex: 'Комплекс отдыха',
	other: 'Другое',
}

const LEGAL_ENTITY_LABELS: Record<LegalEntityType, string> = {
	ip: 'ИП',
	ooo: 'ООО',
	ao: 'АО',
	npd: 'Самозанятый (НПД)',
	other: 'Другое',
}

const TAX_REGIME_LABELS: Record<TaxRegime, string> = {
	NPD: 'НПД (для самозанятых)',
	USN_DOHODY: 'УСН — доходы',
	USN_DOHODY_RASHODY: 'УСН — доходы минус расходы',
	PSN: 'Патент (ПСН)',
	OSN: 'ОСН',
	AUSN_DOHODY: 'АУСН — доходы',
	AUSN_DOHODY_RASHODY: 'АУСН — доходы минус расходы',
	UNKNOWN: 'Не указан',
}

interface FormValues {
	ksrRegistryId: string
	ksrCategory: KsrCategory | ''
	legalEntityType: LegalEntityType | ''
	taxRegime: TaxRegime | ''
	annualRevenueRub: string
	guestHouseFz127Registered: 'yes' | 'no' | 'unset'
	// Sprint C+ Senior P1-5 fix 2026-05-23d: 152-ФЗ ст.9 ч.4 operator identity
	// fields. legalAddress mandatory per statute; dpoEmail recommended by РКН.
	legalAddress: string
	dpoEmail: string
	// Sprint C+ Round 6 Legal P0 fix 2026-05-24: 152-ФЗ ст.22 ч.3 п.7.1 full DPO contact.
	// dpoEmail одного field недостаточно — статья требует ФИО + телефон + почтовый адрес.
	dpoFullName: string
	dpoPhone: string
	dpoPostalAddress: string
}

function toMicroRub(rubInput: string): bigint | null {
	const trimmed = rubInput.trim()
	if (trimmed === '') return null
	// Allow `1234567` and `1 234 567` and `1,234,567`
	const cleaned = trimmed.replace(/[\s,]/g, '')
	if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null
	const [whole, frac = ''] = cleaned.split('.')
	const fracPadded = `${frac}00`.slice(0, 2)
	// micro = rub × 1_000_000; with at most 2 fraction digits: rub.frac → 6+2 digits
	// Multiply by 10_000 to lift the 2 fraction digits to micro scale.
	return BigInt(whole + fracPadded) * 10_000n
}

function fromMicroRub(micro: bigint): string {
	// Display in whole rubles for the input field — operator types in rub
	// not micro; precision below 1₽ irrelevant for revenue estimate.
	const rub = micro / 1_000_000n
	return rub.toString()
}

export function ComplianceStep() {
	const canUpdate = useCan({ compliance: ['update'] })
	const { data: existing, isLoading, error } = useCompliance()
	const patch = usePatchCompliance()
	const next = useContentWizardStore((s) => s.next)
	const headingId = useId()
	const ksrIdInputId = useId()
	const annualRevenueInputId = useId()

	const form = useForm({
		defaultValues: {
			ksrRegistryId: existing?.ksrRegistryId ?? '',
			ksrCategory: existing?.ksrCategory ?? '',
			legalEntityType: existing?.legalEntityType ?? '',
			taxRegime: existing?.taxRegime ?? '',
			annualRevenueRub:
				existing?.annualRevenueEstimateMicroRub != null
					? fromMicroRub(existing.annualRevenueEstimateMicroRub)
					: '',
			guestHouseFz127Registered:
				existing?.guestHouseFz127Registered === true
					? 'yes'
					: existing?.guestHouseFz127Registered === false
						? 'no'
						: 'unset',
			legalAddress: existing?.legalAddress ?? '',
			dpoEmail: existing?.dpoEmail ?? '',
			// Sprint C+ Round 6 Legal P0 fix 2026-05-24: ст.22 ч.3 п.7.1 full DPO contact.
			dpoFullName: existing?.dpoFullName ?? '',
			dpoPhone: existing?.dpoPhone ?? '',
			dpoPostalAddress: existing?.dpoPostalAddress ?? '',
		} satisfies FormValues,
		onSubmit: async ({ value }) => {
			const microRevenue = toMicroRub(value.annualRevenueRub)
			const body: TenantCompliancePatch = {
				ksrRegistryId: value.ksrRegistryId.trim() === '' ? null : value.ksrRegistryId.trim(),
				ksrCategory: value.ksrCategory === '' ? null : value.ksrCategory,
				legalEntityType: value.legalEntityType === '' ? null : value.legalEntityType,
				taxRegime: value.taxRegime === '' ? null : value.taxRegime,
				annualRevenueEstimateMicroRub:
					value.annualRevenueRub.trim() === '' ? null : (microRevenue ?? undefined),
				guestHouseFz127Registered:
					value.guestHouseFz127Registered === 'unset'
						? null
						: value.guestHouseFz127Registered === 'yes',
				// Sprint C+ Senior P1-5 fix 2026-05-23d: 152-ФЗ ст.9 ч.4 fields.
				legalAddress: value.legalAddress.trim() === '' ? null : value.legalAddress.trim(),
				dpoEmail: value.dpoEmail.trim() === '' ? null : value.dpoEmail.trim(),
				// Sprint C+ Round 6 Legal P0 fix 2026-05-24: ст.22 ч.3 п.7.1 full DPO contact.
				dpoFullName: value.dpoFullName.trim() === '' ? null : value.dpoFullName.trim(),
				dpoPhone: value.dpoPhone.trim() === '' ? null : value.dpoPhone.trim(),
				dpoPostalAddress:
					value.dpoPostalAddress.trim() === '' ? null : value.dpoPostalAddress.trim(),
			}
			// Fresh key per submit click — TanStack Query auto-retry reuses
			// the same vars (same key), so the server's idempotency middleware
			// replays on retry instead of double-applying.
			await patch.mutateAsync({ input: body, idempotencyKey: freshIdempotencyKey() })
		},
	})

	const liveValues = form.state.values

	const liveInvariantWarnings = useMemo(() => {
		const ghWarning = checkGuestHouseInvariant({
			ksrCategory: liveValues.ksrCategory === '' ? null : liveValues.ksrCategory,
			guestHouseFz127Registered:
				liveValues.guestHouseFz127Registered === 'unset'
					? null
					: liveValues.guestHouseFz127Registered === 'yes',
		})
		const trWarning = checkTaxRegimeInvariant({
			legalEntityType: liveValues.legalEntityType === '' ? null : liveValues.legalEntityType,
			taxRegime: liveValues.taxRegime === '' ? null : liveValues.taxRegime,
		})
		return [ghWarning, trWarning].filter((w): w is string => w !== null)
	}, [
		liveValues.ksrCategory,
		liveValues.guestHouseFz127Registered,
		liveValues.legalEntityType,
		liveValues.taxRegime,
	])

	const thresholdWarnings = useMemo(() => {
		const micro = toMicroRub(liveValues.annualRevenueRub)
		if (micro === null) return [] as string[]
		const out: string[] = []
		if (liveValues.legalEntityType === 'npd' && isNpdLimitExceeded(micro)) {
			out.push('Превышен лимит НПД 2026 (3,8 млн ₽). Необходим переход на ИП/ООО.')
		}
		if (
			(liveValues.taxRegime === 'USN_DOHODY' || liveValues.taxRegime === 'USN_DOHODY_RASHODY') &&
			isUsnThresholdAtRisk(micro)
		) {
			out.push('Приближаетесь к порогу УСН-60 млн ₽ (376-ФЗ). Рассмотрите переход на ОСН.')
		}
		return out
	}, [liveValues.annualRevenueRub, liveValues.legalEntityType, liveValues.taxRegime])

	if (isLoading) {
		return <p className="text-muted-foreground">Загрузка…</p>
	}
	if (error && !existing) {
		// 404 on first run is expected — render empty form. Other errors block.
		const code = (error as { code?: string }).code
		if (code !== 'NOT_FOUND') {
			return (
				<Alert variant="destructive">
					<AlertTitle>Ошибка</AlertTitle>
					<AlertDescription>{(error as Error).message}</AlertDescription>
				</Alert>
			)
		}
	}

	return (
		<section aria-labelledby={headingId}>
			<h2 id={headingId} className="text-xl font-semibold">
				Compliance — нормативные данные
			</h2>
			<p className="text-muted-foreground mt-1 text-sm">
				КСР, налоговый режим, ФЗ-127 для гостевых домов. Только владелец организации (по 152-ФЗ ст.
				22).
			</p>

			{!canUpdate ? (
				<Alert className="mt-4">
					<AlertTitle>Только просмотр</AlertTitle>
					<AlertDescription>
						Изменение compliance-данных доступно только владельцу организации (152-ФЗ ст. 22).
					</AlertDescription>
				</Alert>
			) : null}

			<form
				onSubmit={(e) => {
					e.preventDefault()
					void form.handleSubmit()
				}}
				className="mt-6 space-y-5"
				noValidate
			>
				<form.Field name="ksrRegistryId">
					{(field) => (
						<div className="space-y-1.5">
							<Label htmlFor={ksrIdInputId}>Идентификатор КСР</Label>
							<Input
								id={ksrIdInputId}
								name={field.name}
								value={field.state.value}
								onChange={(e) => field.handleChange(e.target.value)}
								onBlur={field.handleBlur}
								disabled={!canUpdate}
								placeholder="Напр. КСР-23-12345"
								maxLength={50}
								aria-describedby={`${ksrIdInputId}-desc`}
							/>
							<p id={`${ksrIdInputId}-desc`} className="text-muted-foreground text-xs">
								Реестр КСР по ПП-1912 от 27.11.2025 (с 01.03.2026). Штраф 300–450 тыс. ₽ за работу
								без записи.
							</p>
						</div>
					)}
				</form.Field>

				<form.Field name="ksrCategory">
					{(field) => (
						<div className="space-y-1.5">
							<Label htmlFor={field.name}>Категория КСР</Label>
							<Select
								value={field.state.value}
								onValueChange={(v) => field.handleChange(v as FormValues['ksrCategory'])}
								disabled={!canUpdate}
							>
								<SelectTrigger id={field.name}>
									<SelectValue placeholder="Не задано" />
								</SelectTrigger>
								<SelectContent>
									{ksrCategoryValues.map((c) => (
										<SelectItem key={c} value={c}>
											{KSR_CATEGORY_LABELS[c]}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					)}
				</form.Field>

				<form.Field name="legalEntityType">
					{(field) => (
						<div className="space-y-1.5">
							<Label htmlFor={field.name}>Организационно-правовая форма</Label>
							<Select
								value={field.state.value}
								onValueChange={(v) => field.handleChange(v as FormValues['legalEntityType'])}
								disabled={!canUpdate}
							>
								<SelectTrigger id={field.name}>
									<SelectValue placeholder="Не задано" />
								</SelectTrigger>
								<SelectContent>
									{legalEntityTypeValues.map((t) => (
										<SelectItem key={t} value={t}>
											{LEGAL_ENTITY_LABELS[t]}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					)}
				</form.Field>

				<form.Field name="taxRegime">
					{(field) => (
						<div className="space-y-1.5">
							<Label htmlFor={field.name}>Налоговый режим</Label>
							<Select
								value={field.state.value}
								onValueChange={(v) => field.handleChange(v as FormValues['taxRegime'])}
								disabled={!canUpdate}
							>
								<SelectTrigger id={field.name}>
									<SelectValue placeholder="Не задано" />
								</SelectTrigger>
								<SelectContent>
									{taxRegimeValues.map((r) => (
										<SelectItem key={r} value={r}>
											{TAX_REGIME_LABELS[r]}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					)}
				</form.Field>

				<form.Field name="annualRevenueRub">
					{(field) => (
						<div className="space-y-1.5">
							<Label htmlFor={annualRevenueInputId}>Годовая выручка, ₽ (оценка)</Label>
							<Input
								id={annualRevenueInputId}
								name={field.name}
								type="text"
								inputMode="numeric"
								value={field.state.value}
								onChange={(e) => field.handleChange(e.target.value)}
								onBlur={field.handleBlur}
								disabled={!canUpdate}
								placeholder="напр. 5 000 000"
								aria-describedby={`${annualRevenueInputId}-desc`}
							/>
							<p id={`${annualRevenueInputId}-desc`} className="text-muted-foreground text-xs">
								Используется для подсказок про лимиты УСН-60 млн (376-ФЗ) и НПД-3,8 млн (425-ФЗ). Не
								передаётся в налоговую.
							</p>
						</div>
					)}
				</form.Field>

				{liveValues.ksrCategory === 'guest_house' ? (
					<form.Field name="guestHouseFz127Registered">
						{(field) => (
							<div className="space-y-1.5">
								<Label>Эксперимент ФЗ-127 (гостевые дома, ПП-1345)</Label>
								<RadioGroup
									value={field.state.value}
									onValueChange={(v) =>
										field.handleChange(v as FormValues['guestHouseFz127Registered'])
									}
									disabled={!canUpdate}
								>
									<div className="flex items-center gap-2">
										<RadioGroupItem id={`${field.name}-yes`} value="yes" />
										<Label htmlFor={`${field.name}-yes`}>Зарегистрирован в эксперименте</Label>
									</div>
									<div className="flex items-center gap-2">
										<RadioGroupItem id={`${field.name}-no`} value="no" />
										<Label htmlFor={`${field.name}-no`}>Не зарегистрирован</Label>
									</div>
									<div className="flex items-center gap-2">
										<RadioGroupItem id={`${field.name}-unset`} value="unset" />
										<Label htmlFor={`${field.name}-unset`}>Уточню позже</Label>
									</div>
								</RadioGroup>
							</div>
						)}
					</form.Field>
				) : null}

				{/*
				 * Sprint C+ Senior P1-5 fix 2026-05-23d: 152-ФЗ ст.9 ч.4 operator identity.
				 * legalAddress required by statute («наименование или ФИО и адрес оператора»),
				 * dpoEmail recommended by РКН practice (ст.22.1 contact для регулятора).
				 * These flow в Consent152FzModal через useCompliance hook.
				 */}
				<form.Field name="legalAddress">
					{(field) => {
						const id = `${field.name}-id`
						return (
							<div className="grid gap-2">
								<Label htmlFor={id}>Юридический адрес оператора</Label>
								<Input
									id={id}
									type="text"
									value={field.state.value}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder="г. Сочи, ул. Курортный проспект, д. 1"
									maxLength={500}
									autoComplete="street-address"
								/>
								<p className="text-xs text-muted-foreground">
									152-ФЗ ст.9 ч.4 — обязательно в тексте согласия на обработку ПДн.
								</p>
							</div>
						)
					}}
				</form.Field>

				<form.Field name="dpoEmail">
					{(field) => {
						const id = `${field.name}-id`
						return (
							<div className="grid gap-2">
								<Label htmlFor={id}>Email DPO</Label>
								<Input
									id={id}
									type="email"
									value={field.state.value}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder="dpo@hotel-domain.ru"
									maxLength={200}
									autoComplete="email"
								/>
							</div>
						)
					}}
				</form.Field>

				{/*
				 * Sprint C+ Round 6 Legal P0 fix 2026-05-24 — 152-ФЗ ст.22 ч.3 п.7.1
				 * verbatim: «фамилия, имя, отчество ... ответственного за организацию
				 * обработки персональных данных, и номера их контактных телефонов,
				 * почтовые адреса и адреса электронной почты». Email-only insufficient.
				 */}
				<form.Field name="dpoFullName">
					{(field) => {
						const id = `${field.name}-id`
						return (
							<div className="grid gap-2">
								<Label htmlFor={id}>ФИО DPO</Label>
								<Input
									id={id}
									type="text"
									value={field.state.value}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder="Иванов Иван Иванович"
									maxLength={200}
									autoComplete="name"
								/>
							</div>
						)
					}}
				</form.Field>

				<form.Field name="dpoPhone">
					{(field) => {
						const id = `${field.name}-id`
						return (
							<div className="grid gap-2">
								<Label htmlFor={id}>Телефон DPO</Label>
								<Input
									id={id}
									type="tel"
									value={field.state.value}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder="+7 999 123-45-67"
									maxLength={20}
									autoComplete="tel"
								/>
							</div>
						)
					}}
				</form.Field>

				<form.Field name="dpoPostalAddress">
					{(field) => {
						const id = `${field.name}-id`
						return (
							<div className="grid gap-2">
								<Label htmlFor={id}>Почтовый адрес DPO</Label>
								<Input
									id={id}
									type="text"
									value={field.state.value}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder="г. Сочи, ул. Морская, д. 5, оф. 12"
									maxLength={500}
									autoComplete="street-address"
								/>
								<p className="text-xs text-muted-foreground">
									152-ФЗ ст.22 ч.3 п.7.1 — ФИО + email + телефон + почтовый адрес ответственного за
									обработку ПДн обязательны для уведомления РКН.
								</p>
							</div>
						)
					}}
				</form.Field>

				{liveInvariantWarnings.length > 0 ? (
					<Alert variant="destructive">
						<AlertTitle>Несовместимые значения</AlertTitle>
						<AlertDescription>
							<ul className="list-disc pl-5">
								{liveInvariantWarnings.map((w) => (
									<li key={w}>{w}</li>
								))}
							</ul>
						</AlertDescription>
					</Alert>
				) : null}

				{thresholdWarnings.length > 0 ? (
					<Alert>
						<AlertTitle>Налоговые пороги</AlertTitle>
						<AlertDescription>
							<ul className="list-disc pl-5">
								{thresholdWarnings.map((w) => (
									<li key={w}>{w}</li>
								))}
							</ul>
						</AlertDescription>
					</Alert>
				) : null}

				<div className="flex items-center gap-3">
					<Button type="submit" size="lg" disabled={!canUpdate || patch.isPending}>
						{patch.isPending ? 'Сохраняем…' : 'Сохранить'}
					</Button>
					<Button type="button" variant="ghost" onClick={() => next()}>
						Далее — удобства
					</Button>
				</div>
			</form>
		</section>
	)
}
