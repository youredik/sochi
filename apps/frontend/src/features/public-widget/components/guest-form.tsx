/**
 * `<GuestForm>` — anonymous guest contact form для booking widget Screen 3.
 *
 * Per `plans/m9_widget_4_canonical.md` §3 + §4 D1+D5:
 *   - TanStack Form 1.29.1 + Zod 4.4.1 Standard Schema direct (NO adapter)
 *   - libphonenumber-js AsYouType('RU') для phone formatting
 *   - 7 fields: firstName, lastName, middleName?, email, phone, citizenship,
 *     specialRequests?
 *   - Form state isolated к component; parent receives validated values via
 *     `onSubmit` callback prop.
 *
 * Field layout: row groups для FIO + email/phone + citizenship + специальные
 * пожелания textarea (separate row). На mobile single column; ≥sm two columns
 * для email/phone, остальное full-width.
 *
 * Validation timing: `onChange` for visible feedback after field touched
 * (`isTouched` gate). Submit validation final.
 */

import type { WidgetGuestInput } from '@horeca/shared'
import { widgetGuestInputSchema } from '@horeca/shared'
import { useForm } from '@tanstack/react-form'
import { useId } from 'react'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { formatRu, isValidRuPhone, toE164 } from '../lib/phone-format.ts'

export interface GuestFormProps {
	/** Initial values (empty by default; usable для restore-from-cache pattern). */
	readonly initialValues?: Partial<WidgetGuestInput>
	/** Called с validated guest input on submit. Parent owns submit pipeline. */
	readonly onSubmit: (guest: WidgetGuestInput) => void | Promise<void>
	/** Disable all fields + submit during external mutation in-flight. */
	readonly disabled?: boolean
	/** Slot для footer (consent block + payment selector + submit button). */
	readonly children?: React.ReactNode
}

interface GuestFormDraft {
	firstName: string
	lastName: string
	middleName: string
	email: string
	phone: string
	citizenship: string
	countryOfResidence: string
	specialRequests: string
}

/**
 * Canonicalize raw form draft → wire shape (trimmed/lowercased/E.164/null-on-empty).
 * Returns `null` если phone не парсится валидным E.164. Single source of truth —
 * used by both `validators.onSubmit` (Zod gate) и `onSubmit` (downstream).
 */
function canonicalizeDraft(draft: GuestFormDraft): WidgetGuestInput | null {
	const phoneE164 = toE164(draft.phone)
	if (!phoneE164) return null
	return {
		firstName: draft.firstName.trim(),
		lastName: draft.lastName.trim(),
		middleName: draft.middleName.trim() || null,
		email: draft.email.trim().toLowerCase(),
		phone: phoneE164,
		citizenship: draft.citizenship.trim().toUpperCase(),
		countryOfResidence: draft.countryOfResidence.trim() || null,
		specialRequests: draft.specialRequests.trim() || null,
	}
}

export function GuestForm({ initialValues, onSubmit, disabled = false, children }: GuestFormProps) {
	const formId = useId()

	const form = useForm({
		defaultValues: {
			firstName: initialValues?.firstName ?? '',
			lastName: initialValues?.lastName ?? '',
			middleName: initialValues?.middleName ?? '',
			email: initialValues?.email ?? '',
			phone: initialValues?.phone ?? '',
			citizenship: initialValues?.citizenship ?? 'RU',
			countryOfResidence: initialValues?.countryOfResidence ?? '',
			specialRequests: initialValues?.specialRequests ?? '',
		} satisfies GuestFormDraft,
		validators: {
			onSubmit: ({ value }) => {
				const candidate = canonicalizeDraft(value)
				if (!candidate) {
					return { fields: { phone: 'Введите корректный номер телефона' } }
				}
				const parsed = widgetGuestInputSchema.safeParse(candidate)
				if (!parsed.success) {
					const fieldErrors: Record<string, string> = {}
					for (const issue of parsed.error.issues) {
						const path = issue.path[0]
						if (typeof path === 'string') fieldErrors[path] = issue.message
					}
					return { fields: fieldErrors }
				}
				return undefined
			},
		},
		onSubmit: async ({ value }) => {
			const candidate = canonicalizeDraft(value)
			if (!candidate) return // already surfaced via validators
			await onSubmit(candidate)
		},
	})

	return (
		<form
			id={formId}
			data-testid="guest-form"
			onSubmit={(e) => {
				e.preventDefault()
				e.stopPropagation()
				void form.handleSubmit()
			}}
			className="space-y-5"
			aria-disabled={disabled || undefined}
		>
			<fieldset className="space-y-4" disabled={disabled}>
				<legend className="text-sm font-medium text-foreground">Контактные данные</legend>

				<div className="grid gap-4 sm:grid-cols-2">
					<form.Field name="lastName">
						{(field) => (
							<Field data-invalid={fieldHasError(field) || undefined}>
								<FieldLabel htmlFor={`${formId}-lastName`}>Фамилия *</FieldLabel>
								<Input
									id={`${formId}-lastName`}
									name="lastName"
									autoComplete="family-name"
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									aria-invalid={fieldHasError(field) || undefined}
									aria-describedby={fieldHasError(field) ? `${formId}-lastName-err` : undefined}
									required
								/>
								{fieldHasError(field) ? (
									<FieldError id={`${formId}-lastName-err`}>{firstErrorMessage(field)}</FieldError>
								) : null}
							</Field>
						)}
					</form.Field>

					<form.Field name="firstName">
						{(field) => (
							<Field data-invalid={fieldHasError(field) || undefined}>
								<FieldLabel htmlFor={`${formId}-firstName`}>Имя *</FieldLabel>
								<Input
									id={`${formId}-firstName`}
									name="firstName"
									autoComplete="given-name"
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									aria-invalid={fieldHasError(field) || undefined}
									aria-describedby={fieldHasError(field) ? `${formId}-firstName-err` : undefined}
									required
								/>
								{fieldHasError(field) ? (
									<FieldError id={`${formId}-firstName-err`}>{firstErrorMessage(field)}</FieldError>
								) : null}
							</Field>
						)}
					</form.Field>
				</div>

				<form.Field name="middleName">
					{(field) => (
						<Field>
							<FieldLabel htmlFor={`${formId}-middleName`}>Отчество (если есть)</FieldLabel>
							<Input
								id={`${formId}-middleName`}
								name="middleName"
								autoComplete="additional-name"
								value={field.state.value ?? ''}
								onBlur={field.handleBlur}
								onChange={(e) => field.handleChange(e.target.value)}
							/>
							<FieldDescription>
								Не обязательно. Заполните, если указано в паспорте.
							</FieldDescription>
						</Field>
					)}
				</form.Field>

				<div className="grid gap-4 sm:grid-cols-2">
					<form.Field name="email">
						{(field) => (
							<Field data-invalid={fieldHasError(field) || undefined}>
								<FieldLabel htmlFor={`${formId}-email`}>Email *</FieldLabel>
								<Input
									id={`${formId}-email`}
									name="email"
									type="email"
									autoComplete="email"
									inputMode="email"
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									aria-invalid={fieldHasError(field) || undefined}
									aria-describedby={
										fieldHasError(field) ? `${formId}-email-err` : `${formId}-email-desc`
									}
									required
								/>
								<FieldDescription id={`${formId}-email-desc`}>
									На этот адрес придёт подтверждение бронирования и magic-link к личному кабинету.
								</FieldDescription>
								{fieldHasError(field) ? (
									<FieldError id={`${formId}-email-err`}>{firstErrorMessage(field)}</FieldError>
								) : null}
							</Field>
						)}
					</form.Field>

					<form.Field name="phone">
						{(field) => {
							const liveValid = field.state.value ? isValidRuPhone(field.state.value) : false
							return (
								<Field data-invalid={fieldHasError(field) || undefined}>
									<FieldLabel htmlFor={`${formId}-phone`}>Телефон *</FieldLabel>
									<Input
										id={`${formId}-phone`}
										name="phone"
										type="tel"
										autoComplete="tel"
										inputMode="tel"
										placeholder="+7 (965) 123-45-67"
										value={field.state.value}
										onBlur={field.handleBlur}
										onChange={(e) => field.handleChange(formatRu(e.target.value))}
										aria-invalid={fieldHasError(field) || undefined}
										aria-describedby={
											fieldHasError(field) ? `${formId}-phone-err` : `${formId}-phone-desc`
										}
										required
									/>
									<FieldDescription id={`${formId}-phone-desc`}>
										{liveValid ? 'Номер распознан корректно.' : 'Введите номер в любом формате.'}
									</FieldDescription>
									{fieldHasError(field) ? (
										<FieldError id={`${formId}-phone-err`}>{firstErrorMessage(field)}</FieldError>
									) : null}
								</Field>
							)
						}}
					</form.Field>
				</div>

				<form.Field name="citizenship">
					{(field) => (
						<Field data-invalid={fieldHasError(field) || undefined}>
							<FieldLabel htmlFor={`${formId}-citizenship`}>Гражданство (ISO) *</FieldLabel>
							<Input
								id={`${formId}-citizenship`}
								name="citizenship"
								autoComplete="country"
								value={field.state.value}
								onBlur={field.handleBlur}
								onChange={(e) => field.handleChange(e.target.value.toUpperCase())}
								maxLength={2}
								aria-invalid={fieldHasError(field) || undefined}
								aria-describedby={`${formId}-citizenship-desc`}
								required
								className="uppercase"
							/>
							<FieldDescription id={`${formId}-citizenship-desc`}>
								Двухбуквенный код по ISO-3166: RU, BY, KZ, UZ, CN и т.д. Для нерезидентов RU вы
								получите инструкции по миграционному учёту.
							</FieldDescription>
							{fieldHasError(field) ? (
								<FieldError id={`${formId}-citizenship-err`}>{firstErrorMessage(field)}</FieldError>
							) : null}
						</Field>
					)}
				</form.Field>

				<form.Field name="specialRequests">
					{(field) => (
						<Field>
							<FieldLabel htmlFor={`${formId}-specialRequests`}>Особые пожелания</FieldLabel>
							<Textarea
								id={`${formId}-specialRequests`}
								name="specialRequests"
								value={field.state.value ?? ''}
								onBlur={field.handleBlur}
								onChange={(e) => field.handleChange(e.target.value)}
								rows={3}
								maxLength={2000}
								placeholder="Например: ранний заезд, дополнительная подушка, аллергия на пух"
							/>
							<FieldDescription>
								По возможности постараемся учесть. Не обязательно.
							</FieldDescription>
						</Field>
					)}
				</form.Field>
			</fieldset>

			{children}
		</form>
	)
}

// biome-ignore lint/suspicious/noExplicitAny: TanStack Form generic field shape — pragmatic
function fieldHasError(field: any): boolean {
	const errors = field?.state?.meta?.errors
	const isTouched = field?.state?.meta?.isTouched
	return Boolean(isTouched && Array.isArray(errors) && errors.length > 0)
}

// biome-ignore lint/suspicious/noExplicitAny: TanStack Form generic field shape — pragmatic
function firstErrorMessage(field: any): string {
	const err = field?.state?.meta?.errors?.[0]
	if (!err) return ''
	if (typeof err === 'string') return err
	if (typeof err === 'object' && err !== null && 'message' in err) {
		return String(err.message)
	}
	return String(err)
}
