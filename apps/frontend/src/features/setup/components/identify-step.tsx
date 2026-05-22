import { useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useActiveOrg } from '@/features/tenancy/hooks/use-active-org'
import { authClient, sessionQueryOptions } from '@/lib/auth-client'
import { useFindByInn } from '../hooks/use-find-by-inn.ts'
import { useWizardStore } from '../wizard-store.ts'
import { PartyPreviewCard } from './party-preview-card.tsx'

const INN_REGEX = /^(\d{10}|\d{12})$/

/**
 * Screen 1 — ИНН identify. Three states:
 *   - empty input or invalid format → only Найти button
 *   - lookup returned party        → preview card + Подтвердить / Изменить вручную
 *   - lookup returned null         → «не нашли» banner + Заполнить вручную
 *
 * «Заполнить вручную» sets `manualOverride=true` and advances the wizard;
 * the inventory step lets the user type property name/address/city without
 * a DaData party.
 */
export function IdentifyStep() {
	const innId = useId()
	const [inn, setInn] = useState('')
	const find = useFindByInn()
	const queryClient = useQueryClient()
	const { active: activeOrg } = useActiveOrg()
	const setParty = useWizardStore((s) => s.setParty)
	const party = useWizardStore((s) => s.party)
	const manualOverride = useWizardStore((s) => s.manualOverride)
	const setManualOverride = useWizardStore((s) => s.setManualOverride)
	const setStep = useWizardStore((s) => s.setStep)

	const innValid = INN_REGEX.test(inn)
	const liquidated = party?.status === 'LIQUIDATED' || party?.status === 'LIQUIDATING'

	function handleLookup(e: FormEvent) {
		e.preventDefault()
		if (!innValid) return
		find.mutate(
			{ inn },
			{
				onSuccess: (data) => {
					setParty(data)
					setManualOverride(data === null)
				},
			},
		)
	}

	function handleManual() {
		setParty(null)
		setManualOverride(true)
		setStep('inventory')
	}

	/**
	 * Confirm DaData party → step 2. Side-effect: sync org.name → party.name
	 * whenever they differ. Earlier (2026-05-14) we gated rename behind
	 * «if activeOrg.name === DEFAULT_WELCOME_ORG_NAME» — это пропускало
	 * случай когда user в /welcome ввёл custom value (например ИНН вместо
	 * placeholder), и потом sidebar показывал «2310123920» при property
	 * header «ПАО СБЕРБАНК» — diverged identity. 2026-05-22 canon: DaData
	 * lookup ВСЕГДА выигрывает (single source of truth для legal entity
	 * name). User может позже rename через Профиль гостиницы если хочет
	 * brand label вместо legal name. Slug stays untouched (URL stability
	 * > display cleanliness mid-wizard).
	 *
	 * Fail-soft: a BA update error MUST NOT block the wizard. The user can
	 * always rename via Профиль гостиницы; aborting the step on rename
	 * failure trades a cosmetic mismatch для a hard onboarding stall.
	 */
	async function handleConfirm() {
		if (party && activeOrg && activeOrg.name !== party.name) {
			try {
				await authClient.organization.update({ data: { name: party.name } })
				await queryClient.invalidateQueries({ queryKey: ['auth', 'organizations'] })
				await queryClient.invalidateQueries({ queryKey: sessionQueryOptions.queryKey })
			} catch {
				// Cosmetic — user can rename later. Do not block onboarding.
			}
		}
		setStep('inventory')
	}

	return (
		<div className="space-y-6">
			<form
				onSubmit={handleLookup}
				className="space-y-4"
				noValidate
				aria-label="Поиск гостиницы по ИНН"
			>
				<div className="space-y-1.5">
					<Label htmlFor={innId}>ИНН гостиницы</Label>
					<Input
						id={innId}
						type="text"
						inputMode="numeric"
						pattern="\d{10}|\d{12}"
						autoComplete="off"
						placeholder="10 или 12 цифр"
						value={inn}
						onChange={(e) => setInn(e.target.value.replace(/\D/g, ''))}
						aria-invalid={inn.length > 0 && !innValid ? true : undefined}
					/>
					<p className="text-xs text-muted-foreground">
						10 цифр для ООО/АО, 12 цифр для ИП/самозанятых. Подставим название и адрес
						автоматически.
					</p>
				</div>

				<div className="flex gap-2">
					<Button type="submit" size="lg" disabled={!innValid || find.isPending}>
						{find.isPending ? 'Ищем…' : 'Найти'}
					</Button>
					<Button type="button" variant="ghost" size="lg" onClick={handleManual}>
						Заполнить вручную
					</Button>
				</div>
			</form>

			{find.isSuccess && party === null ? (
				<div
					role="status"
					aria-live="polite"
					className="rounded-lg border border-muted bg-muted/30 px-4 py-3 text-sm"
				>
					<p className="font-medium">Организация не найдена</p>
					<p className="mt-1 text-muted-foreground">
						DaData не вернула запись для этого ИНН. Заполните данные вручную — мы продолжим без
						автоподстановки.
					</p>
					<Button type="button" variant="outline" size="sm" className="mt-3" onClick={handleManual}>
						Заполнить вручную →
					</Button>
				</div>
			) : null}

			{party !== null && !manualOverride ? (
				<>
					<PartyPreviewCard party={party} />
					<div className="flex gap-2">
						<Button type="button" size="lg" onClick={handleConfirm} disabled={liquidated}>
							Подтвердить →
						</Button>
						<Button
							type="button"
							variant="outline"
							size="lg"
							onClick={() => {
								setParty(null)
								setManualOverride(true)
							}}
						>
							Изменить вручную
						</Button>
					</div>
					{liquidated ? (
						<p role="alert" className="text-sm text-destructive">
							Организация ликвидирована или находится в стадии ликвидации — онбординг невозможен.
							Используйте действующий ИНН.
						</p>
					) : null}
				</>
			) : null}
		</div>
	)
}
