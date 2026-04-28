/**
 * Status badge mapping для ЕПГУ migration registration FSM.
 *
 * Maps EPGU_STATUS_CODES (14 codes) → { label, variant, severity }
 * для consistent rendering в admin table + detail sheet.
 *
 * Severity ordering для timeline visual: pending → in-flight → final.
 * Final states classified outcome-wise (success / refused / cancelled).
 */
import { EPGU_STATUS_CODES, EPGU_STATUS_LABELS_RU } from '@horeca/shared'

export type StatusBadgeVariant = 'outline' | 'secondary' | 'default' | 'destructive'

export interface StatusBadge {
	label: string
	variant: StatusBadgeVariant
	/** 'pending' | 'in_flight' | 'success' | 'refused' | 'cancelled' | 'error' */
	severity: 'pending' | 'in_flight' | 'success' | 'refused' | 'cancelled' | 'error'
	icon?: string
}

export function statusBadgeFor(statusCode: number): StatusBadge {
	const label = EPGU_STATUS_LABELS_RU[statusCode] ?? `Status ${statusCode}`
	switch (statusCode) {
		case EPGU_STATUS_CODES.draft:
			return { label, variant: 'outline', severity: 'pending', icon: '📝' }
		case EPGU_STATUS_CODES.registered:
		case EPGU_STATUS_CODES.sent_to_authority:
		case EPGU_STATUS_CODES.submitted:
		case EPGU_STATUS_CODES.acknowledged:
		case EPGU_STATUS_CODES.awaiting_info:
			return { label, variant: 'secondary', severity: 'in_flight', icon: '⏳' }
		case EPGU_STATUS_CODES.executed:
			return { label, variant: 'default', severity: 'success', icon: '✅' }
		case EPGU_STATUS_CODES.refused:
			return { label, variant: 'destructive', severity: 'refused', icon: '❌' }
		case EPGU_STATUS_CODES.send_error:
		case EPGU_STATUS_CODES.delivery_error:
		case EPGU_STATUS_CODES.processing_error:
		case EPGU_STATUS_CODES.requires_correction:
			return { label, variant: 'destructive', severity: 'error', icon: '⚠️' }
		case EPGU_STATUS_CODES.cancellation_pending:
			return { label, variant: 'secondary', severity: 'in_flight', icon: '🚫' }
		case EPGU_STATUS_CODES.cancelled:
			return { label, variant: 'outline', severity: 'cancelled', icon: '🚫' }
		default:
			return { label, variant: 'outline', severity: 'pending' }
	}
}

/** Russian channel labels для UI display. */
export const CHANNEL_LABEL_RU: Record<string, string> = {
	'gost-tls': 'ГОСТ TLS',
	svoks: 'СВОКС',
	'proxy-via-partner': 'Партнёр',
}
