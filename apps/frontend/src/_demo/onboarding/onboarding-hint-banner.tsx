/**
 * Round 14.6 Phase E.bis — onboarding hint banner для tenant demo route.
 *
 * Pure presentational component — никаких side-effects, никаких прямых
 * router/query coupling. Caller (`_app.o.$orgSlug.demo.tsx`) feeds:
 *   - `visible` — controlled boolean (parent owns query + state)
 *   - `orgSlug` — for the deep-link к setup wizard
 *   - `onDismiss` — close-X handler (parent decides scope: visit / persistent)
 *
 * Mounted на the tenant demo route когда user has 0 properties. Provides
 * discovery path к /o/$orgSlug/setup wizard так чтобы magic-link redirect
 * к /demo не оставлял users stuck.
 *
 * **Why standalone module (not inline в route)**: Bun test runner module-
 * mock pollution between test files — mocking `@tanstack/react-router` в
 * one test file affects ALL imported files. Extracting к pure component
 * (no router import) allows isolated test без mock leak. Canon
 * `feedback_critical_fix_test_coverage` requires the test; canon
 * `feedback_no_halfway` requires it to не break other tests.
 */
import { Link } from '@tanstack/react-router'

export interface OnboardingHintBannerProps {
	readonly visible: boolean
	readonly orgSlug: string
	readonly onDismiss: () => void
}

export function OnboardingHintBanner({ visible, orgSlug, onDismiss }: OnboardingHintBannerProps) {
	if (!visible) return null
	return (
		<div
			role="status"
			data-testid="demo-onboarding-hint"
			className="flex items-center justify-between gap-3 border-amber-200 border-b bg-amber-50 px-4 py-2 text-amber-900 text-sm dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100"
		>
			<p>
				Это демо-режим — брони не настоящие. Чтобы начать принимать настоящие бронирования,{' '}
				<Link
					to="/o/$orgSlug/setup"
					params={{ orgSlug }}
					className="underline underline-offset-2 hover:no-underline"
					data-testid="demo-onboarding-setup-link"
				>
					создайте свою гостиницу
				</Link>
				.
			</p>
			<button
				type="button"
				onClick={onDismiss}
				className="shrink-0 rounded px-2 py-1 hover:bg-amber-100 dark:hover:bg-amber-900"
				aria-label="Скрыть подсказку"
			>
				×
			</button>
		</div>
	)
}
