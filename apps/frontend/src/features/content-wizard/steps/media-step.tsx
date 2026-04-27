import type { PropertyMedia } from '@horeca/shared'
import { useId, useRef, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useCan } from '../../../lib/use-can.ts'
import {
	useDeleteMedia,
	useMediaList,
	usePatchMedia,
	useSetHero,
	useUploadMedia,
} from '../hooks/use-media.ts'
import { useContentWizardStore } from '../wizard-store.ts'

interface Props {
	propertyId: string
}

const ACCEPTED_MIME = 'image/jpeg,image/png,image/heic,image/heif,image/webp'
const MAX_BYTES = 50 * 1024 * 1024
const HERO_INVARIANT_HINT = 'Hero (главное фото) обязано иметь altRu (WCAG 2.2 AA)'

/**
 * Step 4 — Media upload + alt-text + hero designation.
 *
 * Flow per `feedback_aggressive_delegacy.md` (no half-measures):
 *   1. Operator drops or picks file(s) → preflight validates type+size on
 *      client (saves a 50MB → server roundtrip on the obvious wrong cases).
 *   2. For each file, fill `altRu` (required) + optional `altEn` BEFORE
 *      upload — backend enforces the hero altText invariant; we surface it
 *      inline so user doesn't ship a hero with empty alt.
 *   3. Upload via multipart `POST /media/upload` (dev path; M9 swap to
 *      browser-PUT-presign when MinIO/Yandex Object Storage adapter lands).
 *   4. After upload, list shows derived-ready badge + hero toggle + delete.
 *
 * Native HTML5 drag-drop — 1 surface, ~30 LOC. react-dropzone considered
 * but rejected: extra dep for one component, native API is plenty.
 */
export function MediaStep({ propertyId }: Props) {
	const canCreate = useCan({ media: ['create'] })
	const canUpdate = useCan({ media: ['update'] })
	const canDelete = useCan({ media: ['delete'] })
	const next = useContentWizardStore((s) => s.next)
	const headingId = useId()
	const fileInputId = useId()

	const { data: rows = [], isLoading, error } = useMediaList(propertyId)
	const upload = useUploadMedia(propertyId)
	const patch = usePatchMedia(propertyId)
	const del = useDeleteMedia(propertyId)
	const setHero = useSetHero(propertyId)

	const [draftAltRu, setDraftAltRu] = useState('')
	const [draftAltEn, setDraftAltEn] = useState('')
	const [pendingFile, setPendingFile] = useState<File | null>(null)
	const [dragOver, setDragOver] = useState(false)
	const [clientError, setClientError] = useState<string | null>(null)
	const fileInputRef = useRef<HTMLInputElement>(null)

	function preflight(file: File): string | null {
		if (file.size === 0) return 'Файл пуст'
		if (file.size > MAX_BYTES) return 'Файл больше 50 МБ'
		if (!ACCEPTED_MIME.split(',').includes(file.type)) {
			return `Неподдерживаемый формат: ${file.type}. Разрешены JPEG/PNG/HEIC/WebP.`
		}
		return null
	}

	function pickFile(file: File) {
		const err = preflight(file)
		setClientError(err)
		setPendingFile(err === null ? file : null)
	}

	async function onUpload() {
		if (!pendingFile) return
		if (draftAltRu.trim() === '') {
			setClientError('altRu обязательно — без него нельзя сделать фото hero (WCAG)')
			return
		}
		const altEnTrim = draftAltEn.trim()
		await upload.mutateAsync(
			altEnTrim === ''
				? { file: pendingFile, altRu: draftAltRu.trim() }
				: { file: pendingFile, altRu: draftAltRu.trim(), altEn: altEnTrim },
		)
		setPendingFile(null)
		setDraftAltRu('')
		setDraftAltEn('')
		if (fileInputRef.current) fileInputRef.current.value = ''
	}

	if (isLoading) return <p className="text-muted-foreground">Загрузка…</p>
	if (error) {
		return (
			<Alert variant="destructive">
				<AlertTitle>Ошибка загрузки</AlertTitle>
				<AlertDescription>{(error as Error).message}</AlertDescription>
			</Alert>
		)
	}

	return (
		<section aria-labelledby={headingId}>
			<h2 id={headingId} className="text-xl font-semibold">
				Фото гостиницы
			</h2>
			<p className="text-muted-foreground mt-1 text-sm">
				Drag-drop оригинал → обработка sharp (5 размеров × AVIF+WebP + оригинал = 11 файлов). Hero
				(главное фото) видно в карточках поиска и виджетах.
			</p>

			{!canCreate ? (
				<Alert className="mt-4">
					<AlertTitle>Только просмотр</AlertTitle>
					<AlertDescription>Загрузка файлов доступна владельцу или менеджеру.</AlertDescription>
				</Alert>
			) : null}

			{/* ── Drop zone — `<label>` so the entire surface routes click   */}
			{/*    to the hidden file input AND keyboard activation works     */}
			{/*    out-of-the-box (label-for is canonical a11y).               */}
			<label
				htmlFor={fileInputId}
				className={`mt-6 block rounded-md border-2 border-dashed p-6 text-center transition-colors ${
					dragOver ? 'border-primary bg-primary/5' : 'border-border'
				} ${canCreate ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
				onDragOver={(e) => {
					e.preventDefault()
					setDragOver(true)
				}}
				onDragLeave={() => setDragOver(false)}
				onDrop={(e) => {
					e.preventDefault()
					setDragOver(false)
					if (!canCreate) return
					const file = e.dataTransfer.files[0]
					if (file) pickFile(file)
				}}
			>
				<p className="text-muted-foreground text-sm">Перетащите файл сюда или</p>
				<div className="mt-2 flex items-center justify-center gap-2">
					<Label htmlFor={fileInputId} className="sr-only">
						Выбрать файл
					</Label>
					<input
						ref={fileInputRef}
						id={fileInputId}
						type="file"
						accept={ACCEPTED_MIME}
						disabled={!canCreate}
						onChange={(e) => {
							const file = e.target.files?.[0]
							if (file) pickFile(file)
						}}
						className="text-sm"
					/>
				</div>
				<p className="text-muted-foreground mt-2 text-xs">
					JPEG / PNG / HEIC / WebP, до 50 МБ. {HERO_INVARIANT_HINT}
				</p>
			</label>

			{clientError ? (
				<Alert variant="destructive" className="mt-4">
					<AlertTitle>Не удалось принять файл</AlertTitle>
					<AlertDescription>{clientError}</AlertDescription>
				</Alert>
			) : null}

			{pendingFile ? (
				<div className="mt-4 space-y-3 rounded-md border p-4">
					<p className="text-sm">
						<strong>{pendingFile.name}</strong> · {(pendingFile.size / 1024).toFixed(0)} КБ ·{' '}
						{pendingFile.type}
					</p>
					<div className="space-y-1.5">
						<Label htmlFor={`${fileInputId}-altRu`}>altRu (обязательно)</Label>
						<Input
							id={`${fileInputId}-altRu`}
							value={draftAltRu}
							onChange={(e) => setDraftAltRu(e.target.value)}
							maxLength={500}
							required
							placeholder="Например: Вид на море с балкона номера-люкс"
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor={`${fileInputId}-altEn`}>altEn (опционально)</Label>
						<Input
							id={`${fileInputId}-altEn`}
							value={draftAltEn}
							onChange={(e) => setDraftAltEn(e.target.value)}
							maxLength={500}
							placeholder="Sea view from the suite balcony"
						/>
					</div>
					<div className="flex items-center gap-2">
						<Button
							type="button"
							size="sm"
							onClick={() => void onUpload()}
							disabled={upload.isPending || draftAltRu.trim() === ''}
						>
							{upload.isPending ? 'Загружаем…' : 'Загрузить и обработать'}
						</Button>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							onClick={() => {
								setPendingFile(null)
								setDraftAltRu('')
								setDraftAltEn('')
								setClientError(null)
								if (fileInputRef.current) fileInputRef.current.value = ''
							}}
						>
							Отмена
						</Button>
					</div>
				</div>
			) : null}

			{/* ── Existing media list ──────────────────────────────────── */}
			<div className="mt-8">
				<h3 className="text-sm font-medium">
					Загружено: {rows.length} {rows.length === 1 ? 'файл' : 'файлов'}
				</h3>
				{rows.length === 0 ? (
					<p className="text-muted-foreground mt-2 text-sm">Пока нет фото.</p>
				) : (
					<ul className="mt-3 space-y-3">
						{rows.map((row) => (
							<MediaRow
								key={row.mediaId}
								row={row}
								canUpdate={canUpdate}
								canDelete={canDelete}
								onPatch={(p) => patch.mutate({ mediaId: row.mediaId, patch: p })}
								onSetHero={() => setHero.mutate(row.mediaId)}
								onDelete={() => del.mutate(row.mediaId)}
							/>
						))}
					</ul>
				)}
			</div>

			<div className="mt-8">
				<Button type="button" onClick={() => next()}>
					Далее — услуги
				</Button>
			</div>
		</section>
	)
}

interface RowProps {
	row: PropertyMedia
	canUpdate: boolean
	canDelete: boolean
	onPatch: (p: { altRu?: string; altEn?: string | null }) => void
	onSetHero: () => void
	onDelete: () => void
}

function MediaRow({ row, canUpdate, canDelete, onPatch, onSetHero, onDelete }: RowProps) {
	const altRuId = useId()
	const altEnId = useId()
	const [altRu, setAltRu] = useState(row.altRu)
	const [altEn, setAltEn] = useState(row.altEn ?? '')
	const altDirty = altRu !== row.altRu || altEn !== (row.altEn ?? '')

	return (
		<li className="rounded-md border p-3">
			<div className="flex flex-wrap items-start gap-3">
				<div className="flex-1">
					<p className="text-sm">
						<code className="text-xs">{row.mediaId}</code>
						{row.isHero ? (
							<span className="bg-primary text-primary-foreground ml-2 rounded px-2 py-0.5 text-xs">
								Hero
							</span>
						) : null}
						{row.derivedReady ? (
							<span className="bg-green-100 text-green-900 dark:bg-green-900 dark:text-green-100 ml-2 rounded px-2 py-0.5 text-xs">
								Обработано
							</span>
						) : (
							<span className="bg-yellow-100 text-yellow-900 dark:bg-yellow-900 dark:text-yellow-100 ml-2 rounded px-2 py-0.5 text-xs">
								В обработке
							</span>
						)}
					</p>
					<p className="text-muted-foreground mt-1 text-xs">
						{row.widthPx}×{row.heightPx} · {(Number(row.fileSizeBytes) / 1024).toFixed(0)} КБ ·{' '}
						{row.mimeType}
					</p>
					<div className="mt-2 space-y-2">
						<div className="space-y-1">
							<Label htmlFor={altRuId} className="text-xs">
								altRu
							</Label>
							<Input
								id={altRuId}
								value={altRu}
								onChange={(e) => setAltRu(e.target.value)}
								disabled={!canUpdate}
								maxLength={500}
							/>
						</div>
						<div className="space-y-1">
							<Label htmlFor={altEnId} className="text-xs">
								altEn
							</Label>
							<Input
								id={altEnId}
								value={altEn}
								onChange={(e) => setAltEn(e.target.value)}
								disabled={!canUpdate}
								maxLength={500}
							/>
						</div>
					</div>
				</div>
				<div className="flex flex-col gap-2">
					<Button
						type="button"
						size="sm"
						variant="outline"
						disabled={!canUpdate || !altDirty}
						onClick={() =>
							onPatch({
								altRu,
								altEn: altEn.trim() === '' ? null : altEn,
							})
						}
					>
						Сохранить alt
					</Button>
					{!row.isHero ? (
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={!canUpdate || row.altRu.trim() === ''}
							onClick={onSetHero}
							title={row.altRu.trim() === '' ? HERO_INVARIANT_HINT : undefined}
						>
							Сделать hero
						</Button>
					) : null}
					<Button
						type="button"
						size="sm"
						variant="destructive"
						disabled={!canDelete}
						onClick={onDelete}
					>
						Удалить
					</Button>
				</div>
			</div>
		</li>
	)
}
