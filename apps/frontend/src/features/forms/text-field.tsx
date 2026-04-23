import type { AnyFieldApi } from '@tanstack/react-form'
import type { ComponentProps } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatErrors } from './format-errors.ts'

/**
 * TanStack-Form-backed text input with accessible label + error.
 *
 * Design: consumer composes via `<form.Field name="x">{(field) => <TextField field={field} ...>}</form.Field>`.
 * Wrapper owns: label/input association via `field.name`, aria-invalid on
 * touched-with-errors, aria-describedby pointing to the right region
 * (description OR error, never both at once), onBlur to mark touched so
 * server-side submit errors don't show before user leaves the field.
 *
 * `type="number"` coerces via `valueAsNumber` so Zod's `.number()`/`.int()`
 * don't need a preprocess. For other types value stays string.
 *
 * Re-used by all M5c wizard steps (property / roomType / room) and M5e
 * booking editor. When a field shape doesn't fit (Select, Checkbox, date
 * ranges) — inline the composition instead of bending this wrapper.
 */
type TextFieldProps = {
	field: AnyFieldApi
	label: string
	description?: string
} & Omit<
	ComponentProps<'input'>,
	'id' | 'name' | 'value' | 'onChange' | 'onBlur' | 'aria-invalid' | 'aria-describedby'
>

export function TextField({ field, label, description, type = 'text', ...rest }: TextFieldProps) {
	const errors = field.state.meta.errors
	const isTouched = field.state.meta.isTouched
	const hasError = isTouched && errors.length > 0
	const descId = `${field.name}-desc`
	const errId = `${field.name}-err`
	const describedBy = hasError ? errId : description ? descId : undefined

	const valueProp = field.state.value
	const stringValue =
		typeof valueProp === 'number'
			? Number.isFinite(valueProp)
				? String(valueProp)
				: ''
			: typeof valueProp === 'string'
				? valueProp
				: ''

	return (
		<div className="space-y-1.5">
			<Label htmlFor={field.name}>{label}</Label>
			<Input
				id={field.name}
				name={field.name}
				type={type}
				value={stringValue}
				onBlur={field.handleBlur}
				onChange={(e) => {
					if (type === 'number') {
						const n = e.target.valueAsNumber
						field.handleChange(Number.isNaN(n) ? undefined : n)
					} else {
						field.handleChange(e.target.value)
					}
				}}
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
