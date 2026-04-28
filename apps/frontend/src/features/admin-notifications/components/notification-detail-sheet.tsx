/**
 * Drill-down Sheet для notification detail — payload + retry timeline
 * + retry button (RBAC-gated по `notification:retry`).
 *
 * Per memory `project_mcp_server_strategic.md` (Apr 2026 PMS canon):
 * URL-addressable side panel, NOT modal — operator can deep-link to a
 * specific notification.
 */
import { useSuspenseQuery } from '@tanstack/react-query'
import { RbacButton } from '../../../components/rbac-button.tsx'
import { Alert, AlertDescription, AlertTitle } from '../../../components/ui/alert.tsx'
import { Badge } from '../../../components/ui/badge.tsx'
import { Button } from '../../../components/ui/button.tsx'
import {
	ResponsiveSheet,
	ResponsiveSheetContent,
	ResponsiveSheetHeader,
	ResponsiveSheetTitle,
} from '../../../components/ui/responsive-sheet.tsx'
import { formatDateLong } from '../../../lib/format-ru.ts'
import { useCan } from '../../../lib/use-can.ts'
import { notificationDetailQueryOptions, useRetryNotification } from '../hooks/use-notifications.ts'
import { notificationKindLabel, notificationStatusBadge } from '../lib/notification-labels.ts'
import { attemptBadgeConf, deriveRetryGate } from '../lib/retry-gate.ts'

export function NotificationDetailSheet({
	id,
	open,
	onOpenChange,
}: {
	id: string
	open: boolean
	onOpenChange: (open: boolean) => void
}) {
	return (
		<ResponsiveSheet open={open} onOpenChange={onOpenChange}>
			<ResponsiveSheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
				<NotificationDetailBody id={id} onClose={() => onOpenChange(false)} />
			</ResponsiveSheetContent>
		</ResponsiveSheet>
	)
}

function NotificationDetailBody({ id, onClose }: { id: string; onClose: () => void }) {
	const { data: detail } = useSuspenseQuery(notificationDetailQueryOptions(id))
	const retry = useRetryNotification()
	const canRetry = useCan({ notification: ['retry'] })

	const conf = notificationStatusBadge(detail.notification.status)
	const gate = deriveRetryGate({
		status: detail.notification.status,
		canRetry,
	})

	return (
		<>
			<ResponsiveSheetHeader>
				<ResponsiveSheetTitle>
					{notificationKindLabel(detail.notification.kind)}
				</ResponsiveSheetTitle>
			</ResponsiveSheetHeader>

			<dl className="mt-4 grid gap-3 text-sm">
				<DlRow label="Статус">
					<Badge variant={conf.variant}>{conf.label}</Badge>
				</DlRow>
				<DlRow label="Получатель">
					<span className="font-mono text-xs">{detail.notification.recipient}</span>
				</DlRow>
				<DlRow label="Канал">
					<Badge variant="outline">{detail.notification.channel}</Badge>
				</DlRow>
				<DlRow label="Тема">{detail.notification.subject}</DlRow>
				<DlRow label="Создано">
					<time dateTime={detail.notification.createdAt}>
						{formatDateLong(detail.notification.createdAt)}
					</time>
				</DlRow>
				{detail.notification.sentAt ? (
					<DlRow label="Отправлено">
						<time dateTime={detail.notification.sentAt}>
							{formatDateLong(detail.notification.sentAt)}
						</time>
					</DlRow>
				) : null}
				{detail.notification.failedAt ? (
					<DlRow label="Сбой">
						<time dateTime={detail.notification.failedAt}>
							{formatDateLong(detail.notification.failedAt)}
						</time>
					</DlRow>
				) : null}
				<DlRow label="Попыток">{detail.notification.retryCount}</DlRow>
				{detail.nextAttemptAt ? (
					<DlRow label="Следующая попытка">
						<time dateTime={detail.nextAttemptAt}>{formatDateLong(detail.nextAttemptAt)}</time>
					</DlRow>
				) : null}
				{detail.messageId ? <DlRow label="Message ID">{detail.messageId}</DlRow> : null}
			</dl>

			{detail.attempts.length > 0 ? (
				<section className="mt-6 space-y-2" aria-label="История попыток">
					<h3 className="text-sm font-medium">История попыток</h3>
					<ul className="space-y-2">
						{detail.attempts.map((attempt) => (
							<li key={`${attempt.at}-${attempt.kind}`} className="rounded-md border p-3 text-sm">
								<div className="flex items-center gap-2">
									<AttemptBadge kind={attempt.kind} />
									<time dateTime={attempt.at} className="text-xs text-muted-foreground">
										{formatDateLong(attempt.at)}
									</time>
								</div>
								{attempt.reason ? (
									<p className="mt-1 text-xs text-muted-foreground">{attempt.reason}</p>
								) : null}
							</li>
						))}
					</ul>
				</section>
			) : null}

			{retry.isError ? (
				<Alert variant="destructive" role="alert" className="mt-4">
					<AlertTitle>Не удалось повторить отправку</AlertTitle>
					<AlertDescription>
						{retry.error instanceof Error ? retry.error.message : 'Неизвестная ошибка'}
					</AlertDescription>
				</Alert>
			) : null}

			<section className="mt-6 flex gap-2" aria-label="Действия">
				{gate.enabled ? (
					<Button onClick={() => retry.mutate(id)} disabled={retry.isPending}>
						{retry.isPending ? 'Повторяем…' : 'Повторить отправку'}
					</Button>
				) : (
					<RbacButton can={false} deniedReason={gate.reason ?? 'Недоступно'}>
						Повторить отправку
					</RbacButton>
				)}
				<Button variant="outline" onClick={onClose}>
					Закрыть
				</Button>
			</section>

			<details className="mt-6">
				<summary className="cursor-pointer text-sm font-medium">Payload (JSON)</summary>
				<pre className="mt-2 overflow-x-auto rounded-md bg-muted p-3 text-xs">
					{JSON.stringify(detail.notification.payloadJson, null, 2)}
				</pre>
			</details>
		</>
	)
}

function DlRow({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="grid grid-cols-[10rem_1fr] gap-2 items-baseline">
			<dt className="text-muted-foreground">{label}</dt>
			<dd>{children}</dd>
		</div>
	)
}

function AttemptBadge({ kind }: { kind: 'sent' | 'transient_failure' | 'permanent_failure' }) {
	const conf = attemptBadgeConf(kind)
	return <Badge variant={conf.variant}>{conf.label}</Badge>
}
