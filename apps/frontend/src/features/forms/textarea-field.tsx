import type { AnyFieldApi } from '@tanstack/react-form'
import type { ComponentProps } from 'react'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { formatErrors } from './format-errors.ts'

/**
 * TanStack-Form-backed textarea with accessible label + error.
 *
 * Mirrors TextField's behaviour (label/input association via `field.name`,
 * aria-invalid on touched-with-errors, aria-describedby to description OR
 * error never both) — extracted because booking edit dialog needs cancel
 * reason (required) + no-show reason (optional), both multi-line.
 *
 * Value is always string — `<textarea>` never emits `valueAsNumber` so
 * we skip the TextField number-coercion branch.
 */
type TextareaFieldProps = {
	field: AnyFieldApi
	label: string
	description?: string
} & Omit<
	ComponentProps<'textarea'>,
	'id' | 'name' | 'value' | 'onChange' | 'onBlur' | 'aria-invalid' | 'aria-describedby'
>

export function TextareaField({ field, label, description, ...rest }: TextareaFieldProps) {
	const errors = field.state.meta.errors
	const isTouched = field.state.meta.isTouched
	const hasError = isTouched && errors.length > 0
	const descId = `${field.name}-desc`
	const errId = `${field.name}-err`
	const describedBy = hasError ? errId : description ? descId : undefined

	const stringValue = typeof field.state.value === 'string' ? field.state.value : ''

	return (
		<div className="space-y-1.5">
			<Label htmlFor={field.name}>{label}</Label>
			<Textarea
				id={field.name}
				name={field.name}
				value={stringValue}
				onBlur={field.handleBlur}
				onChange={(e) => field.handleChange(e.target.value)}
				aria-invalid={hasError || undefined}
				aria-describedby={describedBy}
				{...rest}
			/>
			{description && !hasError ? (
				<p id={descId} className="text-muted-foreground text-xs">
					{description}
				</p>
			) : null}
			{hasError ? (
				<p id={errId} className="text-destructive text-xs" aria-live="polite">
					{formatErrors(errors)}
				</p>
			) : null}
		</div>
	)
}
