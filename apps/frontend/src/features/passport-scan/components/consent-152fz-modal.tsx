/**
 * 152-ФЗ согласие на обработку персональных данных — separate modal.
 *
 * Per `project_m8_a_6_ui_canonical.md` + 2025-09-01 152-ФЗ update:
 *   - Согласие должно быть SEPARATE document (НЕ checkbox в общем UA)
 *   - Specific + substantive + informed + conscious + unambiguous
 *   - Penalties up to 700 000 ₽ (Roskomnadzor 2025+)
 *   - Roskomnadzor inspections increased
 *
 * UX pattern (Альфа-Банк / Сбер / Тинькофф canonical):
 *   - Modal с full legal text scrollable
 *   - Specific goals: «Передача персональных данных в МВД РФ для миграционного
 *     учёта по Постановлению №1668»
 *   - Explicit `<input type="checkbox" required>` — NOT pre-checked
 *   - Accept button disabled до checkbox
 *   - On accept: caller logs timestamp + IP в guestDocument.photoConsentLogId
 *   - Cached per-guest: показывать ONCE per guest
 *
 * a11y:
 *   - Radix Dialog → focus-trap + Esc close built-in
 *   - role="dialog" + aria-labelledby
 *   - <h2> для title с id для aria-labelledby
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

const CONSENT_TEXT = `
В соответствии с Федеральным законом от 27.07.2006 № 152-ФЗ «О персональных данных»
(в редакции от 24.06.2025) даю согласие на обработку моих персональных данных
средству размещения и его операторам в следующем объёме:

1. Цели обработки:
   • Постановка на миграционный учёт по месту пребывания через ЕПГУ
     (Постановление Правительства РФ № 1668 от 15.10.2024 / редакция 27.10.2025).
   • Передача данных в МВД РФ через Государственную систему миграционного
     и регистрационного учёта (ГС МИР).
   • Хранение скан-копий документов для аудиторских проверок Роскомнадзора и МВД.

2. Состав обрабатываемых данных:
   • ФИО, дата рождения, гражданство.
   • Серия, номер документа, кем и когда выдан.
   • Период пребывания (даты заезда / выезда).
   • Скан-копия документа в Object Storage (зашифровано at-rest).

3. Способы обработки: автоматизированная и неавтоматизированная.

4. Срок хранения: до отзыва согласия или истечения 5 лет с даты последнего
   взаимодействия (по требованиям 152-ФЗ + миграционного законодательства).

5. Право отзыва: вы можете отозвать настоящее согласие в любой момент
   через мобильное приложение «Госуслуги» (реестр согласий, доступен с 2026-03)
   или письменным заявлением оператору.

Версия документа: ${CONSENT_152FZ_VERSION}.
`

export function Consent152FzModal({
	open,
	onAccept,
	onCancel,
}: {
	open: boolean
	onAccept: () => void
	onCancel: () => void
}) {
	const titleId = useId()
	const descId = useId()
	const checkboxId = useId()
	const [accepted, setAccepted] = useState(false)

	return (
		<Dialog open={open} onOpenChange={(o) => (o ? null : onCancel())}>
			<DialogContent className="max-w-2xl max-h-[90vh] flex flex-col" aria-labelledby={titleId}>
				<DialogHeader>
					<DialogTitle id={titleId}>Согласие на обработку персональных данных</DialogTitle>
					<DialogDescription id={descId}>
						Согласно Федеральному закону № 152-ФЗ «О персональных данных» (отдельный документ с
						01.09.2025).
					</DialogDescription>
				</DialogHeader>
				<div className="flex-1 overflow-y-auto border rounded-md p-4 text-sm whitespace-pre-line bg-muted/30">
					{CONSENT_TEXT}
				</div>
				<div className="flex items-start gap-2 mt-4">
					<Checkbox
						id={checkboxId}
						checked={accepted}
						onCheckedChange={(v) => setAccepted(v === true)}
					/>
					<Label htmlFor={checkboxId} className="text-sm leading-tight cursor-pointer">
						Я ознакомлен(а) с условиями и даю согласие на обработку персональных данных гостя в
						указанных целях.
					</Label>
				</div>
				<DialogFooter className="mt-4 sm:justify-between">
					<Button variant="ghost" onClick={onCancel}>
						Отклонить
					</Button>
					<Button onClick={onAccept} disabled={!accepted} variant="default">
						Подтвердить согласие
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
