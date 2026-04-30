/**
 * `<ConsentBlock>` — RU compliance consent UI for booking widget Screen 3.
 *
 * Per `plans/m9_widget_4_canonical.md` §8 hard-requirements:
 *   - 152-ФЗ ст. 22.1 + 156-ФЗ от 24.06.2025 separate-document canon —
 *     each consent has standalone wording, accessible через own ResponsiveSheet.
 *     NOT bundled в TOC, NOT a single «I agree to everything» checkbox.
 *   - ЗоЗПП ст. 16 ч. 3.1 (69-ФЗ от 07.04.2025) opt-in — checkboxes default
 *     unchecked; affirmative click required.
 *   - 152-ФЗ DPA = mandatory (booking blocked если не accepted).
 *   - 38-ФЗ marketing = optional (booking proceeds в любом case).
 *
 * Architectural choice: ResponsiveSheet (Sheet desktop / Vaul Drawer mobile)
 * для standalone reading. Inline checkboxes остаются в form. Click «Прочитать
 * полностью» opens overlay с full text — guest reads, dismisses, then ticks
 * checkbox.
 *
 * State: controlled — caller threads `acceptedDpa` / `acceptedMarketing` +
 * setters. Standalone-text overlay state local (open/close).
 */

import { useId, useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import {
	ResponsiveSheet,
	ResponsiveSheetContent,
	ResponsiveSheetDescription,
	ResponsiveSheetHeader,
	ResponsiveSheetTitle,
	ResponsiveSheetTrigger,
} from '@/components/ui/responsive-sheet'
import { CONSENT_VERSION, DPA_CONSENT_TEXT, MARKETING_CONSENT_TEXT } from '../lib/consent-texts.ts'

export interface ConsentBlockProps {
	readonly acceptedDpa: boolean
	readonly acceptedMarketing: boolean
	readonly onAcceptedDpaChange: (next: boolean) => void
	readonly onAcceptedMarketingChange: (next: boolean) => void
	/** Show error state on DPA checkbox (e.g., user tried submit без acceptance). */
	readonly dpaError?: boolean
}

export function ConsentBlock({
	acceptedDpa,
	acceptedMarketing,
	onAcceptedDpaChange,
	onAcceptedMarketingChange,
	dpaError = false,
}: ConsentBlockProps) {
	const dpaId = useId()
	const marketingId = useId()
	return (
		<fieldset
			className="space-y-4 rounded-lg border bg-card p-4 sm:p-5"
			data-testid="consent-block"
		>
			<legend className="px-1 text-sm font-medium text-foreground">Согласия</legend>

			<ConsentRow
				id={dpaId}
				accepted={acceptedDpa}
				onAcceptedChange={onAcceptedDpaChange}
				required
				error={dpaError}
				labelMain="Согласен на обработку персональных данных"
				labelMeta="Без принятия согласия бронирование невозможно (152-ФЗ)"
				readSheetTitle="Согласие на обработку персональных данных"
				readSheetDescription={`Версия ${CONSENT_VERSION} • Федеральный закон №152-ФЗ`}
				fullText={DPA_CONSENT_TEXT}
				testId="consent-dpa"
			/>

			<ConsentRow
				id={marketingId}
				accepted={acceptedMarketing}
				onAcceptedChange={onAcceptedMarketingChange}
				required={false}
				labelMain="Согласен на получение рекламы и спецпредложений"
				labelMeta="Можно отказаться в любой момент (38-ФЗ ст. 18). Не обязательно."
				readSheetTitle="Согласие на получение рекламы"
				readSheetDescription={`Версия ${CONSENT_VERSION} • Федеральный закон №38-ФЗ «О рекламе»`}
				fullText={MARKETING_CONSENT_TEXT}
				testId="consent-marketing"
			/>
		</fieldset>
	)
}

interface ConsentRowProps {
	readonly id: string
	readonly accepted: boolean
	readonly onAcceptedChange: (next: boolean) => void
	readonly required: boolean
	readonly labelMain: string
	readonly labelMeta: string
	readonly readSheetTitle: string
	readonly readSheetDescription: string
	readonly fullText: string
	readonly testId: string
	readonly error?: boolean
}

function ConsentRow({
	id,
	accepted,
	onAcceptedChange,
	required,
	labelMain,
	labelMeta,
	readSheetTitle,
	readSheetDescription,
	fullText,
	testId,
	error = false,
}: ConsentRowProps) {
	const [readOpen, setReadOpen] = useState(false)
	const errorId = `${id}-error`

	return (
		<div className="space-y-2">
			<div className="flex items-start gap-3">
				<Checkbox
					id={id}
					checked={accepted}
					onCheckedChange={(next) => onAcceptedChange(next === true)}
					aria-required={required}
					aria-invalid={error || undefined}
					aria-describedby={error ? errorId : undefined}
					data-testid={`${testId}-checkbox`}
					className="mt-0.5"
				/>
				<div className="flex-1 space-y-1">
					<label htmlFor={id} className="block cursor-pointer text-sm leading-snug">
						<span className="font-medium">{labelMain}</span>
						{required ? (
							<span className="ml-1 text-destructive" aria-hidden>
								*
							</span>
						) : null}
					</label>
					<p className="text-xs text-muted-foreground">{labelMeta}</p>
					<ResponsiveSheet open={readOpen} onOpenChange={setReadOpen}>
						<ResponsiveSheetTrigger asChild>
							<button
								type="button"
								className="text-left text-xs font-medium text-primary underline underline-offset-2 hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
								data-testid={`${testId}-read`}
							>
								Прочитать полностью
							</button>
						</ResponsiveSheetTrigger>
						<ResponsiveSheetContent
							side="right"
							className="w-full sm:max-w-2xl"
							aria-describedby={`${id}-sheet-desc`}
						>
							<ResponsiveSheetHeader>
								<ResponsiveSheetTitle>{readSheetTitle}</ResponsiveSheetTitle>
								<ResponsiveSheetDescription id={`${id}-sheet-desc`}>
									{readSheetDescription}
								</ResponsiveSheetDescription>
							</ResponsiveSheetHeader>
							<div
								className="max-h-[70vh] overflow-y-auto whitespace-pre-line px-4 pb-6 text-sm leading-relaxed text-foreground"
								data-testid={`${testId}-fulltext`}
							>
								{fullText}
							</div>
						</ResponsiveSheetContent>
					</ResponsiveSheet>
				</div>
			</div>
			{error ? (
				<p id={errorId} role="alert" className="text-xs text-destructive">
					Это согласие обязательно для продолжения
				</p>
			) : null}
		</div>
	)
}
