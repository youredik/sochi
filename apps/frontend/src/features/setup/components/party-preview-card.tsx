import type { DaDataParty, PartyStatus, TaxRegime } from '../lib/dadata.ts'

const STATUS_LABELS: Record<PartyStatus, string> = {
	ACTIVE: 'Действующая',
	LIQUIDATING: 'В стадии ликвидации',
	LIQUIDATED: 'Ликвидирована',
	REORGANIZING: 'Реорганизация',
	UNKNOWN: 'Статус не указан',
}

const TAX_REGIME_LABELS: Record<TaxRegime, string> = {
	NPD: 'НПД (самозанятый)',
	USN_DOHODY: 'УСН «Доходы» (6%)',
	USN_DOHODY_RASHODY: 'УСН «Доходы − расходы» (15%)',
	PSN: 'Патент',
	OSN: 'ОСНО',
	AUSN_DOHODY: 'АУСН «Доходы» (8%)',
	AUSN_DOHODY_RASHODY: 'АУСН «Доходы − расходы» (20%)',
	UNKNOWN: 'Налоговый режим не указан',
}

interface PartyPreviewCardProps {
	party: DaDataParty
}

/**
 * Read-only preview shown on Screen 1 after DaData returns a record.
 * Surfaces the four user-facing fields that actually matter for the next
 * step: legal name, full address, tax regime (drives later fiscalization
 * branching), and the registration status — `LIQUIDATED`/`LIQUIDATING`
 * are visually flagged so the operator notices before clicking forward.
 */
export function PartyPreviewCard({ party }: PartyPreviewCardProps) {
	const liquidated = party.status === 'LIQUIDATED' || party.status === 'LIQUIDATING'

	return (
		<aside
			aria-label="Найденная организация"
			className={
				liquidated
					? 'rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm'
					: 'rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm'
			}
		>
			<dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5">
				<dt className="text-muted-foreground">Название</dt>
				<dd className="font-medium">{party.name}</dd>

				<dt className="text-muted-foreground">ИНН</dt>
				<dd className="font-mono">{party.inn}</dd>

				{party.ogrn ? (
					<>
						<dt className="text-muted-foreground">
							{party.legalForm === 'INDIVIDUAL' ? 'ОГРНИП' : 'ОГРН'}
						</dt>
						<dd className="font-mono">{party.ogrn}</dd>
					</>
				) : null}

				<dt className="text-muted-foreground">Город</dt>
				<dd>{party.city || '—'}</dd>

				<dt className="text-muted-foreground">Адрес</dt>
				<dd className="text-muted-foreground/90">{party.address}</dd>

				<dt className="text-muted-foreground">Налог. режим</dt>
				<dd>{TAX_REGIME_LABELS[party.taxRegime]}</dd>

				<dt className="text-muted-foreground">Статус</dt>
				<dd className={liquidated ? 'font-medium text-destructive' : ''}>
					{STATUS_LABELS[party.status]}
				</dd>
			</dl>
		</aside>
	)
}
