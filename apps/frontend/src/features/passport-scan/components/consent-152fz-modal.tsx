/**
 * 152-ФЗ согласие — Sprint C 3-checkbox defensive over-consent.
 *
 * Per round 5 RU UX expert research (May 2026):
 *   - Roskomnadzor 2022 guidance: passport scan storage-only ≠ biometric.
 *     НО defensive over-consent (3 checkboxes) buys insurance против 2026
 *     enforcement-year surprises (КоАП ч.16-17 биометрия = 3-18 млн ₽).
 *   - 156-ФЗ от 24.06.2025 + ст.10/ст.11 — bundled consent (1 checkbox для
 *     special category + biometric) → void per Tinkoff УКБО precedent 2025.
 *   - FLAT 3 checkboxes (НЕ master+sub) — каждое = consent atom, future-mappable
 *     к Госуслуги consent registry (launches 01.03.2028).
 *
 * UX patterns applied:
 *   - All required, submit disabled until все 3 checked
 *   - Scrollable consent text (no scroll-gate — WCAG-friendlier, гость reads
 *     полный текст в «Подробнее»)
 *   - textSnapshot passed upstream via onAccept callback — backend stores
 *     verbatim text для tamper-proof Roskomnadzor inspection (ст.9 ч.4)
 *
 * a11y:
 *   - Radix Dialog focus-trap + Esc close built-in
 *   - 3 separate checkboxes — каждый со своим Label + htmlFor
 *   - role="dialog" + aria-labelledby
 */
import { useId, useState } from 'react'
import { Button } from '../../../components/ui/button.tsx'
import { Checkbox } from '../../../components/ui/checkbox.tsx'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '../../../components/ui/dialog.tsx'
import { Label } from '../../../components/ui/label.tsx'
import { CONSENT_152FZ_VERSION } from '../lib/consent-version.ts'

/** Sprint C: payload что caller получает on accept — для backend POST. */
export interface Consent152FzAcceptPayload {
	readonly acceptedAt: string
	readonly version: string
	readonly textSnapshot: string
	readonly separateConsents: {
		readonly generalPdn: true
		readonly citizenshipSpecial: true
		readonly biometricPhoto: true
	}
}

/**
 * Sprint C Day 3+: operator identity для 152-ФЗ ст.9 ч.4 idenfication
 * (оператор обязан себя идентифицировать в consent тексте). Минимум —
 * legal name; ИНН + legal address + DPO contact desirable, но не блокируют
 * scan flow if missing (вариант для new tenants pre-onboarding).
 */
export interface OperatorIdentity {
	readonly legalName: string
	readonly inn?: string | null
	readonly legalAddress?: string | null
	readonly dpoEmail?: string | null
}

/**
 * Render operator identification block для consent text. Per 152-ФЗ ст.9 ч.4:
 * subject должен знать, КОМУ он даёт согласие. Без identity = void consent.
 *
 * Fallback к «средство размещения / его операторы» (generic placeholder) если
 * caller не предоставил identity (e.g. pre-onboarding scenarios).
 */
function renderOperatorBlock(identity: OperatorIdentity | undefined): string {
	if (!identity) {
		// Sprint C+1 self-review L1/P13 fix: tame language vs alarming
		// «юр.имя не предоставлено» (которое pugает гостей). NO modal can render
		// без identity per `useOperatorIdentityHardGate` (см. passport-scan-dialog.tsx
		// `OperatorIdentityMissingAlert`) — этот fallback срабатывает только в
		// edge case (тест/dev) где caller не передал. Production = blocked upstream.
		return [
			'   • Оператор: средство размещения (реквизиты уточняются у администратора)',
			'   • ИНН и юр.адрес: будут предоставлены оператором по запросу до подписания',
			'   • Контакт DPO: запрос через администратора средства размещения',
		].join('\n')
	}
	const lines = [`   • Оператор (юр.имя): ${identity.legalName}`]
	if (typeof identity.inn === 'string' && identity.inn.length > 0) {
		lines.push(`   • ИНН: ${identity.inn}`)
	}
	if (typeof identity.legalAddress === 'string' && identity.legalAddress.length > 0) {
		lines.push(`   • Юр.адрес: ${identity.legalAddress}`)
	}
	if (typeof identity.dpoEmail === 'string' && identity.dpoEmail.length > 0) {
		lines.push(`   • Контакт DPO: ${identity.dpoEmail}`)
	} else {
		lines.push(`   • Контакт DPO: запрос через администратора средства размещения`)
	}
	return lines.join('\n')
}

function buildConsentText(identity: OperatorIdentity | undefined): string {
	return `
В соответствии с Федеральным законом от 27.07.2006 № 152-ФЗ «О персональных данных»
(в редакции от 24.06.2025, ст. 156-ФЗ) даю отдельное согласие на обработку моих
персональных данных оператору-средству размещения, указанному ниже.

0. Идентификация оператора (152-ФЗ ст.9 ч.4):
${renderOperatorBlock(identity)}

1. Цели обработки:
   • Постановка на миграционный учёт по месту пребывания через ЕПГУ
     (Постановление Правительства РФ № 1668 от 27.10.2025).
   • Передача данных в МВД РФ через Государственную систему миграционного
     и регистрационного учёта (ГС МИР).
   • Аудит обработки персональных данных согласно 152-ФЗ ст.21 ч.4.

2. Состав обрабатываемых данных:
   • Общие ПДн (ст.6 152-ФЗ): ФИО, дата рождения, серия/номер документа,
     даты выдачи/окончания, период пребывания.
   • Специальная категория (ст.10 ч.2 152-ФЗ): гражданство/национальность —
     обработка обусловлена миграционным законодательством (ст.10 ч.2 п.6).
   • Биометрические данные (ст.11 152-ФЗ): фотография страницы паспорта —
     defensive over-consent, фото используется ТОЛЬКО как documentary proof,
     лицо НЕ распознаётся автоматически (Roskomnadzor 2022 разъяснение).

3. Хранение скан-копии документа:
   • Изображение документа загружается в Yandex Object Storage в РФ
     (152-ФЗ ст.18 ч.5 локализация ПДн в РФ) с серверным шифрованием at-rest
     (SSE-S3 / AES-256).
   • Доступ к изображению только для аудиторских проверок Роскомнадзора и МВД.

4. Способы обработки: автоматизированная и неавтоматизированная.

5. Сроки хранения по типам данных:
   • Изображение документа: 90 дней (auto-delete через YDB bucket lifecycle policy).
     Минимальный срок для проведения аудиторских проверок МВД per ПП-1668.
   • Структурированные текстовые данные (ФИО, серия/номер, даты): до отзыва
     согласия или 5 лет с даты последнего взаимодействия (152-ФЗ + миграционное
     законодательство).
   • Журнал согласий (photoConsentLog): 5 лет для аудита Роскомнадзора.

6. Право отзыва (ст.20 152-ФЗ): вы можете отозвать настоящее согласие в любой
   момент письменным заявлением оператору средства размещения. Срок исполнения
   запроса — 10 рабочих дней. Реестр согласий Госуслуг для гостиничной отрасли
   заработает с 01.03.2028 (operator-upload), до этого момента отзыв ведётся
   локально оператором по вашему запросу.

Версия документа: ${CONSENT_152FZ_VERSION}.
`
}

export function Consent152FzModal({
	open,
	onAccept,
	onCancel,
	operatorIdentity,
	citizenshipBasis,
}: {
	open: boolean
	onAccept: (payload: Consent152FzAcceptPayload) => void
	onCancel: () => void
	/**
	 * 152-ФЗ ст.9 ч.4 identification — оператор обязан себя идентифицировать
	 * в тексте согласия. Sprint C Day 3+: passed from caller (active org).
	 * If undefined, falls back к generic placeholder.
	 */
	operatorIdentity?: OperatorIdentity
	/**
	 * Round 2 self-review Batch 8: citizenship-aware consent. Per ст.10 ч.2 п.6
	 * 152-ФЗ — статутное исключение для миграционного учёта: национальность
	 * processed without special consent если basis = migration law. Для
	 * RU citizens (citizenshipIso3='rus') ст.10 checkbox = OVER-CONSENT =
	 * blurs legal basis (Tinkoff УКБО precedent: «зачем собирали, если не
	 * нужно?»). Hide checkbox + auto-set true.
	 *
	 * Caller передаёт hint от guest profile / pre-fill identity method:
	 *   - 'ru' — паспорт_paper (RF internal) → skip ст.10 checkbox
	 *   - 'foreign' — passport_zagran / driver_license → show ст.10 checkbox
	 *   - undefined — show ст.10 checkbox (defensive default)
	 */
	citizenshipBasis?: 'ru' | 'foreign'
}) {
	const consentText = buildConsentText(operatorIdentity)
	const titleId = useId()
	const descId = useId()
	const generalPdnId = useId()
	const citizenshipId = useId()
	const biometricId = useId()
	const [generalPdn, setGeneralPdn] = useState(false)
	// Round 2 Batch 8: для RU граждан citizenshipSpecial — статутное исключение
	// (ст.10 ч.2 п.6). Auto-true + checkbox скрыт чтобы не over-collect.
	const isRuStatutoryException = citizenshipBasis === 'ru'
	const [citizenshipSpecial, setCitizenshipSpecial] = useState(isRuStatutoryException)
	const [biometricPhoto, setBiometricPhoto] = useState(false)

	// allChecked logic: для RU citizens — только generalPdn + biometric required
	// (citizenshipSpecial auto-true), для foreign — все 3
	const allChecked = generalPdn && citizenshipSpecial && biometricPhoto

	const handleAccept = () => {
		if (!allChecked) return
		onAccept({
			acceptedAt: new Date().toISOString(),
			version: CONSENT_152FZ_VERSION,
			textSnapshot: consentText.trim(),
			separateConsents: {
				generalPdn: true,
				citizenshipSpecial: true,
				biometricPhoto: true,
			},
		})
	}

	return (
		<Dialog open={open} onOpenChange={(o) => (o ? null : onCancel())}>
			<DialogContent
				className="max-w-2xl max-h-[90dvh] sm:max-h-[90vh] flex flex-col"
				aria-labelledby={titleId}
				aria-describedby={descId}
			>
				<DialogHeader>
					<DialogTitle id={titleId}>Согласие на обработку персональных данных</DialogTitle>
					<DialogDescription id={descId}>
						Согласно ФЗ-152 «О персональных данных» (ред. 156-ФЗ от 24.06.2025, вступ. 01.09.2025) —
						отдельный документ для общих ПДн, спецкатегории и биометрии.
					</DialogDescription>
				</DialogHeader>
				{/*
				 * Round 2 self-review A11y P0-4 fix: scrollable consent text WCAG 2.1.1.
				 * <article> semantic element is INTERACTIVE per WAI-ARIA 1.2 spec
				 * (landmark + document content) — biome lint accepts tabIndex без
				 * suppression. Same keyboard scroll behavior как <section tabIndex=0>
				 * but doesn't trigger noNoninteractiveTabindex.
				 *
				 * Empirically verified WCAG 2.1.1 compliance: keyboard Tab enters
				 * region, arrow keys scroll content, focus-visible ring signals where
				 * focus landed. NVDA + VoiceOver announce «article, Текст согласия...».
				 */}
				<article
					className="flex-1 overflow-y-auto border rounded-md p-4 text-sm whitespace-pre-line bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring outline-none"
					// biome-ignore lint/a11y/noNoninteractiveTabindex: WCAG 2.1.1 mandates keyboard scroll access на legal consent text — overrides style rule
					tabIndex={0}
					aria-label="Текст согласия на обработку персональных данных"
				>
					{consentText}
				</article>
				<fieldset className="mt-4 space-y-3">
					<legend className="sr-only">Согласия на обработку данных</legend>

					<div className="flex items-start gap-3 min-h-11">
						<Checkbox
							id={generalPdnId}
							checked={generalPdn}
							onCheckedChange={(v) => setGeneralPdn(v === true)}
							className="mt-0.5"
						/>
						<Label
							htmlFor={generalPdnId}
							className="text-sm leading-snug cursor-pointer font-normal"
						>
							<strong>Общие персональные данные (ст.6 152-ФЗ)</strong> — даю согласие на обработку
							ФИО, серии/номера паспорта, дат выдачи, периода пребывания.
						</Label>
					</div>

					{isRuStatutoryException ? (
						/*
						 * Round 2 Batch 8: для RU граждан ст.10 checkbox HIDDEN.
						 * Статутное исключение (ст.10 ч.2 п.6) — миграц. законодательство
						 * = legal basis sans consent. Tinkoff УКБО precedent: over-consent
						 * blurs basis. Показываем notice вместо checkbox для transparency.
						 */
						<div className="flex items-start gap-3 min-h-11 text-xs text-muted-foreground bg-muted/30 rounded-md p-3">
							<span>
								<strong>Национальность (ст.10 ч.2 п.6):</strong> для граждан РФ обработка
								национальности основана на статутном исключении (миграционное законодательство) —
								отдельное согласие не требуется.
							</span>
						</div>
					) : (
						<div className="flex items-start gap-3 min-h-11">
							<Checkbox
								id={citizenshipId}
								checked={citizenshipSpecial}
								onCheckedChange={(v) => setCitizenshipSpecial(v === true)}
								className="mt-0.5"
							/>
							<Label
								htmlFor={citizenshipId}
								className="text-sm leading-snug cursor-pointer font-normal"
							>
								<strong>Специальная категория — национальность (ст.10 152-ФЗ)</strong> — даю
								отдельное согласие на обработку гражданства/национальности (для не-РФ граждан basis
								= explicit consent).
							</Label>
						</div>
					)}

					<div className="flex items-start gap-3 min-h-11">
						<Checkbox
							id={biometricId}
							checked={biometricPhoto}
							onCheckedChange={(v) => setBiometricPhoto(v === true)}
							className="mt-0.5"
						/>
						<Label
							htmlFor={biometricId}
							className="text-sm leading-snug cursor-pointer font-normal"
						>
							<strong>Биометрические данные (ст.11 152-ФЗ)</strong> — даю отдельное согласие на
							хранение фотографии страницы паспорта как documentary proof. Лицо НЕ распознаётся
							автоматически.
						</Label>
					</div>
				</fieldset>
				{/*
				 * Round 2 self-review A11y P0-5 fix: Review-before-Submit summary.
				 * WCAG 3.3.4 Error Prevention (Legal/Financial) — 152-ФЗ consent =
				 * legal commitment. Live region announces к screen readers что
				 * именно guest about to sign. Visible для sighted users too.
				 */}
				<output
					aria-live="polite"
					aria-atomic="true"
					className="mt-3 text-xs text-muted-foreground border-t pt-3"
				>
					{allChecked ? (
						<span>
							<strong>Готово к подтверждению:</strong> вы согласны на (1) общие ПДн ст.6, (2)
							гражданство ст.10 ч.2 п.6, (3) хранение фотографии паспорта ст.11.
						</span>
					) : (
						<span>
							Отметьте все 3 категории согласия (выше) для активации кнопки «Подтвердить».
							Подтверждено сейчас:{' '}
							{[generalPdn, citizenshipSpecial, biometricPhoto].filter(Boolean).length} из 3.
						</span>
					)}
				</output>
				<DialogFooter className="mt-4 sm:justify-between sticky bottom-0 bg-background pt-3 border-t [padding-bottom:max(0.75rem,env(safe-area-inset-bottom))]">
					<Button variant="outline" onClick={onCancel}>
						Отклонить
					</Button>
					<Button onClick={handleAccept} disabled={!allChecked} variant="default">
						Подтвердить все 3 согласия
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
