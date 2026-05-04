/**
 * Admin channel status overlay — M10 / A7.5.
 *
 * Per `plans/m10_canonical.md` §4 п.28 + Track A DoD #7:
 *   "Demo visualization shows fake sync с TL/YT/ETG visible на admin overlay"
 *
 * Renders 3 channel rows (TL/YT/ETG) с canonical badges:
 *   - Mode badge: mock | sandbox | live (D27 cache key dimension)
 *   - Status badge: idle | syncing | error | auto_disabled (D14)
 *   - Last-sync timestamp (CET formatted)
 *   - Connection error display (when syncStatus='error')
 *
 * Behaviour-faithful: same component renders для Mock + Sandbox + Live tenants;
 * data source via `channelConnections` prop.
 */

import type { ReactElement } from 'react'

export type ChannelMode = 'mock' | 'sandbox' | 'live'
export type ChannelSyncStatus = 'idle' | 'syncing' | 'error' | 'auto_disabled'

export interface ChannelOverlayRow {
	readonly channelId: 'TL' | 'YT' | 'ETG' | string
	readonly displayName: string
	readonly mode: ChannelMode
	readonly syncStatus: ChannelSyncStatus
	readonly lastSyncAt: string | null
	readonly errorMessage: string | null
	readonly isEnabled: boolean
}

export interface ChannelStatusOverlayProps {
	readonly connections: ReadonlyArray<ChannelOverlayRow>
	readonly nowMs?: () => number
}

const STATUS_LABELS: Record<ChannelSyncStatus, string> = {
	idle: 'В ожидании',
	syncing: 'Синхронизация',
	error: 'Ошибка',
	auto_disabled: 'Авто-отключено',
}

const MODE_LABELS: Record<ChannelMode, string> = {
	mock: 'Demo',
	sandbox: 'Sandbox',
	live: 'Live',
}

function formatLastSync(iso: string | null, nowMs: number): string {
	if (iso === null) return '—'
	const ms = new Date(iso).getTime()
	if (!Number.isFinite(ms)) return '—'
	const seconds = Math.max(0, Math.floor((nowMs - ms) / 1000))
	if (seconds < 60) return `${seconds}с назад`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}мин назад`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}ч назад`
	const days = Math.floor(hours / 24)
	return `${days}д назад`
}

export function ChannelStatusOverlay(props: ChannelStatusOverlayProps): ReactElement {
	const nowMs = props.nowMs?.() ?? Date.now()
	return (
		<section
			aria-label="Статус каналов дистрибуции"
			className="rounded-md border border-border bg-card p-4"
			data-testid="channel-status-overlay"
		>
			<header className="mb-3 flex items-baseline justify-between">
				<h3 className="font-semibold text-base">Каналы дистрибуции</h3>
				<span className="text-muted-foreground text-xs">
					{props.connections.length}{' '}
					{pluralRu(props.connections.length, 'канал', 'канала', 'каналов')}
				</span>
			</header>
			<ul className="space-y-2">
				{props.connections.map((connection) => (
					<ChannelOverlayItem
						key={`${connection.channelId}-${connection.mode}`}
						connection={connection}
						nowMs={nowMs}
					/>
				))}
			</ul>
		</section>
	)
}

function ChannelOverlayItem(props: {
	readonly connection: ChannelOverlayRow
	readonly nowMs: number
}): ReactElement {
	const { connection } = props
	return (
		<li
			data-testid={`channel-row-${connection.channelId}`}
			data-mode={connection.mode}
			data-sync-status={connection.syncStatus}
			className="flex flex-wrap items-center gap-2 rounded-sm border border-border/50 bg-background p-3"
		>
			<span className="font-medium text-sm" data-testid={`channel-name-${connection.channelId}`}>
				{connection.displayName}
			</span>
			<ModeBadge mode={connection.mode} />
			<SyncStatusBadge status={connection.syncStatus} />
			<span
				className="ml-auto text-muted-foreground text-xs"
				data-testid={`channel-last-sync-${connection.channelId}`}
			>
				{formatLastSync(connection.lastSyncAt, props.nowMs)}
			</span>
			{connection.errorMessage !== null ? (
				<p
					data-testid={`channel-error-${connection.channelId}`}
					role="alert"
					className="basis-full text-destructive text-xs"
				>
					{connection.errorMessage}
				</p>
			) : null}
		</li>
	)
}

function ModeBadge(props: { readonly mode: ChannelMode }): ReactElement {
	const label = MODE_LABELS[props.mode]
	const bg =
		props.mode === 'live'
			? 'bg-emerald-100 text-emerald-900'
			: props.mode === 'sandbox'
				? 'bg-amber-100 text-amber-900'
				: 'bg-slate-100 text-slate-900'
	return (
		<span
			data-testid={`channel-mode-badge-${props.mode}`}
			className={`rounded-sm px-2 py-0.5 font-medium text-xs ${bg}`}
		>
			{label}
		</span>
	)
}

function SyncStatusBadge(props: { readonly status: ChannelSyncStatus }): ReactElement {
	const label = STATUS_LABELS[props.status]
	const bg =
		props.status === 'idle'
			? 'bg-slate-100 text-slate-900'
			: props.status === 'syncing'
				? 'bg-blue-100 text-blue-900'
				: props.status === 'error'
					? 'bg-red-100 text-red-900'
					: 'bg-zinc-200 text-zinc-900'
	return (
		<span
			data-testid={`channel-status-badge-${props.status}`}
			className={`rounded-sm px-2 py-0.5 font-medium text-xs ${bg}`}
			role="status"
		>
			{label}
		</span>
	)
}

function pluralRu(n: number, one: string, few: string, many: string): string {
	const mod10 = n % 10
	const mod100 = n % 100
	if (mod10 === 1 && mod100 !== 11) return one
	if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
	return many
}
