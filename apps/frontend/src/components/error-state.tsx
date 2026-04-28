import { AlertCircleIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface ErrorStateProps {
	/** Default «Что-то пошло не так». */
	title?: string
	/** Optional Error для technical details в <details>. */
	error?: Error
	/** Optional retry callback — render Button если provided. */
	onRetry?: () => void
	className?: string
}

/**
 * ErrorState — strict error display для async operation failures.
 *
 * Apply pattern: error boundaries, query-error states, mutation rollback.
 * Не leaks stack trace / sensitive data — error.message в <details>
 * (collapsed default), audit-friendly.
 *
 * a11y: `role="alert"` для screen reader announce, retry button focusable.
 * Per plan §M9.5 5.6.
 */
export function ErrorState({
	title = 'Что-то пошло не так',
	error,
	onRetry,
	className,
}: ErrorStateProps) {
	return (
		<div
			role="alert"
			className={cn('flex flex-col items-center justify-center gap-4 py-12 text-center', className)}
		>
			<div className="bg-destructive/10 flex size-12 items-center justify-center rounded-full">
				<AlertCircleIcon className="text-destructive size-6" aria-hidden="true" />
			</div>
			<div className="flex max-w-md flex-col gap-1">
				<h3 className="text-base font-semibold tracking-tight">{title}</h3>
				{error?.message ? (
					<details className="text-muted-foreground text-sm">
						<summary className="cursor-pointer">Подробнее</summary>
						<p className="mt-2 break-words font-mono text-xs">{error.message}</p>
					</details>
				) : null}
			</div>
			{onRetry ? (
				<Button type="button" onClick={onRetry} variant="outline" size="sm">
					Повторить
				</Button>
			) : null}
		</div>
	)
}
