/**
 * Admin channels query — calls `GET /api/admin/channels`.
 *
 * Returns channelConnection rows for current tenant, mapped to canonical
 * `ChannelOverlayRow` shape consumed by `<ChannelStatusOverlay>`.
 *
 * Stale strategy: 10s — sync status changes via dispatcher worker after each
 * dispatch outcome; admin overlay refresh взявается каждые 10s on focus.
 */

import { queryOptions } from '@tanstack/react-query'
import { api } from '../../../lib/api.ts'
import type { ChannelOverlayRow } from '../components/channel-status-overlay.tsx'

export const adminChannelsQueryOptions = () =>
	queryOptions({
		queryKey: ['admin', 'channels'] as const,
		queryFn: async (): Promise<ReadonlyArray<ChannelOverlayRow>> => {
			const res = await api.api.admin.channels.$get()
			if (!res.ok) {
				const status = (res as Response).status
				if (status === 403) throw new Error('Недостаточно прав для просмотра каналов')
				throw new Error(`admin channels HTTP ${status}`)
			}
			const body = (await res.json()) as { data: ReadonlyArray<ChannelOverlayRow> }
			return body.data
		},
		staleTime: 10_000,
		refetchOnWindowFocus: true,
		refetchInterval: 30_000, // poll every 30s — sync activity visible quickly
	})
