/**
 * Migration registration detail Sheet (right-side drawer).
 *
 * Per `project_m8_a_6_ui_canonical.md`:
 *   - Status timeline (created → submitted → polled → finalized/cancelled)
 *   - Cancel button с reason TextField (RBAC manage gate)
 *   - operatorNote textarea (debounced autosave via patch mutation)
 *
 * a11y per `project_axe_a11y_gate.md`:
 *   - Sheet uses Radix Dialog → focus trap + Esc close built-in
 *   - role="dialog" + aria-labelledby
 *   - Form fields labelled
 *   - Live region для save status
 */
import type { MigrationRegistration } from '@horeca/shared'
import { useSuspenseQuery } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '../../../components/ui/alert.tsx'
import { Badge } from '../../../components/ui/badge.tsx'
import { Button } from '../../../components/ui/button.tsx'
import { Label } from '../../../components/ui/label.tsx'
import {
	ResponsiveSheet,
	ResponsiveSheetContent,
	ResponsiveSheetDescription,
	ResponsiveSheetHeader,
	ResponsiveSheetTitle,
} from '../../../components/ui/responsive-sheet.tsx'
import { Textarea } from '../../../components/ui/textarea.tsx'
import { formatDateShort } from '../../../lib/format-ru.ts'
import {
	PassportScanDialog,
	type PassportScanResult,
} from '../../passport-scan/components/passport-scan-dialog.tsx'
import {
	migrationRegistrationDetailQueryOptions,
	useCancelMigrationRegistration,
	usePatchMigrationRegistration,
} from '../hooks/use-migration-registrations.ts'
import { CHANNEL_LABEL_RU, statusBadgeFor } from '../lib/migration-status-labels.ts'

const NOTE_AUTOSAVE_DEBOUNCE_MS = 1500

export function MigrationRegistrationDetailSheet({
	id,
	canManage,
	onClose,
}: {
	id: string
	canManage: boolean
	onClose: () => void
}) {
	const { data } = useSuspenseQuery(migrationRegistrationDetailQueryOptions(id))
	return (
		<ResponsiveSheet open onOpenChange={(open) => (open ? null : onClose())}>
			<ResponsiveSheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
				<ResponsiveSheetHeader>
					<ResponsiveSheetTitle id={`mreg-detail-title-${id}`}>
						Регистрация {id}
					</ResponsiveSheetTitle>
					<ResponsiveSheetDescription>
						Миграционный учёт МВД через ЕПГУ • Бронирование {data.bookingId}
					</ResponsiveSheetDescription>
				</ResponsiveSheetHeader>
				<div className="mt-6 space-y-6">
					<RegistrationSummary row={data} />
					<RegistrationTimeline row={data} />
					{canManage ? (
						<>
							<OperatorNoteEditor row={data} />
							<RescanSection row={data} />
							{data.isFinal ? null : <CancelSection row={data} onCancelled={onClose} />}
						</>
					) : (
						<Alert>
							<AlertTitle>Только просмотр</AlertTitle>
							<AlertDescription>
								Для отзыва регистрации или редактирования заметки нужны права manager / owner.
							</AlertDescription>
						</Alert>
					)}
				</div>
			</ResponsiveSheetContent>
		</ResponsiveSheet>
	)
}

function RegistrationSummary({ row }: { row: MigrationRegistration }) {
	const status = statusBadgeFor(row.statusCode)
	return (
		<dl className="grid grid-cols-2 gap-3 text-sm">
			<dt className="text-muted-foreground">Статус</dt>
			<dd>
				<Badge variant={status.variant}>
					{status.icon ? <span aria-hidden="true">{status.icon} </span> : null}
					{status.label}
				</Badge>
			</dd>
			<dt className="text-muted-foreground">Канал</dt>
			<dd>
				<Badge variant="outline">{CHANNEL_LABEL_RU[row.epguChannel] ?? row.epguChannel}</Badge>
			</dd>
			<dt className="text-muted-foreground">ЕПГУ orderId</dt>
			<dd className="font-mono text-xs">{row.epguOrderId ?? '—'}</dd>
			<dt className="text-muted-foreground">Период</dt>
			<dd className="tabular-nums">
				{row.arrivalDate} → {row.departureDate}
			</dd>
			<dt className="text-muted-foreground">Гость</dt>
			<dd className="font-mono text-xs">{row.guestId}</dd>
			<dt className="text-muted-foreground">Документ</dt>
			<dd className="font-mono text-xs">{row.documentId}</dd>
			<dt className="text-muted-foreground">Попыток</dt>
			<dd className="tabular-nums">{row.retryCount}</dd>
			{row.reasonRefuse ? (
				<>
					<dt className="text-muted-foreground">Причина отказа</dt>
					<dd className="text-destructive text-sm">{row.reasonRefuse}</dd>
				</>
			) : null}
		</dl>
	)
}

interface TimelineEvent {
	label: string
	at: string | null
	severity: 'pending' | 'in_flight' | 'success' | 'error'
}

function RegistrationTimeline({ row }: { row: MigrationRegistration }) {
	const headingId = useId()
	const events: TimelineEvent[] = [
		{ label: 'Создано', at: row.createdAt, severity: 'success' },
		{ label: 'Отправлено в ЕПГУ', at: row.submittedAt, severity: 'in_flight' },
		{ label: 'Последний опрос', at: row.lastPolledAt, severity: 'pending' },
		{
			label: 'Финализировано',
			at: row.finalizedAt,
			severity: row.isFinal ? 'success' : 'pending',
		},
	]
	return (
		<section aria-labelledby={headingId}>
			<h3 id={headingId} className="text-sm font-medium mb-2">
				Хронология
			</h3>
			<ol className="space-y-2 text-sm border-l-2 border-muted pl-4">
				{events.map((e) => (
					<li key={e.label} className="relative">
						<span
							className={`absolute -left-[19px] top-1.5 h-2 w-2 rounded-full ${
								e.severity === 'success' && e.at
									? 'bg-primary'
									: e.severity === 'error'
										? 'bg-destructive'
										: 'bg-muted-foreground/30'
							}`}
							aria-hidden="true"
						/>
						<span className="text-muted-foreground">{e.label}: </span>
						<span className="tabular-nums">{e.at ? formatDateShort(e.at) : '—'}</span>
					</li>
				))}
			</ol>
		</section>
	)
}

function OperatorNoteEditor({ row }: { row: MigrationRegistration }) {
	const headingId = useId()
	const patchMut = usePatchMigrationRegistration()
	const [note, setNote] = useState(row.operatorNote ?? '')
	const [savedAt, setSavedAt] = useState<Date | null>(null)
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

	useEffect(() => {
		// Sync на server-state change (другая сессия редактировала)
		setNote(row.operatorNote ?? '')
	}, [row.operatorNote])

	useEffect(() => {
		const trimmed = note.trim()
		if (trimmed === (row.operatorNote ?? '').trim()) return
		if (timer.current) clearTimeout(timer.current)
		timer.current = setTimeout(() => {
			patchMut.mutate(
				{
					id: row.id,
					patch: { operatorNote: trimmed === '' ? null : trimmed },
				},
				{
					onSuccess: () => setSavedAt(new Date()),
				},
			)
		}, NOTE_AUTOSAVE_DEBOUNCE_MS)
		return () => {
			if (timer.current) clearTimeout(timer.current)
		}
		// patchMut intentionally excluded — stable reference
	}, [note, row.id, row.operatorNote, patchMut.mutate])

	return (
		<section aria-labelledby={headingId}>
			<div className="flex items-center justify-between mb-1.5">
				<Label htmlFor={`mreg-note-${row.id}`} id={headingId} className="text-sm font-medium">
					Заметка оператора
				</Label>
				<span
					className="text-xs text-muted-foreground"
					aria-live="polite"
					data-testid="note-save-status"
				>
					{patchMut.isPending
						? 'Сохранение...'
						: savedAt
							? `Сохранено ${formatDateShort(savedAt.toISOString())}`
							: ''}
				</span>
			</div>
			<Textarea
				id={`mreg-note-${row.id}`}
				value={note}
				onChange={(e) => setNote(e.target.value)}
				maxLength={2000}
				rows={3}
				placeholder="Контекст за регистрацией: причины manual override, замена документа, РКЛ ложное срабатывание..."
				aria-describedby={`mreg-note-help-${row.id}`}
			/>
			<p id={`mreg-note-help-${row.id}`} className="text-xs text-muted-foreground mt-1">
				Автосохранение через {Math.round(NOTE_AUTOSAVE_DEBOUNCE_MS / 1000)}с после редактирования.
				Макс 2000 символов.
			</p>
			{patchMut.isError ? (
				<Alert variant="destructive" className="mt-2">
					<AlertTitle>Ошибка сохранения</AlertTitle>
					<AlertDescription>{patchMut.error.message}</AlertDescription>
				</Alert>
			) : null}
		</section>
	)
}

function RescanSection({ row }: { row: MigrationRegistration }) {
	const headingId = useId()
	const [scanOpen, setScanOpen] = useState(false)
	const [lastScan, setLastScan] = useState<PassportScanResult | null>(null)

	return (
		<section aria-labelledby={headingId} className="border-t pt-4">
			<h3 id={headingId} className="text-sm font-medium mb-2">
				Пересканировать паспорт гостя
			</h3>
			<p className="text-xs text-muted-foreground mb-3">
				При обнаружении неточностей в данных гостя — повторное сканирование через Yandex Vision.
				152-ФЗ согласие требуется отдельно (separate document, 2025-09-01). Реальная интеграция с
				обновлением guestDocument lands в M9.
			</p>
			<Button variant="outline" onClick={() => setScanOpen(true)}>
				Открыть сканер
			</Button>
			{lastScan ? (
				<Alert className="mt-3">
					<AlertTitle>OCR данные получены</AlertTitle>
					<AlertDescription className="text-xs space-y-1 mt-1">
						<div>
							Гость: {lastScan.entities.surname} {lastScan.entities.name}{' '}
							{lastScan.entities.middleName ?? ''}
						</div>
						<div>
							Документ: {lastScan.entities.documentNumber} • {lastScan.entities.citizenshipIso3}
						</div>
						<div className="text-muted-foreground">
							Уверенность: {(lastScan.confidenceHeuristic * 100).toFixed(0)}% • outcome:{' '}
							{lastScan.outcome}
						</div>
						<div className="text-muted-foreground">
							152-ФЗ согласие v{lastScan.consent152fzVersion} от {lastScan.consent152fzAcceptedAt}
						</div>
						<div className="text-muted-foreground italic">
							Persistence в guestDocument deferred до M9 booking integration.
						</div>
					</AlertDescription>
				</Alert>
			) : null}
			<PassportScanDialog
				open={scanOpen}
				onClose={() => setScanOpen(false)}
				onSave={(result) => {
					setLastScan(result)
					setScanOpen(false)
				}}
				guestAlreadyConsentedToVersion={null}
			/>
			<input
				type="hidden"
				value={row.guestId}
				readOnly
				aria-hidden="true"
				data-testid={`rescan-guest-id-${row.id}`}
			/>
		</section>
	)
}

function CancelSection({
	row,
	onCancelled,
}: {
	row: MigrationRegistration
	onCancelled: () => void
}) {
	const headingId = useId()
	const cancelMut = useCancelMigrationRegistration()
	const [reason, setReason] = useState('')
	const [confirmOpen, setConfirmOpen] = useState(false)

	if (row.epguOrderId === null) {
		return (
			<Alert>
				<AlertTitle>Отозвать нельзя</AlertTitle>
				<AlertDescription>
					Регистрация ещё не отправлена в ЕПГУ (orderId не получен).
				</AlertDescription>
			</Alert>
		)
	}

	const reasonValid = reason.trim().length >= 5 && reason.trim().length <= 500

	return (
		<section aria-labelledby={headingId} className="border-t pt-4">
			<h3 id={headingId} className="text-sm font-medium mb-2 text-destructive">
				Отозвать регистрацию (legal action)
			</h3>
			<p className="text-xs text-muted-foreground mb-3">
				Отзыв уведомления в ЕПГУ — операторское действие с audit trail. Используйте при отмене
				бронирования, ложном РКЛ-срабатывании или некорректных данных. Reason 5..500 символов
				обязателен.
			</p>
			{!confirmOpen ? (
				<Button
					variant="outline"
					onClick={() => setConfirmOpen(true)}
					disabled={cancelMut.isPending}
				>
					Отозвать в ЕПГУ
				</Button>
			) : (
				<div className="space-y-2">
					<Label htmlFor={`mreg-cancel-reason-${row.id}`}>Причина отзыва</Label>
					<Textarea
						id={`mreg-cancel-reason-${row.id}`}
						value={reason}
						onChange={(e) => setReason(e.target.value)}
						minLength={5}
						maxLength={500}
						rows={3}
						placeholder="Бронирование отменено гостем, РКЛ false-positive разрешён..."
						aria-describedby={`mreg-cancel-help-${row.id}`}
					/>
					<p id={`mreg-cancel-help-${row.id}`} className="text-xs text-muted-foreground">
						Минимум 5 символов, максимум 500.
					</p>
					<div className="flex gap-2">
						<Button
							variant="destructive"
							disabled={!reasonValid || cancelMut.isPending}
							onClick={() => {
								cancelMut.mutate(
									{ id: row.id, reason: reason.trim() },
									{ onSuccess: () => onCancelled() },
								)
							}}
						>
							{cancelMut.isPending ? 'Отзываем...' : 'Подтвердить отзыв'}
						</Button>
						<Button
							variant="ghost"
							onClick={() => {
								setConfirmOpen(false)
								setReason('')
							}}
							disabled={cancelMut.isPending}
						>
							Отменить
						</Button>
					</div>
				</div>
			)}
			{cancelMut.isError ? (
				<Alert variant="destructive" className="mt-2">
					<AlertTitle>Ошибка отзыва</AlertTitle>
					<AlertDescription>{cancelMut.error.message}</AlertDescription>
				</Alert>
			) : null}
		</section>
	)
}
