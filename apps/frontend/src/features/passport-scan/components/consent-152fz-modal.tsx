/**
 * 152-ФЗ согласие — Sprint C+ 2-checkbox model (post legal-expert audit 2026-05-23d).
 *
 * **Architectural shift from 3-checkbox to 2-checkbox**:
 * Round 4 had 3 checkboxes (generalPdn / citizenshipSpecial / biometricPhoto).
 * Legal expert REFUTED `citizenshipSpecial` ст.10 spec.category labeling: citizenship
 * (гражданство = country code) is NOT in ст.10 ч.1 verbatim list («расовая,
 * национальная принадлежность» = ethnic origin, different concept). Citizenship
 * processing falls under ст.6 общие ПДн. Mis-labeling = РКН inspection first hit.
 *
 * **Canonical model**:
 *   - `generalPdn` — ст.6 ч.1 общие ПДн (ФИО, паспорт, гражданство, период пребывания)
 *   - `biometricPhoto` — ст.11 ч.1 фото паспорта как documentary proof
 *
 * **Backward compatibility**:
 * Backend schema (vision.routes.ts) keeps `citizenshipSpecial` field as `.optional()`
 * so old clients sending 3 fields still validate. Legacy DB rows (pre-2026-05-23d)
 * with all-3-true persist; parseSeparateConsents in photo-consent-log.repo.ts tolerates
 * the legacy field. New payloads from this modal send only 2 fields.
 *
 * **Legal context per 5-expert audit 2026-05-23**:
 *   - 156-ФЗ от 24.06.2025 (effective 01.09.2025): consent MUST be standalone
 *     document (NOT bundled с TOS). This modal IS standalone — only consent text +
 *     checkboxes, no TOS/Privacy click hijacked.
 *   - КоАП ст.13.11 ч.17 биометрия: 15-20 млн ₽ юр.лиц (ред. 420-ФЗ от 30.11.2024;
 *     not 421-ФЗ which was about УК). ч.18 повторно: оборотный 1-3%, 25-500 млн.
 *   - ст.21 ч.5 152-ФЗ: destruction within **30 days** after revocation (NOT 10;
 *     ст.21 ч.3's 10 раб.дней is for "неправомерная обработка" — different scenario).
 *
 * UX patterns applied:
 *   - Both required, submit disabled until все 2 checked
 *   - Scrollable consent text (WCAG-friendlier)
 *   - textSnapshot passed upstream via onAccept callback (152-ФЗ ст.9 ч.4 proof)
 *
 * a11y:
 *   - Radix Dialog focus-trap + Esc close built-in
 *   - 2 separate checkboxes с своими Label + htmlFor
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

/**
 * Sprint C+ 2-checkbox payload (legal-expert audit fix).
 *
 * Backend schema accepts `citizenshipSpecial?: true` as legacy-optional;
 * new payloads omit it. Both shapes validate.
 */
export interface Consent152FzAcceptPayload {
	readonly acceptedAt: string
	readonly version: string
	readonly textSnapshot: string
	readonly separateConsents: {
		readonly generalPdn: true
		readonly biometricPhoto: true
	}
}

/**
 * 152-ФЗ ст.9 ч.4 identification per legal expert audit:
 * required by law = `legalName` + `address`. `inn` + `dpoEmail` recommended by РКН
 * practice but NOT statutory mandate (DPO contact is ст.22.1 РКН-notification scope,
 * not consent-text scope).
 */
export interface OperatorIdentity {
	readonly legalName: string
	readonly inn?: string | null
	readonly legalAddress?: string | null
	readonly dpoEmail?: string | null
}

/**
 * Render operator identification block для consent text. Per 152-ФЗ ст.9 ч.4:
 * subject должен знать, КОМУ он даёт согласие.
 */
function renderOperatorBlock(identity: OperatorIdentity | undefined): string {
	if (!identity) {
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
(в действующей редакции, включая № 23-ФЗ от 28.02.2025 и № 156-ФЗ от 24.06.2025,
вступившие в силу 01.07.2025 и 01.09.2025 соответственно) даю отдельное согласие
на обработку моих персональных данных оператору-средству размещения, указанному ниже.

0. Идентификация оператора (152-ФЗ ст.9 ч.4):
${renderOperatorBlock(identity)}

1. Цели обработки:
   • Постановка на миграционный учёт по месту пребывания согласно
     Федеральному закону № 109-ФЗ «О миграционном учёте иностранных
     граждан и лиц без гражданства в Российской Федерации» и
     Постановлению Правительства РФ № 9 от 15.01.2007 (с 01.03.2026 —
     Постановление Правительства РФ № 1912 от 27.11.2025, действует
     до 01.03.2032).
   • Передача данных в МВД РФ через Государственную систему миграционного
     и регистрационного учёта (ГС МИР).
   • Аудит обработки персональных данных согласно 152-ФЗ ст.21 ч.4.

2. Состав обрабатываемых данных (общие ПДн под ст.6 ч.1 152-ФЗ):
   • ФИО, дата рождения, серия/номер документа, дата выдачи, кем выдан,
     дата окончания действия (для загранпаспорта/ВУ), гражданство (код
     страны по ISO 3166-1), период пребывания.
   • Гражданство = код страны выдачи документа (это общие ПДн под ст.6,
     НЕ спецкатегория ст.10 — ст.10 ч.1 152-ФЗ verbatim относится к
     национальной принадлежности (этническому происхождению), что мы НЕ
     собираем и НЕ обрабатываем).
   • Хранение фотографии страницы паспорта обрабатывается отдельно
     под ст.11 152-ФЗ (см. п.3 и второе согласие ниже).

3. Хранение скан-копии документа (152-ФЗ ст.11 — отдельное согласие):
   • Изображение документа загружается в объектное хранилище в РФ
     (152-ФЗ ст.18 ч.5 в ред. № 23-ФЗ от 28.02.2025, вступ. 01.07.2025
     — локализация ПДн в РФ) с серверным шифрованием at-rest.
   • Доступ к изображению только для аудиторских проверок Роскомнадзора
     и МВД РФ; автоматическое распознавание лица НЕ выполняется.
   • Срок хранения изображения: 90 дней (lifecycle policy объектного
     хранилища) — минимальный срок для МВД-аудита. По истечении срока
     хранения изображение автоматически удаляется.

4. Способы обработки: автоматизированная и неавтоматизированная.

5. Сроки хранения по типам данных (152-ФЗ ст.5 ч.7 «не дольше необходимого»):
   • Изображение документа: 90 дней (см. п.3).
   • Структурированные текстовые данные (ФИО, серия/номер, даты,
     гражданство): до отзыва согласия или 5 лет с даты последнего
     взаимодействия — обоснование в политике обработки оператора
     (152-ФЗ ст.5 ч.7 + миграционное законодательство).
   • Журнал согласий (photoConsentLog): 5 лет — proof для аудита РКН
     (152-ФЗ ст.21 ч.4).

6. Право отзыва согласия (152-ФЗ ст.20 + ст.21 ч.5):
   Вы вправе отозвать настоящее согласие в любой момент письменным
   заявлением оператору средства размещения (ст.20 152-ФЗ). После
   получения заявления оператор обязан прекратить обработку и уничтожить
   ваши персональные данные в течение **30 дней** (152-ФЗ ст.21 ч.5).
   Если уничтожение технически невозможно — данные блокируются на
   6 месяцев с последующим уничтожением (ст.21 ч.5).

7. Право на ознакомление (152-ФЗ ст.14):
   Вы вправе получить выгрузку всех обрабатываемых о вас данных
   в течение 10 рабочих дней с момента запроса (ст.14 152-ФЗ).

8. Контроль и ответственность оператора:
   Нарушение требований 152-ФЗ — административная ответственность по
   ст.13.11 КоАП РФ (в ред. № 420-ФЗ от 30.11.2024, вступ. 30.05.2025).
   В частности: ч.17 — за нарушения с биометрией штраф для юр.лиц от
   15 до 20 млн ₽; ч.18 — повторное нарушение — оборотный штраф 1-3%
   от совокупной выручки (минимум 25 млн ₽, максимум 500 млн ₽).

Версия документа: ${CONSENT_152FZ_VERSION}.
`
}

export function Consent152FzModal({
	open,
	onAccept,
	onCancel,
	operatorIdentity,
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
}) {
	const consentText = buildConsentText(operatorIdentity)
	const titleId = useId()
	const descId = useId()
	const generalPdnId = useId()
	const biometricId = useId()
	const [generalPdn, setGeneralPdn] = useState(false)
	const [biometricPhoto, setBiometricPhoto] = useState(false)

	const allChecked = generalPdn && biometricPhoto

	const handleAccept = () => {
		if (!allChecked) return
		onAccept({
			acceptedAt: new Date().toISOString(),
			version: CONSENT_152FZ_VERSION,
			textSnapshot: consentText.trim(),
			separateConsents: {
				generalPdn: true,
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
						отдельный документ для общих ПДн и хранения фотографии паспорта.
					</DialogDescription>
				</DialogHeader>
				{/*
				 * WCAG 2.1.1: scrollable consent text keyboard accessible.
				 * <article> semantic element accepts tabIndex={0} for arrow-key scroll.
				 */}
				<article
					className="flex-1 overflow-y-auto border rounded-md p-4 text-sm whitespace-pre-line bg-muted/30 focus-visible:ring-3 focus-visible:ring-ring outline-none [scroll-margin-bottom:5rem]"
					// biome-ignore lint/a11y/noNoninteractiveTabindex: WCAG 2.1.1 mandates keyboard scroll access на legal consent text
					tabIndex={0}
					aria-label="Текст согласия на обработку персональных данных"
				>
					{consentText}
				</article>
				<fieldset className="mt-4 space-y-3">
					<legend className="sr-only">Согласия на обработку данных</legend>

					<div className="flex items-start gap-3 min-h-11 [scroll-margin-bottom:5rem]">
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
							ФИО, серии/номера паспорта, дат выдачи, гражданства (код страны), периода пребывания.
						</Label>
					</div>

					<div className="flex items-start gap-3 min-h-11 [scroll-margin-bottom:5rem]">
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
							<strong>Хранение фотографии паспорта (ст.11 152-ФЗ)</strong> — даю отдельное согласие
							на хранение фотографии страницы паспорта как documentary proof для аудиторских
							проверок МВД РФ. Лицо НЕ распознаётся автоматически.
						</Label>
					</div>
				</fieldset>
				{/*
				 * Review-before-Submit summary (WCAG 3.3.4 Error Prevention Legal/Financial).
				 * 152-ФЗ consent = legal commitment. Live region announces к screen readers.
				 */}
				<output
					aria-live="polite"
					aria-atomic="true"
					className="mt-3 text-xs text-muted-foreground border-t pt-3"
				>
					{allChecked ? (
						<span>
							<strong>Готово к подтверждению:</strong> вы согласны на (1) обработку общих ПДн ст.6 и
							(2) хранение фотографии паспорта ст.11.
						</span>
					) : (
						<span>
							Отметьте оба согласия (выше) для активации кнопки «Подтвердить». Подтверждено сейчас:{' '}
							{[generalPdn, biometricPhoto].filter(Boolean).length} из 2.
						</span>
					)}
				</output>
				<DialogFooter className="mt-4 sm:justify-between sticky bottom-0 bg-background pt-3 border-t [padding-bottom:max(0.75rem,env(safe-area-inset-bottom))]">
					<Button variant="outline" onClick={onCancel}>
						Отклонить
					</Button>
					<Button onClick={handleAccept} disabled={!allChecked} variant="default">
						Подтвердить оба согласия
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
