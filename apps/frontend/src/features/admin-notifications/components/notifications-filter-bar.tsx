/**
 * Filter bar для notifications outbox console — status / kind / recipient
 * / date range.
 *
 * URL state — parent route owns search params; this component just emits.
 */
import type { NotificationKind } from '@horeca/shared'
import { useId } from 'react'
import { Input } from '../../../components/ui/input.tsx'
import { Label } from '../../../components/ui/label.tsx'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '../../../components/ui/select.tsx'

export interface NotificationsFilterValue {
	status: 'pending' | 'sent' | 'failed' | null
	kind: NotificationKind | null
	recipient: string | null
	from: string | null
	to: string | null
}

const ANY_VALUE = '__any__'

const STATUS_OPTIONS: { value: 'pending' | 'sent' | 'failed'; label: string }[] = [
	{ value: 'pending', label: 'В очереди' },
	{ value: 'sent', label: 'Отправлено' },
	{ value: 'failed', label: 'Ошибка' },
]

const KIND_OPTIONS: { value: NotificationKind; label: string }[] = [
	{ value: 'payment_succeeded', label: 'Платёж получен' },
	{ value: 'payment_failed', label: 'Платёж не прошёл' },
	{ value: 'receipt_confirmed', label: 'Чек ОФД' },
	{ value: 'receipt_failed', label: 'Ошибка чека' },
	{ value: 'booking_confirmed', label: 'Бронь подтверждена' },
	{ value: 'checkin_reminder', label: 'Напоминание о заезде' },
	{ value: 'review_request', label: 'Просьба об отзыве' },
]

export function NotificationsFilterBar({
	value,
	onChange,
}: {
	value: NotificationsFilterValue
	onChange: (next: NotificationsFilterValue) => void
}) {
	const statusId = useId()
	const kindId = useId()
	const recipientId = useId()
	const fromId = useId()
	const toId = useId()

	return (
		<div className="flex flex-wrap items-end gap-3">
			<div className="space-y-1">
				<Label htmlFor={statusId}>Статус</Label>
				<Select
					value={value.status ?? ANY_VALUE}
					onValueChange={(v) =>
						onChange({
							...value,
							status: v === ANY_VALUE ? null : (v as 'pending' | 'sent' | 'failed'),
						})
					}
				>
					<SelectTrigger id={statusId} className="w-40">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={ANY_VALUE}>Любой</SelectItem>
						{STATUS_OPTIONS.map((o) => (
							<SelectItem key={o.value} value={o.value}>
								{o.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			<div className="space-y-1">
				<Label htmlFor={kindId}>Тип</Label>
				<Select
					value={value.kind ?? ANY_VALUE}
					onValueChange={(v) =>
						onChange({
							...value,
							kind: v === ANY_VALUE ? null : (v as NotificationKind),
						})
					}
				>
					<SelectTrigger id={kindId} className="w-56">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={ANY_VALUE}>Любой</SelectItem>
						{KIND_OPTIONS.map((o) => (
							<SelectItem key={o.value} value={o.value}>
								{o.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			<div className="space-y-1">
				<Label htmlFor={recipientId}>Получатель</Label>
				<Input
					id={recipientId}
					type="email"
					placeholder="email@host"
					value={value.recipient ?? ''}
					onChange={(e) =>
						onChange({
							...value,
							recipient: e.target.value.trim() || null,
						})
					}
					className="w-56"
				/>
			</div>

			<div className="space-y-1">
				<Label htmlFor={fromId}>С даты</Label>
				<Input
					id={fromId}
					type="date"
					value={value.from ?? ''}
					onChange={(e) => onChange({ ...value, from: e.target.value || null })}
					className="w-40"
				/>
			</div>

			<div className="space-y-1">
				<Label htmlFor={toId}>По дату</Label>
				<Input
					id={toId}
					type="date"
					value={value.to ?? ''}
					onChange={(e) => onChange({ ...value, to: e.target.value || null })}
					className="w-40"
				/>
			</div>
		</div>
	)
}
