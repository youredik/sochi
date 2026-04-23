/**
 * Pure mapper for TanStack Form `field.state.meta.errors` → single display
 * string. Kept separate from TextField so it's unit-testable without RTL
 * and re-usable by other field shapes (Select/Checkbox wrappers) that
 * render their own error region but share the same error taxonomy.
 *
 * TanStack Form errors are `ValidationError[]` which in practice is
 * `unknown[]` — may contain strings, `{message}` objects, Zod issues, or
 * nested validators' return values. We normalise each to a readable
 * string and join with `, ` for UI.
 */
export function formatErrors(errors: readonly unknown[]): string {
	return errors.map(normalize).filter(Boolean).join(', ')
}

function normalize(err: unknown): string {
	if (typeof err === 'string') return err
	if (err && typeof err === 'object' && 'message' in err) {
		const msg = (err as { message: unknown }).message
		if (typeof msg === 'string') return msg
	}
	if (err == null) return ''
	return 'Ошибка валидации'
}
