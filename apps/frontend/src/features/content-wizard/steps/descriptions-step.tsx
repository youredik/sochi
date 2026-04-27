import {
	type PropertyDescription,
	type PropertyDescriptionInput,
	type PropertyDescriptionLocale,
	type PropertyDescriptionSectionKey,
	propertyDescriptionLocaleValues,
	propertyDescriptionSectionKeys,
} from '@horeca/shared'
import { useEffect, useId, useMemo, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useCan } from '../../../lib/use-can.ts'
import { useDescriptions, useUpsertDescription } from '../hooks/use-descriptions.ts'
import { useContentWizardStore } from '../wizard-store.ts'

interface Props {
	propertyId: string
}

/**
 * Step 3 — Per-locale (ru/en) descriptions × 8 sections.
 *
 * Architecture:
 *   - Top-level Tabs component (locale switch). Each tab owns its own
 *     editable form state (Map<locale, draft>) so user can switch back-
 *     and-forth without losing input.
 *   - Inside each tab: top fields (title/tagline/summary/long) + 8
 *     section textareas + SEO triplet at the bottom.
 *   - Save button issues PUT for the active locale only. The other locale
 *     is unaffected (independent rows in DB).
 *
 * Schema.org JSON-LD preview deferred — backend already emits it on the
 * widget endpoint; UI preview is nice-to-have, not blocker for M8.A.
 *
 * Section keys are *typed* (PropertyDescriptionSectionKey union) so adding
 * a new section in shared schema is one-line catch-up here (compile error
 * surfaces the gap).
 */

const LOCALE_LABELS: Record<PropertyDescriptionLocale, string> = {
	ru: 'Русский',
	en: 'English',
}

const SECTION_LABELS: Record<PropertyDescriptionSectionKey, string> = {
	location: 'Расположение',
	services: 'Услуги',
	rooms: 'Номера',
	dining: 'Питание',
	activities: 'Активности',
	family: 'Для семей',
	accessibility: 'Доступная среда',
	pets: 'С питомцами',
}

interface DraftValues {
	title: string
	tagline: string
	summaryMd: string
	longDescriptionMd: string
	sections: Record<PropertyDescriptionSectionKey, string>
	seoMetaTitle: string
	seoMetaDescription: string
	seoH1: string
}

function emptyDraft(): DraftValues {
	const sections = Object.fromEntries(propertyDescriptionSectionKeys.map((k) => [k, ''])) as Record<
		PropertyDescriptionSectionKey,
		string
	>
	return {
		title: '',
		tagline: '',
		summaryMd: '',
		longDescriptionMd: '',
		sections,
		seoMetaTitle: '',
		seoMetaDescription: '',
		seoH1: '',
	}
}

function fromRow(row: PropertyDescription): DraftValues {
	const sections = Object.fromEntries(
		propertyDescriptionSectionKeys.map((k) => [k, row.sections[k] ?? '']),
	) as Record<PropertyDescriptionSectionKey, string>
	return {
		title: row.title,
		tagline: row.tagline ?? '',
		summaryMd: row.summaryMd,
		longDescriptionMd: row.longDescriptionMd ?? '',
		sections,
		seoMetaTitle: row.seoMetaTitle ?? '',
		seoMetaDescription: row.seoMetaDescription ?? '',
		seoH1: row.seoH1 ?? '',
	}
}

function toInput(draft: DraftValues): PropertyDescriptionInput {
	const sections: Record<string, string> = {}
	for (const k of propertyDescriptionSectionKeys) {
		const v = draft.sections[k].trim()
		if (v !== '') sections[k] = v
	}
	const nonEmptyOrNull = (s: string) => (s.trim() === '' ? null : s.trim())
	return {
		title: draft.title.trim(),
		tagline: nonEmptyOrNull(draft.tagline),
		summaryMd: draft.summaryMd.trim(),
		longDescriptionMd: nonEmptyOrNull(draft.longDescriptionMd),
		sections,
		seoMetaTitle: nonEmptyOrNull(draft.seoMetaTitle),
		seoMetaDescription: nonEmptyOrNull(draft.seoMetaDescription),
		seoH1: nonEmptyOrNull(draft.seoH1),
	}
}

export function DescriptionsStep({ propertyId }: Props) {
	const canUpdate = useCan({ description: ['create', 'update'] })
	const { data: rows, isLoading, error } = useDescriptions(propertyId)
	const upsert = useUpsertDescription(propertyId)
	const next = useContentWizardStore((s) => s.next)
	const headingId = useId()

	const [activeLocale, setActiveLocale] = useState<PropertyDescriptionLocale>('ru')
	const [drafts, setDrafts] = useState<Record<PropertyDescriptionLocale, DraftValues> | null>(null)

	// Hydrate drafts from server once (or once per propertyId change).
	useEffect(() => {
		if (!rows) return
		setDrafts((prev) => {
			if (prev !== null) return prev
			const init: Record<PropertyDescriptionLocale, DraftValues> = {
				ru: emptyDraft(),
				en: emptyDraft(),
			}
			for (const row of rows) init[row.locale] = fromRow(row)
			return init
		})
	}, [rows])

	const activeDraft = useMemo<DraftValues>(
		() => drafts?.[activeLocale] ?? emptyDraft(),
		[drafts, activeLocale],
	)

	function patchDraft(patch: Partial<DraftValues>) {
		setDrafts((prev) => {
			const base: Record<PropertyDescriptionLocale, DraftValues> = prev ?? {
				ru: emptyDraft(),
				en: emptyDraft(),
			}
			return { ...base, [activeLocale]: { ...base[activeLocale], ...patch } }
		})
	}

	function patchSection(key: PropertyDescriptionSectionKey, value: string) {
		setDrafts((prev) => {
			const base: Record<PropertyDescriptionLocale, DraftValues> = prev ?? {
				ru: emptyDraft(),
				en: emptyDraft(),
			}
			const cur = base[activeLocale]
			return {
				...base,
				[activeLocale]: { ...cur, sections: { ...cur.sections, [key]: value } },
			}
		})
	}

	async function onSave() {
		if (activeDraft.title.trim() === '' || activeDraft.summaryMd.trim() === '') {
			// Server enforces; surface inline so user doesn't waste a roundtrip.
			return
		}
		await upsert.mutateAsync({ locale: activeLocale, input: toInput(activeDraft) })
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

	const minRequiredOk = activeDraft.title.trim() !== '' && activeDraft.summaryMd.trim() !== ''

	return (
		<section aria-labelledby={headingId}>
			<h2 id={headingId} className="text-xl font-semibold">
				Описание гостиницы
			</h2>
			<p className="text-muted-foreground mt-1 text-sm">
				Two-locale (ru/en) × 8 секций. Поля ≤ лимитов SEO 2026 (meta-title 70, description 160).
				Schema.org JSON-LD генерируется бэкендом для виджета.
			</p>

			{!canUpdate ? (
				<Alert className="mt-4">
					<AlertTitle>Только просмотр</AlertTitle>
					<AlertDescription>Редактирование доступно владельцу или менеджеру.</AlertDescription>
				</Alert>
			) : null}

			<Tabs
				value={activeLocale}
				onValueChange={(v) => setActiveLocale(v as PropertyDescriptionLocale)}
				className="mt-6"
			>
				<TabsList>
					{propertyDescriptionLocaleValues.map((l) => (
						<TabsTrigger key={l} value={l}>
							{LOCALE_LABELS[l]}
						</TabsTrigger>
					))}
				</TabsList>

				{propertyDescriptionLocaleValues.map((l) => (
					<TabsContent key={l} value={l} className="mt-6 space-y-5">
						{l === activeLocale ? (
							<DescriptionEditor
								draft={activeDraft}
								canEdit={canUpdate}
								locale={l}
								onPatch={patchDraft}
								onSection={patchSection}
							/>
						) : null}
					</TabsContent>
				))}
			</Tabs>

			<div className="mt-8 flex items-center gap-3">
				<Button
					type="button"
					size="lg"
					onClick={() => void onSave()}
					disabled={!canUpdate || !minRequiredOk || upsert.isPending}
				>
					{upsert.isPending ? 'Сохраняем…' : `Сохранить (${LOCALE_LABELS[activeLocale]})`}
				</Button>
				<Button type="button" variant="ghost" onClick={() => next()}>
					Далее — фото
				</Button>
			</div>
			{!minRequiredOk ? (
				<p className="text-muted-foreground mt-2 text-xs">
					Заполните «Заголовок» и «Краткое описание» — обязательны для сохранения.
				</p>
			) : null}
		</section>
	)
}

interface EditorProps {
	draft: DraftValues
	canEdit: boolean
	locale: PropertyDescriptionLocale
	onPatch: (p: Partial<DraftValues>) => void
	onSection: (k: PropertyDescriptionSectionKey, v: string) => void
}

function DescriptionEditor({ draft, canEdit, locale, onPatch, onSection }: EditorProps) {
	const titleId = useId()
	const taglineId = useId()
	const summaryId = useId()
	const longId = useId()
	const seoTitleId = useId()
	const seoDescId = useId()
	const seoH1Id = useId()
	return (
		<div className="space-y-5">
			<div className="space-y-1.5">
				<Label htmlFor={titleId}>Заголовок</Label>
				<Input
					id={titleId}
					value={draft.title}
					onChange={(e) => onPatch({ title: e.target.value })}
					disabled={!canEdit}
					maxLength={200}
					required
					placeholder={
						locale === 'ru' ? 'Гостиница на Имеретинке' : 'Boutique hotel in Sirius district'
					}
				/>
			</div>

			<div className="space-y-1.5">
				<Label htmlFor={taglineId}>Подзаголовок (tagline)</Label>
				<Input
					id={taglineId}
					value={draft.tagline}
					onChange={(e) => onPatch({ tagline: e.target.value })}
					disabled={!canEdit}
					maxLength={100}
					placeholder={locale === 'ru' ? '5 минут до моря' : '5 minutes from the sea'}
				/>
				<p className="text-muted-foreground text-xs">≤ 100 символов</p>
			</div>

			<div className="space-y-1.5">
				<Label htmlFor={summaryId}>Краткое описание (Markdown)</Label>
				<Textarea
					id={summaryId}
					value={draft.summaryMd}
					onChange={(e) => onPatch({ summaryMd: e.target.value })}
					disabled={!canEdit}
					maxLength={800}
					rows={4}
					required
				/>
				<p className="text-muted-foreground text-xs">≤ 800 символов</p>
			</div>

			<div className="space-y-1.5">
				<Label htmlFor={longId}>Полное описание (Markdown)</Label>
				<Textarea
					id={longId}
					value={draft.longDescriptionMd}
					onChange={(e) => onPatch({ longDescriptionMd: e.target.value })}
					disabled={!canEdit}
					maxLength={16_000}
					rows={8}
				/>
				<p className="text-muted-foreground text-xs">≤ 16000 символов</p>
			</div>

			<fieldset className="border-border rounded-md border p-4">
				<legend className="px-2 text-sm font-medium">Секции</legend>
				<div className="space-y-4">
					{propertyDescriptionSectionKeys.map((key) => (
						<div key={key} className="space-y-1.5">
							<Label htmlFor={`section-${key}`}>{SECTION_LABELS[key]}</Label>
							<Textarea
								id={`section-${key}`}
								value={draft.sections[key]}
								onChange={(e) => onSection(key, e.target.value)}
								disabled={!canEdit}
								maxLength={8000}
								rows={4}
							/>
						</div>
					))}
				</div>
			</fieldset>

			<fieldset className="border-border rounded-md border p-4">
				<legend className="px-2 text-sm font-medium">SEO</legend>
				<div className="space-y-4">
					<div className="space-y-1.5">
						<Label htmlFor={seoTitleId}>Meta title</Label>
						<Input
							id={seoTitleId}
							value={draft.seoMetaTitle}
							onChange={(e) => onPatch({ seoMetaTitle: e.target.value })}
							disabled={!canEdit}
							maxLength={70}
						/>
						<p className="text-muted-foreground text-xs">≤ 70 символов (SERP truncation)</p>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor={seoDescId}>Meta description</Label>
						<Input
							id={seoDescId}
							value={draft.seoMetaDescription}
							onChange={(e) => onPatch({ seoMetaDescription: e.target.value })}
							disabled={!canEdit}
							maxLength={160}
						/>
						<p className="text-muted-foreground text-xs">≤ 160 символов</p>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor={seoH1Id}>H1</Label>
						<Input
							id={seoH1Id}
							value={draft.seoH1}
							onChange={(e) => onPatch({ seoH1: e.target.value })}
							disabled={!canEdit}
							maxLength={200}
						/>
					</div>
				</div>
			</fieldset>
		</div>
	)
}
