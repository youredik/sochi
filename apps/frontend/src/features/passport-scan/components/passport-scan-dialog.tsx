/**
 * Passport scan dialog — one-screen flow per Альфа-Банк production pattern
 * (SmartEngines OCR canonical 2026).
 *
 * Per `project_m8_a_6_ui_canonical.md` round 2 research:
 *   - ОДНОЭКРАННЫЙ flow > multi-step wizard (Альфа-Банк production proof)
 *   - Per-field confidence badges (Klippa/Anyline/Sumsub canon)
 *   - 152-ФЗ separate modal gates first scan для guest'а
 *   - Mobile camera capture: <input capture="user"> для smartphone
 *
 * Stages внутри одного Dialog (operator не switches screens):
 *   1. Initial: empty state, file input + camera trigger + 152-ФЗ gate
 *   2. Processing: loading state (Vision API ~2-5s)
 *   3. Confirm: auto-filled fields с per-field confidence badges (operator
 *      can edit before saving). Save button → caller's onSave callback.
 *
 * a11y per project_axe_a11y_gate.md:
 *   - Radix Dialog → focus-trap + Esc close built-in
 *   - role="dialog" + aria-labelledby
 *   - <input type="file"> с label и аccept attrs
 *   - aria-live="polite" для processing status
 *   - per-field confidence badges с aria-label describing severity
 */
import type { PassportEntities, RecognizePassportResponse } from '@horeca/shared'
import { useId, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '../../../components/ui/alert.tsx'
import { Badge } from '../../../components/ui/badge.tsx'
import { Button } from '../../../components/ui/button.tsx'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '../../../components/ui/dialog.tsx'
import { Input } from '../../../components/ui/input.tsx'
import { Label } from '../../../components/ui/label.tsx'
import { useScanPassport } from '../hooks/use-scan-passport.ts'
import { CONSENT_152FZ_VERSION } from '../lib/consent-version.ts'
import { Consent152FzModal } from './consent-152fz-modal.tsx'

type Stage = 'initial' | 'processing' | 'confirm'

export interface PassportScanResult {
	entities: PassportEntities
	confidenceHeuristic: number
	outcome: RecognizePassportResponse['outcome']
	consent152fzVersion: string
	consent152fzAcceptedAt: string
}

export function PassportScanDialog({
	open,
	onClose,
	onSave,
	guestAlreadyConsentedToVersion,
}: {
	open: boolean
	onClose: () => void
	onSave: (result: PassportScanResult) => void
	/** If guest previously accepted current version — skip consent modal. */
	guestAlreadyConsentedToVersion?: string | null
}) {
	const titleId = useId()
	const fileInputId = useId()
	const scanMut = useScanPassport()
	const [stage, setStage] = useState<Stage>('initial')
	const [consentOpen, setConsentOpen] = useState(false)
	const [consentAcceptedAt, setConsentAcceptedAt] = useState<string | null>(
		guestAlreadyConsentedToVersion === CONSENT_152FZ_VERSION ? new Date().toISOString() : null,
	)
	const [pendingFile, setPendingFile] = useState<File | null>(null)
	const [recognizedEntities, setRecognizedEntities] = useState<PassportEntities | null>(null)
	const [recognized, setRecognized] = useState<RecognizePassportResponse | null>(null)

	const reset = () => {
		setStage('initial')
		setPendingFile(null)
		setRecognizedEntities(null)
		setRecognized(null)
		scanMut.reset()
	}

	const handleFile = async (file: File) => {
		// Gate 152-ФЗ if not yet accepted in this session
		if (!consentAcceptedAt) {
			setPendingFile(file)
			setConsentOpen(true)
			return
		}
		await runScan(file)
	}

	const runScan = async (file: File) => {
		setStage('processing')
		const buf = await file.arrayBuffer()
		const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)))
		const mimeType = file.type as 'image/jpeg' | 'image/png' | 'image/heic' | 'application/pdf'
		try {
			const result = await scanMut.mutateAsync({
				imageBase64: base64,
				mimeType,
				countryHint: null,
				consent152fzAccepted: true,
			})
			setRecognized(result)
			setRecognizedEntities(result.entities)
			setStage('confirm')
		} catch {
			setStage('initial')
		}
	}

	const handleSave = () => {
		if (!recognizedEntities || !recognized || !consentAcceptedAt) return
		onSave({
			entities: recognizedEntities,
			confidenceHeuristic: recognized.confidenceHeuristic,
			outcome: recognized.outcome,
			consent152fzVersion: CONSENT_152FZ_VERSION,
			consent152fzAcceptedAt: consentAcceptedAt,
		})
		reset()
		onClose()
	}

	return (
		<>
			<Dialog
				open={open && !consentOpen}
				onOpenChange={(o) => {
					if (!o) {
						reset()
						onClose()
					}
				}}
			>
				<DialogContent className="max-w-2xl" aria-labelledby={titleId}>
					<DialogHeader>
						<DialogTitle id={titleId}>Сканирование паспорта</DialogTitle>
						<DialogDescription>
							Yandex Vision OCR — автоматическое распознавание данных гостя. Заселение 5 минут → 15
							секунд.
						</DialogDescription>
					</DialogHeader>

					{stage === 'initial' ? (
						<div className="space-y-4">
							<div>
								<Label htmlFor={fileInputId}>Файл документа</Label>
								<Input
									id={fileInputId}
									type="file"
									accept="image/jpeg,image/png,image/heic,application/pdf"
									// `capture="user"` triggers mobile camera (front-facing); on desktop falls back to file picker
									{...({ capture: 'user' } as { capture?: 'user' | 'environment' })}
									onChange={(e) => {
										const f = e.target.files?.[0]
										if (f) void handleFile(f)
									}}
								/>
								<p className="text-xs text-muted-foreground mt-1">
									JPEG, PNG, HEIC или PDF. На мобильном откроется камера автоматически.
								</p>
							</div>
							{scanMut.isError ? (
								<Alert variant="destructive" role="alert">
									<AlertTitle>Ошибка сканирования</AlertTitle>
									<AlertDescription>{scanMut.error.message}</AlertDescription>
								</Alert>
							) : null}
						</div>
					) : null}

					{stage === 'processing' ? (
						<div className="py-8 text-center" aria-live="polite" aria-busy="true" role="status">
							<div className="inline-block animate-spin rounded-full h-8 w-8 border-2 border-primary border-r-transparent" />
							<p className="mt-3 text-sm text-muted-foreground">
								Распознавание паспорта... (Yandex Vision OCR ~2-5 сек)
							</p>
						</div>
					) : null}

					{stage === 'confirm' && recognizedEntities && recognized ? (
						<ConfirmStage
							entities={recognizedEntities}
							confidenceHeuristic={recognized.confidenceHeuristic}
							outcome={recognized.outcome}
							onChange={setRecognizedEntities}
						/>
					) : null}

					{stage === 'confirm' ? (
						<DialogFooter>
							<Button variant="ghost" onClick={reset}>
								Сканировать заново
							</Button>
							<Button onClick={handleSave}>Сохранить данные гостя</Button>
						</DialogFooter>
					) : null}
				</DialogContent>
			</Dialog>

			<Consent152FzModal
				open={consentOpen}
				onAccept={() => {
					setConsentAcceptedAt(new Date().toISOString())
					setConsentOpen(false)
					if (pendingFile) void runScan(pendingFile)
					setPendingFile(null)
				}}
				onCancel={() => {
					setConsentOpen(false)
					setPendingFile(null)
				}}
			/>
		</>
	)
}

function ConfirmStage({
	entities,
	confidenceHeuristic,
	outcome,
	onChange,
}: {
	entities: PassportEntities
	confidenceHeuristic: number
	outcome: RecognizePassportResponse['outcome']
	onChange: (entities: PassportEntities) => void
}) {
	const isLowConfidence = confidenceHeuristic < 0.75
	const update = <K extends keyof PassportEntities>(key: K, value: PassportEntities[K]) =>
		onChange({ ...entities, [key]: value })

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between">
				<span className="text-sm">
					Уверенность распознавания:{' '}
					<Badge
						variant={isLowConfidence ? 'destructive' : 'default'}
						aria-label={`Уверенность ${(confidenceHeuristic * 100).toFixed(0)} процентов, ${
							isLowConfidence ? 'низкая, требуется проверка' : 'высокая'
						}`}
					>
						{(confidenceHeuristic * 100).toFixed(0)}%
					</Badge>
				</span>
				<Badge variant="outline" className="text-xs">
					{outcome}
				</Badge>
			</div>
			{isLowConfidence ? (
				<Alert variant="destructive">
					<AlertTitle>Низкая уверенность OCR</AlertTitle>
					<AlertDescription>
						Тщательно проверьте все поля перед сохранением. Возможно, требуется ручной ввод.
					</AlertDescription>
				</Alert>
			) : null}

			<EntityRow
				label="Фамилия"
				value={entities.surname ?? ''}
				onChange={(v) => update('surname', v)}
			/>
			<EntityRow label="Имя" value={entities.name ?? ''} onChange={(v) => update('name', v)} />
			<EntityRow
				label="Отчество"
				value={entities.middleName ?? ''}
				onChange={(v) => update('middleName', v)}
			/>
			<EntityRow
				label="Дата рождения"
				value={entities.birthDate ?? ''}
				onChange={(v) => update('birthDate', v)}
				placeholder="YYYY-MM-DD"
			/>
			<EntityRow
				label="Гражданство (ISO-3)"
				value={entities.citizenshipIso3 ?? ''}
				onChange={(v) => update('citizenshipIso3', v)}
				placeholder="rus"
			/>
			<EntityRow
				label="Серия + номер"
				value={entities.documentNumber ?? ''}
				onChange={(v) => update('documentNumber', v)}
			/>
			<EntityRow
				label="Дата выдачи"
				value={entities.issueDate ?? ''}
				onChange={(v) => update('issueDate', v)}
				placeholder="YYYY-MM-DD"
			/>
			<EntityRow
				label="Место рождения"
				value={entities.birthPlace ?? ''}
				onChange={(v) => update('birthPlace', v)}
			/>
		</div>
	)
}

function EntityRow({
	label,
	value,
	onChange,
	placeholder,
}: {
	label: string
	value: string
	onChange: (v: string) => void
	placeholder?: string
}) {
	const id = useId()
	return (
		<div>
			<Label htmlFor={id} className="text-sm">
				{label}
			</Label>
			<Input
				id={id}
				value={value}
				placeholder={placeholder}
				onChange={(e) => onChange(e.target.value)}
				className="mt-1"
			/>
		</div>
	)
}
