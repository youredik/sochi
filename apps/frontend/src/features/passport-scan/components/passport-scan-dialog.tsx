/**
 * Passport scan dialog — one-screen flow per Альфа-Банк production pattern
 * (SmartEngines OCR canonical 2026).
 *
 * Per `project_m8_a_6_ui_canonical.md` round 2 research:
 *   - ОДНОЭКРАННЫЙ flow > multi-step wizard (Альфа-Банк production proof)
 *   - Per-field confidence badges (Klippa/Anyline/Sumsub canon)
 *   - 152-ФЗ separate modal gates first scan для guest'а
 *   - Mobile camera capture: <input capture="environment"> для smartphone
 *
 * Stages внутри одного Dialog (operator не switches screens):
 *   1. Initial: empty state, file input + camera trigger + 152-ФЗ gate
 *   2. Processing: loading state (Vision API ~2-5s)
 *   3. Confirm: auto-filled fields с per-field confidence badges (operator
 *      can edit before saving). Save button → caller's onSave callback.
 *
 * Sprint C Day 2 UX upgrades (round-5 expert recommendations):
 *   - scanError visible (Round 3 C7 fix)
 *   - RKL status badge + Save-block on match (МВД pre-check)
 *   - Citizenship as shadcn Select (PASSPORT_COUNTRY_WHITELIST_RU)
 *   - AlertDialog confirmation для destructive «Сканировать заново»
 *   - autoComplete attrs на EntityRow (browser autofill canon)
 *   - sticky DialogFooter (always visible на mobile keyboards)
 *   - 24×24 touch targets (WCAG 2.5.8 AA)
 *   - aria-invalid + aria-describedby per EntityRow (field-level a11y)
 *
 * a11y per project_axe_a11y_gate.md:
 *   - Radix Dialog → focus-trap + Esc close built-in
 *   - role="dialog" + aria-labelledby
 *   - <input type="file"> с label и accept attrs
 *   - aria-live="polite" для processing status
 *   - per-field confidence badges с aria-label describing severity
 *   - aria-invalid + aria-describedby на каждом required input
 */
import type {
	IdentityMethod,
	PassportEntities,
	RecognizePassportResponse,
	RklStatusForScan,
} from '@horeca/shared'
import { PASSPORT_COUNTRY_WHITELIST_RU } from '@horeca/shared'
import { useId, useMemo, useRef, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '../../../components/ui/alert.tsx'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '../../../components/ui/alert-dialog.tsx'
import { Badge } from '../../../components/ui/badge.tsx'
import { Button, buttonVariants } from '../../../components/ui/button.tsx'
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
import { RadioGroup, RadioGroupItem } from '../../../components/ui/radio-group.tsx'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '../../../components/ui/select.tsx'
import { generateUuid } from '../../../lib/uuid-fallback.ts'
import { useScanPassport } from '../hooks/use-scan-passport.ts'
import { CONSENT_152FZ_VERSION } from '../lib/consent-version.ts'
import { fileToBase64, transcodeToJpegForVision } from '../lib/transcode-image.ts'
import { Consent152FzModal, type OperatorIdentity } from './consent-152fz-modal.tsx'

type Stage = 'initial' | 'processing' | 'confirm'

/** 30MB pre-flight file size cap. iPhone Pro Max 12MP photo ~12MB, PDF до 25MB. */
const MAX_INPUT_BYTES = 30 * 1024 * 1024

const OUTCOME_RU_LABELS: Record<RecognizePassportResponse['outcome'], string> = {
	success: 'Успешно',
	low_confidence: 'Низкая уверенность',
	api_error: 'Ошибка API',
	invalid_document: 'Документ не распознан',
}

/** RU labels + variant для РКЛ status badge. */
const RKL_STATUS_LABELS: Record<
	RklStatusForScan,
	{ label: string; variant: 'default' | 'destructive' | 'secondary' | 'outline' }
> = {
	clean: { label: 'РКЛ: проверка пройдена', variant: 'default' },
	match: { label: 'РКЛ: совпадение — заселение заблокировано', variant: 'destructive' },
	inconclusive: { label: 'РКЛ: проверьте вручную', variant: 'secondary' },
	check_failed: { label: 'РКЛ: проверка недоступна', variant: 'outline' },
	skipped_ru: { label: 'РКЛ: не применима (РФ)', variant: 'outline' },
}

export interface PassportScanResult {
	entities: PassportEntities
	confidenceHeuristic: number
	outcome: RecognizePassportResponse['outcome']
	consent152fzVersion: string
	consent152fzAcceptedAt: string
	rklStatus: RklStatusForScan
}

/** Подмножество IdentityMethod что обрабатывается через OCR-flow в этом диалоге. */
type OcrIdentityMethod = Extract<
	IdentityMethod,
	'passport_paper' | 'passport_zagran' | 'driver_license'
>

const IDENTITY_METHOD_LABELS: Record<OcrIdentityMethod, string> = {
	passport_paper: 'Паспорт РФ (внутренний)',
	passport_zagran: 'Загранпаспорт РФ',
	driver_license: 'Водительское удостоверение',
}

/** ЕБС / digital_id_max не сканируются через OCR (separate biometric/QR flow). */
function isOcrIdentityMethod(m: IdentityMethod): m is OcrIdentityMethod {
	return m === 'passport_paper' || m === 'passport_zagran' || m === 'driver_license'
}

export function PassportScanDialog({
	open,
	onClose,
	onSave,
	identityMethod: identityMethodProp = 'passport_paper',
	guestId,
	operatorIdentity,
}: {
	open: boolean
	onClose: () => void
	onSave: (result: PassportScanResult) => void
	/**
	 * If guest previously accepted current version — historically skip consent
	 * modal. Sprint C self-review removed bypass logic per 152-ФЗ ст.9 ч.4
	 * (each scan = new textSnapshot proof event). Prop kept в signature для
	 * future re-introduction когда caller также supplies textSnapshot pair.
	 */
	guestAlreadyConsentedToVersion?: string | null
	/**
	 * Тип документа (per ПП-1912). Default 'passport_paper'. Operator может
	 * изменить в первом stage если caller угадал неправильно.
	 *   - passport_paper  → Vision `passport` (auto-fill 9 полей)
	 *   - passport_zagran → Vision `text` + MRZ парсер (ICAO 9303)
	 *   - driver_license  → Vision `driver-license-front`
	 *   - ebs/digital_id_max → caller должен использовать другой flow
	 */
	identityMethod?: IdentityMethod
	/** Soft FK guest.id — для photoConsentLog linkage (Sprint B). */
	guestId: string
	/**
	 * Sprint C Day 3+: operator identity для 152-ФЗ ст.9 ч.4 identification
	 * в consent text. If undefined, modal falls back к generic placeholder.
	 * Caller (e.g. migration-registration-detail-sheet) injects from active org.
	 */
	operatorIdentity?: OperatorIdentity
}) {
	const titleId = useId()
	const fileInputId = useId()
	const identityRadioName = useId()
	const scanMut = useScanPassport()
	const [stage, setStage] = useState<Stage>('initial')
	// Sprint C: surface transcode/network errors к operator (Round 3 C7 fix).
	const [scanError, setScanError] = useState<string | null>(null)
	// Sprint C: textSnapshot — verbatim consent text shown at click. Backend stores
	// в photoConsentLog.textSnapshot per 152-ФЗ ст.9 ч.4 «оператор обязан доказать».
	const lastConsentTextSnapshot = useRef<string | null>(null)
	// Default to prop value if OCR-able, иначе fallback to passport_paper.
	const [selectedIdentityMethod, setSelectedIdentityMethod] = useState<OcrIdentityMethod>(
		isOcrIdentityMethod(identityMethodProp) ? identityMethodProp : 'passport_paper',
	)
	const [consentOpen, setConsentOpen] = useState(false)
	// Sprint C self-review fix: do NOT bypass consent based on previous version —
	// 152-ФЗ ст.9 ч.4 requires NEW textSnapshot per scan event. Stale auto-init
	// сбивает backend Zod `consent152fzTextSnapshot.min(1)` (vision.routes.ts).
	// `guestAlreadyConsentedToVersion` оставлен как prop для future feature: skip
	// only когда CALLER provides matching textSnapshot too — current canon = always
	// show modal для tamper-proof textSnapshot capture.
	const [consentAcceptedAt, setConsentAcceptedAt] = useState<string | null>(null)
	const [pendingFile, setPendingFile] = useState<File | null>(null)
	const [recognizedEntities, setRecognizedEntities] = useState<PassportEntities | null>(null)
	const [recognized, setRecognized] = useState<RecognizePassportResponse | null>(null)
	const [validationError, setValidationError] = useState<string | null>(null)
	// Sprint C: destructive «Сканировать заново» confirmation gate.
	const [resetConfirmOpen, setResetConfirmOpen] = useState(false)

	const reset = () => {
		setStage('initial')
		setPendingFile(null)
		setRecognizedEntities(null)
		setRecognized(null)
		setScanError(null)
		setValidationError(null)
		// Sprint C self-review H2 fix: also clear consent state — each scan event
		// is a separate consent per 152-ФЗ ст.9 ч.4. Stale `consentAcceptedAt` от
		// предыдущего сканирования = mismatched audit trail.
		setConsentAcceptedAt(null)
		lastConsentTextSnapshot.current = null
		scanMut.reset()
	}

	const handleFile = async (file: File) => {
		// Sprint C: pre-flight size cap — prevents iPhone SE OOM crash на 200MB photo.
		if (file.size > MAX_INPUT_BYTES) {
			setScanError(
				`Файл ${(file.size / 1024 / 1024).toFixed(1)} МБ превышает лимит ${MAX_INPUT_BYTES / 1024 / 1024} МБ. ` +
					`Снимите более компактное фото или уменьшите PDF.`,
			)
			return
		}
		setScanError(null)
		// Gate 152-ФЗ if not yet accepted in this session
		if (!consentAcceptedAt) {
			setPendingFile(file)
			setConsentOpen(true)
			return
		}
		await runScan(file)
	}

	const runScan = async (file: File) => {
		// Sprint C self-review H4 fix: double-click guard. Without this, operator
		// click → file picker → click again → fires TWO parallel runScan calls:
		// 1) Transcode runs 2× (CPU heavy), 2) Vision API billed 2× (0.71 ₽ each),
		// 3) audit + consent rows written 2× (different idempotencyKeys = NO backend
		// dedup). Guard: if mutation in flight or transcode already running, no-op.
		if (scanMut.isPending || stage === 'processing') return
		// Defensive: textSnapshot MUST be set (modal sets it before runScan called).
		// Empty snapshot = 152-ФЗ ст.9 ч.4 proof gap; reject early before Vision call.
		if (lastConsentTextSnapshot.current === null || lastConsentTextSnapshot.current.length === 0) {
			setScanError('Согласие 152-ФЗ не зафиксировано (textSnapshot пуст). Откройте диалог заново.')
			return
		}
		setStage('processing')
		try {
			// Client-side transcode: HEIC/HEIF/large JPEG → 2048-max JPEG q=0.85.
			// EXIF (геолокация iPhone) автоматически strip'нется при canvas re-encode.
			// PDF — Vision принимает напрямую, не transcode.
			const isPdf = file.type === 'application/pdf'
			const uploadFile = isPdf ? file : (await transcodeToJpegForVision(file)).file
			const base64 = await fileToBase64(uploadFile)
			const mimeType = isPdf ? ('application/pdf' as const) : ('image/jpeg' as const)
			// UUID per click — Stripe-style idempotency. Backend dedupes если operator
			// случайно кликнет save дважды (double-click / network glitch retry).
			// Sprint C: use fallback для LAN-HTTP sales demos (non-secure context).
			const idempotencyKey = generateUuid()
			const result = await scanMut.mutateAsync({
				imageBase64: base64,
				mimeType,
				countryHint: null,
				identityMethod: selectedIdentityMethod,
				guestId,
				consent152fzVersion: CONSENT_152FZ_VERSION,
				consent152fzTextSnapshot: lastConsentTextSnapshot.current,
				separateConsents: { generalPdn: true, citizenshipSpecial: true, biometricPhoto: true },
				consent152fzAccepted: true,
				idempotencyKey,
			})
			setRecognized(result)
			setRecognizedEntities(result.entities)
			setStage('confirm')
		} catch (err) {
			// Sprint C Round 3 C7 fix — surface transcode/network errors к operator.
			// Previous silent reset → operator не понимал почему dialog откатывался.
			const errMsg = err instanceof Error ? err.message : 'Ошибка распознавания'
			setScanError(errMsg)
			setStage('initial')
		}
	}

	/**
	 * Validate entities перед save. Возвращает null если OK, иначе RU error message.
	 *
	 * Round 3 finding C4: expirationDate validation только labels `*` — НЕ блокирует
	 * сохранение пустого/истёкшего паспорта. ЕПГУ отвергнет downstream регистрацию —
	 * fail-fast lучше.
	 */
	const validateBeforeSave = (entities: PassportEntities): string | null => {
		// Required core fields для миграционной регистрации.
		if (entities.surname === null || entities.surname.trim().length === 0) {
			return 'Заполните фамилию'
		}
		if (entities.name === null || entities.name.trim().length === 0) {
			return 'Заполните имя'
		}
		if (entities.documentNumber === null || entities.documentNumber.trim().length === 0) {
			return 'Заполните номер документа'
		}
		if (entities.birthDate === null || !/^\d{4}-\d{2}-\d{2}$/.test(entities.birthDate)) {
			return 'Заполните дату рождения в формате YYYY-MM-DD'
		}
		// Загранпаспорт + ВУ — expirationDate ОБЯЗАТЕЛЕН и НЕ должен быть истёкшим.
		const requiresExpiry =
			selectedIdentityMethod === 'passport_zagran' || selectedIdentityMethod === 'driver_license'
		if (requiresExpiry) {
			if (
				entities.expirationDate === null ||
				!/^\d{4}-\d{2}-\d{2}$/.test(entities.expirationDate)
			) {
				return 'Заполните срок действия в формате YYYY-MM-DD'
			}
			const expiry = new Date(entities.expirationDate)
			const today = new Date()
			today.setUTCHours(0, 0, 0, 0)
			if (Number.isNaN(expiry.getTime())) {
				return 'Срок действия — некорректная дата'
			}
			if (expiry < today) {
				return `Документ истёк ${entities.expirationDate}. Гость должен предъявить действующий документ.`
			}
		}
		return null
	}

	const handleSave = () => {
		if (!recognizedEntities || !recognized || !consentAcceptedAt) return
		// Sprint C: РКЛ match → backend MUST reject downstream регистрацию,
		// поэтому frontend Save кнопка disabled. Defensive check на случай дрейфа.
		if (recognized.rklStatus === 'match') {
			setValidationError(
				'Документ найден в реестре контролируемых лиц МВД. Заселение заблокировано.',
			)
			return
		}
		const err = validateBeforeSave(recognizedEntities)
		if (err !== null) {
			setValidationError(err)
			return
		}
		setValidationError(null)
		onSave({
			entities: recognizedEntities,
			confidenceHeuristic: recognized.confidenceHeuristic,
			outcome: recognized.outcome,
			consent152fzVersion: CONSENT_152FZ_VERSION,
			consent152fzAcceptedAt: consentAcceptedAt,
			rklStatus: recognized.rklStatus,
		})
		reset()
		onClose()
	}

	/**
	 * Sprint C: «Сканировать заново» в confirm stage = destructive если оператор
	 * правил поля. AlertDialog gate (WCAG 3.3.4 error prevention legal/financial).
	 * Если оператор только что увидел auto-fill (не правил) — confirm bypass.
	 *
	 * Heuristic «правил поля»: stage===confirm AND recognizedEntities deep-not-equal
	 * recognized.entities. Дешёвый shallow check через JSON.stringify (PassportEntities
	 * — flat object, без cycles).
	 */
	const operatorEditedEntities = useMemo(() => {
		if (stage !== 'confirm' || recognized === null || recognizedEntities === null) return false
		return JSON.stringify(recognized.entities) !== JSON.stringify(recognizedEntities)
	}, [stage, recognized, recognizedEntities])

	const handleResetClick = () => {
		if (operatorEditedEntities) {
			setResetConfirmOpen(true)
		} else {
			reset()
		}
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
				<DialogContent
					className="max-w-2xl max-h-[90dvh] sm:max-h-[90vh] flex flex-col"
					aria-labelledby={titleId}
				>
					<DialogHeader>
						<DialogTitle id={titleId}>Сканирование документа гостя</DialogTitle>
						<DialogDescription>
							Yandex Vision OCR — автоматическое распознавание. Заселение 5 минут → 15 секунд.
						</DialogDescription>
					</DialogHeader>

					{/* Sprint C: scrollable middle section, sticky footer below. */}
					<div className="flex-1 overflow-y-auto -mx-6 px-6 -mb-2 pb-2">
						{stage === 'initial' ? (
							<div className="space-y-4">
								{/*
								 * Sprint C+1 self-review L1 hard-gate: 152-ФЗ ст.9 ч.4 requires
								 * оператор идентифицируется в consent тексте. Без legalName operator
								 * identity is void (Tinkoff УКБО precedent 2025) — block scan flow
								 * entirely и направить operator к onboarding settings заполнить.
								 *
								 * Соглашение для unit-tests / Storybook: identity optional, modal
								 * renders generic placeholder. Real product UI uses gate ниже.
								 */}
								{operatorIdentity === undefined || operatorIdentity.legalName.length === 0 ? (
									<Alert variant="destructive" role="alert">
										<AlertTitle>Сканирование заблокировано (152-ФЗ ст.9 ч.4)</AlertTitle>
										<AlertDescription>
											Оператор не идентифицирован — обязательно укажите юридическое название и ИНН в
											настройках организации. Без идентификации оператора согласие 152-ФЗ юридически
											ничтожно.
										</AlertDescription>
									</Alert>
								) : null}
								<fieldset disabled={!operatorIdentity || operatorIdentity.legalName.length === 0}>
									<legend className="text-sm font-medium mb-2">Тип документа</legend>
									<RadioGroup
										value={selectedIdentityMethod}
										onValueChange={(v) => setSelectedIdentityMethod(v as OcrIdentityMethod)}
										name={identityRadioName}
										className="gap-2"
									>
										{(Object.keys(IDENTITY_METHOD_LABELS) as readonly OcrIdentityMethod[]).map(
											(method) => {
												const optionId = `${identityRadioName}-${method}`
												return (
													<div key={method} className="flex items-center gap-2 min-h-11">
														<RadioGroupItem id={optionId} value={method} />
														<Label
															htmlFor={optionId}
															className="text-sm font-normal cursor-pointer"
														>
															{IDENTITY_METHOD_LABELS[method]}
														</Label>
													</div>
												)
											},
										)}
									</RadioGroup>
								</fieldset>
								<div>
									<Label htmlFor={fileInputId}>Файл документа</Label>
									<Input
										id={fileInputId}
										type="file"
										// HEIC намеренно НЕ в accept: iOS Safari сам конвертирует HEIC → JPEG
										// при выборе если accept не содержит image/heic. PDF supported для
										// многостраничных документов (Yandex Vision async path).
										accept="image/jpeg,image/png,application/pdf"
										// `capture="environment"` — задняя камера для документа (не selfie).
										{...({ capture: 'environment' } as {
											capture?: 'user' | 'environment'
										})}
										// Sprint C self-review H4 + L1 fix: native disabled = (1) prevent
										// double-click race + (2) hard-block scan если operator identity
										// missing (152-ФЗ ст.9 ч.4 — void consent without legal name).
										disabled={
											scanMut.isPending ||
											!operatorIdentity ||
											operatorIdentity.legalName.length === 0
										}
										aria-describedby={`${fileInputId}-hint`}
										onChange={(e) => {
											const f = e.target.files?.[0]
											if (f) void handleFile(f)
										}}
									/>
									<p id={`${fileInputId}-hint`} className="text-xs text-muted-foreground mt-1">
										JPEG, PNG или PDF (iPhone-HEIC автоматически конвертируется). На мобильном
										откроется задняя камера.
									</p>
								</div>
								{/* Sprint C: scanError surfaces file-size + transcode + network errors. */}
								{scanError !== null ? (
									<Alert variant="destructive" role="alert">
										<AlertTitle>Ошибка сканирования</AlertTitle>
										<AlertDescription>{scanError}</AlertDescription>
									</Alert>
								) : null}
							</div>
						) : null}

						{stage === 'processing' ? (
							<div className="py-8 text-center" aria-live="polite" aria-busy="true" role="status">
								{/*
								 * Round 4 self-review A11y P0-2 fix:
								 * - aria-hidden="true" — spinner = visual indicator, screen reader
								 *   gets <p> message ниже.
								 * - motion-reduce:animate-none — WCAG 2.3.3 AAA Animation from
								 *   Interactions: respect prefers-reduced-motion для vestibular-
								 *   impaired operators (long-shift front-desk Сочи canon).
								 */}
								<div
									className="inline-block animate-spin motion-reduce:animate-none rounded-full h-8 w-8 border-2 border-primary border-r-transparent"
									aria-hidden="true"
								/>
								<p className="mt-3 text-sm text-muted-foreground">
									Распознавание документа... (Yandex Vision OCR ~2-5 сек)
								</p>
							</div>
						) : null}

						{stage === 'confirm' && recognizedEntities && recognized ? (
							<>
								{/*
								 * Round 2 self-review A11y P0-1 fix: status announce
								 * на processing→confirm transition. WCAG 4.1.3 — screen
								 * reader gets explicit message что OCR завершилось.
								 * `key` prop forces re-mount per new scan = re-announce.
								 */}
								<div
									className="sr-only"
									role="status"
									aria-live="polite"
									key={recognized.latencyMs}
								>
									Распознавание завершено за {(recognized.latencyMs / 1000).toFixed(1)} секунд.
									Уверенность {(recognized.confidenceHeuristic * 100).toFixed(0)} процентов.
									Проверьте поля ниже перед сохранением.
								</div>
								<ConfirmStage
									entities={recognizedEntities}
									confidenceHeuristic={recognized.confidenceHeuristic}
									outcome={recognized.outcome}
									rklStatus={recognized.rklStatus}
									identityMethod={selectedIdentityMethod}
									onChange={setRecognizedEntities}
									validationError={validationError}
								/>
							</>
						) : null}

						{stage === 'confirm' && validationError !== null ? (
							<Alert variant="destructive" role="alert" className="mt-2">
								<AlertTitle>Невозможно сохранить</AlertTitle>
								<AlertDescription>{validationError}</AlertDescription>
							</Alert>
						) : null}
					</div>

					{stage === 'confirm' ? (
						<DialogFooter className="sticky bottom-0 bg-background pt-3 border-t [padding-bottom:max(0.75rem,env(safe-area-inset-bottom))]">
							<Button variant="ghost" onClick={handleResetClick}>
								Сканировать заново
							</Button>
							<Button
								onClick={handleSave}
								disabled={recognized?.rklStatus === 'match'}
								title={
									recognized?.rklStatus === 'match'
										? 'РКЛ совпадение — заселение заблокировано'
										: undefined
								}
							>
								Сохранить данные гостя
							</Button>
						</DialogFooter>
					) : null}
				</DialogContent>
			</Dialog>

			<Consent152FzModal
				open={consentOpen}
				{...(operatorIdentity ? { operatorIdentity } : {})}
				// Round 2 Batch 8: identity method → citizenshipBasis для ст.10 conditional.
				// passport_paper = RF internal паспорт = RU citizen (статутное исключение).
				// passport_zagran / driver_license могут быть RU OR foreign — defensive «foreign»
				// показывает checkbox, оператор всегда может accept если citizen is RU foreign.
				citizenshipBasis={selectedIdentityMethod === 'passport_paper' ? 'ru' : 'foreign'}
				onAccept={(payload) => {
					// Sprint C: capture timestamp at moment of click (not mount) +
					// textSnapshot для backend tamper-proof proof (152-ФЗ ст.9 ч.4).
					setConsentAcceptedAt(payload.acceptedAt)
					lastConsentTextSnapshot.current = payload.textSnapshot
					setConsentOpen(false)
					if (pendingFile) void runScan(pendingFile)
					setPendingFile(null)
				}}
				onCancel={() => {
					setConsentOpen(false)
					setPendingFile(null)
				}}
			/>

			{/* Sprint C: destructive «Сканировать заново» confirmation (WCAG 3.3.4). */}
			<AlertDialog open={resetConfirmOpen} onOpenChange={setResetConfirmOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Отменить введённые правки?</AlertDialogTitle>
						<AlertDialogDescription>
							Вы вручную исправили данные после OCR. Если сейчас сканировать заново, эти правки
							будут потеряны.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Продолжить редактирование</AlertDialogCancel>
						{/*
						 * Sprint C+1 self-review A3 fix: destructive variant + data-loss
						 * красный тон. WCAG 1.4.1 + RU UX canon: destructive буттоны должны
						 * визуально signal harm.
						 */}
						<AlertDialogAction
							onClick={() => reset()}
							className={buttonVariants({ variant: 'destructive' })}
						>
							Да, сканировать заново
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	)
}

function ConfirmStage({
	entities,
	confidenceHeuristic,
	outcome,
	rklStatus,
	identityMethod,
	onChange,
	validationError,
}: {
	entities: PassportEntities
	confidenceHeuristic: number
	outcome: RecognizePassportResponse['outcome']
	rklStatus: RklStatusForScan
	identityMethod: OcrIdentityMethod
	onChange: (entities: PassportEntities) => void
	validationError: string | null
}) {
	const isLowConfidence = confidenceHeuristic < 0.75
	const rklBadge = RKL_STATUS_LABELS[rklStatus]
	const update = <K extends keyof PassportEntities>(key: K, value: PassportEntities[K]) =>
		onChange({ ...entities, [key]: value })

	// Labels + placeholders branch по типу документа. MRZ загранпаспорта НЕ
	// содержит отчество/место рождения/дату выдачи — оператор дозаполняет руками.
	const docNumberLabel =
		identityMethod === 'driver_license'
			? 'Номер ВУ'
			: identityMethod === 'passport_zagran'
				? 'Номер загранпаспорта'
				: 'Серия + номер'
	const docNumberPlaceholder =
		identityMethod === 'driver_license'
			? '99 99 999999'
			: identityMethod === 'passport_zagran'
				? '99 1234567 (9 цифр)'
				: '4608 123456'
	const expirationRequired =
		identityMethod === 'passport_zagran' || identityMethod === 'driver_license'

	// Sprint C: field-level validation derived from validationError + value sanity.
	const surnameInvalid = entities.surname === null || entities.surname.trim().length === 0
	const nameInvalid = entities.name === null || entities.name.trim().length === 0
	const documentNumberInvalid =
		entities.documentNumber === null || entities.documentNumber.trim().length === 0
	const birthDateInvalid =
		entities.birthDate === null || !/^\d{4}-\d{2}-\d{2}$/.test(entities.birthDate)
	const expirationInvalid =
		expirationRequired &&
		(entities.expirationDate === null || !/^\d{4}-\d{2}-\d{2}$/.test(entities.expirationDate))

	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
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
				<div className="flex items-center gap-2">
					<Badge
						variant="outline"
						className="text-xs"
						aria-label={`Результат OCR: ${OUTCOME_RU_LABELS[outcome]}`}
					>
						{OUTCOME_RU_LABELS[outcome]}
					</Badge>
					<Badge variant={rklBadge.variant} className="text-xs" aria-label={rklBadge.label}>
						{rklBadge.label}
					</Badge>
				</div>
			</div>

			{isLowConfidence ? (
				<Alert variant="destructive">
					<AlertTitle>Низкая уверенность OCR</AlertTitle>
					<AlertDescription>
						Тщательно проверьте все поля перед сохранением. Возможно, требуется ручной ввод.
					</AlertDescription>
				</Alert>
			) : null}

			{rklStatus === 'match' ? (
				<Alert variant="destructive">
					<AlertTitle>Совпадение с РКЛ МВД</AlertTitle>
					<AlertDescription>
						Документ найден в реестре контролируемых лиц. Заселение заблокировано — кнопка
						«Сохранить» недоступна. Свяжитесь с дежурным офицером МВД для дальнейших действий.
					</AlertDescription>
				</Alert>
			) : null}

			{rklStatus === 'inconclusive' ? (
				<Alert>
					<AlertTitle>РКЛ: вручную проверьте документ</AlertTitle>
					<AlertDescription>
						Автоматическая сверка не дала однозначного результата. Сверьтесь с реестром
						контролируемых лиц вручную перед заселением.
					</AlertDescription>
				</Alert>
			) : null}

			<EntityRow
				label="Фамилия"
				value={entities.surname ?? ''}
				onChange={(v) => update('surname', v)}
				autoComplete="family-name"
				required={true}
				invalid={surnameInvalid && validationError !== null}
				errorMessage={surnameInvalid ? 'Заполните фамилию' : null}
			/>
			<EntityRow
				label="Имя"
				value={entities.name ?? ''}
				onChange={(v) => update('name', v)}
				autoComplete="given-name"
				required={true}
				invalid={nameInvalid && validationError !== null}
				errorMessage={nameInvalid ? 'Заполните имя' : null}
			/>
			<EntityRow
				label="Отчество"
				value={entities.middleName ?? ''}
				onChange={(v) => update('middleName', v)}
				autoComplete="additional-name"
				{...(identityMethod === 'passport_zagran'
					? { placeholder: 'отчество не в MRZ — заполните вручную' }
					: {})}
			/>
			<EntityRow
				label="Дата рождения"
				value={entities.birthDate ?? ''}
				onChange={(v) => update('birthDate', v)}
				placeholder="YYYY-MM-DD"
				autoComplete="bday"
				inputMode="numeric"
				required={true}
				invalid={birthDateInvalid && validationError !== null}
				errorMessage={birthDateInvalid ? 'Формат YYYY-MM-DD' : null}
			/>
			<CitizenshipRow
				value={entities.citizenshipIso3 ?? ''}
				onChange={(v) => update('citizenshipIso3', v.length === 0 ? null : v)}
			/>
			<EntityRow
				label={docNumberLabel}
				value={entities.documentNumber ?? ''}
				onChange={(v) => update('documentNumber', v)}
				placeholder={docNumberPlaceholder}
				autoComplete="off"
				inputMode="numeric"
				required={true}
				invalid={documentNumberInvalid && validationError !== null}
				errorMessage={documentNumberInvalid ? 'Заполните номер документа' : null}
			/>
			<EntityRow
				label="Дата выдачи"
				value={entities.issueDate ?? ''}
				onChange={(v) => update('issueDate', v)}
				placeholder={
					identityMethod === 'passport_zagran'
						? 'YYYY-MM-DD — не в MRZ, заполните вручную'
						: 'YYYY-MM-DD'
				}
				autoComplete="off"
				inputMode="numeric"
			/>
			<EntityRow
				label="Место рождения"
				value={entities.birthPlace ?? ''}
				onChange={(v) => update('birthPlace', v)}
				autoComplete="off"
				{...(identityMethod === 'passport_zagran'
					? { placeholder: 'не в MRZ — заполните вручную' }
					: {})}
			/>
			<EntityRow
				label={expirationRequired ? 'Срок действия*' : 'Срок действия'}
				value={entities.expirationDate ?? ''}
				onChange={(v) => update('expirationDate', v)}
				placeholder={
					expirationRequired ? 'YYYY-MM-DD (обязательно)' : 'YYYY-MM-DD (только загран/СНГ)'
				}
				autoComplete="off"
				inputMode="numeric"
				required={expirationRequired}
				invalid={expirationInvalid && validationError !== null}
				errorMessage={expirationInvalid ? 'Формат YYYY-MM-DD — обязательно для загран/ВУ' : null}
			/>
		</div>
	)
}

/**
 * Citizenship Select — shadcn Select с 20-country whitelist (ISO-3 + RU labels).
 *
 * Sprint C UX: вместо raw text input, оператор выбирает из dropdown. Снижает
 * вероятность typo + matches PASSPORT_COUNTRY_WHITELIST_SET на backend.
 * «Другая страна» — special value 'OTHER' → оператор оставляет field как
 * raw input (для неклассифицированных passport templates).
 */
function CitizenshipRow({ value, onChange }: { value: string; onChange: (v: string) => void }) {
	const id = useId()
	const errorId = useId()
	const knownValues = useMemo(() => new Set(PASSPORT_COUNTRY_WHITELIST_RU.map((c) => c.iso3)), [])
	// Если OCR вернул unknown ISO-3 — pre-select 'OTHER'.
	const isKnown = value.length === 0 || knownValues.has(value)
	const selectValue = value.length === 0 ? '' : isKnown ? value : 'OTHER'
	const [showRawInput, setShowRawInput] = useState(!isKnown)

	return (
		<div>
			<Label htmlFor={id} className="text-sm">
				Гражданство (ISO-3)
			</Label>
			<Select
				value={selectValue}
				onValueChange={(v) => {
					if (v === 'OTHER') {
						setShowRawInput(true)
						onChange('')
					} else {
						setShowRawInput(false)
						onChange(v)
					}
				}}
			>
				<SelectTrigger id={id} className="mt-1 w-full">
					<SelectValue placeholder="Выберите страну" />
				</SelectTrigger>
				<SelectContent>
					{PASSPORT_COUNTRY_WHITELIST_RU.map((c) => (
						<SelectItem key={c.iso3} value={c.iso3}>
							{c.labelRu} ({c.iso3.toUpperCase()})
						</SelectItem>
					))}
					<SelectItem value="OTHER">Другая страна — ввести вручную</SelectItem>
				</SelectContent>
			</Select>
			{showRawInput ? (
				<Input
					value={value}
					placeholder="ISO 3166-1 alpha-3 (например, jpn)"
					onChange={(e) => onChange(e.target.value.toLowerCase().slice(0, 3))}
					className="mt-2"
					maxLength={3}
					aria-describedby={errorId}
					aria-label="ISO-3 код страны вручную"
				/>
			) : null}
			<p id={errorId} className="sr-only">
				Введите 3-буквенный ISO 3166-1 alpha-3 код страны
			</p>
		</div>
	)
}

function EntityRow({
	label,
	value,
	onChange,
	placeholder,
	autoComplete,
	inputMode,
	required,
	invalid,
	errorMessage,
}: {
	label: string
	value: string
	onChange: (v: string) => void
	placeholder?: string
	autoComplete?: string
	inputMode?: 'text' | 'numeric' | 'tel' | 'email'
	required?: boolean
	invalid?: boolean
	errorMessage?: string | null
}) {
	const id = useId()
	const errorId = useId()
	// Sprint C+1 self-review A6 fix: blur-triggered validation. Field-level error
	// предотвращён до пользователь leaves field — WCAG 3.3.1 «errors identified
	// when detected». `touched` flag bridges "first focus" → user не сразу видит
	// invalid state.
	const [touched, setTouched] = useState(false)
	// Show error если: (1) save attempted (invalid prop true from parent) OR
	// (2) field touched и empty/invalid (local blur detection).
	const showError = invalid === true && typeof errorMessage === 'string' && errorMessage.length > 0
	const shouldHighlight =
		invalid === true || (touched && required === true && value.trim().length === 0)
	return (
		<div>
			<Label htmlFor={id} className="text-sm">
				{label}
				{required === true ? (
					<span className="text-destructive ml-0.5" aria-hidden="true">
						*
					</span>
				) : null}
			</Label>
			<Input
				id={id}
				value={value}
				placeholder={placeholder}
				onChange={(e) => onChange(e.target.value)}
				onBlur={() => setTouched(true)}
				// Round 2 A11y P0-3: scroll-margin-bottom prevents iOS sticky-footer
				// overlap при focused input на mobile keyboard. WCAG 2.4.11 Focus
				// Not Obscured (NEW 2.2 AA). 5rem = footer height + gap.
				className="mt-1 [scroll-margin-bottom:5rem]"
				autoComplete={autoComplete}
				inputMode={inputMode}
				required={required === true ? true : undefined}
				aria-required={required === true ? true : undefined}
				aria-invalid={shouldHighlight ? true : undefined}
				aria-describedby={showError ? errorId : undefined}
			/>
			{showError ? (
				<p id={errorId} className="text-xs text-destructive mt-1" role="alert">
					{errorMessage}
				</p>
			) : null}
		</div>
	)
}
