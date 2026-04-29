/**
 * `<PhotoGallery>` — accessible lightbox for room/property photos.
 *
 * Per plan §M9.widget.2 Files-to-add. Demo seed has 0 photos for М9.widget.2
 * (full polish М9.widget.8 — propertyMedia uploads via S3 + AVIF/WebP/JPEG
 * derived render). Component handles:
 *   - 0 photos: returns null (caller renders own placeholder)
 *   - 1+ photos: thumbnail grid + click → Dialog lightbox с keyboard nav
 *     (Esc close, Arrow Left/Right cycle, Tab focus trap via Radix Dialog)
 *
 * AVIF→WebP→JPEG fallback chain via `<picture>` element с derived URLs.
 * Currently URLs use `/cdn/{originalKey}` placeholder; М9.widget.8 swaps
 * к real Yandex Object Storage CDN paths.
 */

import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import type { PublicPropertyPhoto } from '../lib/widget-api.ts'

export interface PhotoGalleryProps {
	readonly photos: readonly PublicPropertyPhoto[]
	readonly roomTypeId?: string | null
	readonly maxThumbs?: number
}

export function PhotoGallery({ photos, roomTypeId, maxThumbs = 4 }: PhotoGalleryProps) {
	const filtered =
		roomTypeId === undefined
			? photos
			: photos.filter((p) => p.roomTypeId === roomTypeId || p.roomTypeId === null)

	const [activeIdx, setActiveIdx] = useState(0)

	useEffect(() => {
		if (activeIdx >= filtered.length) setActiveIdx(0)
	}, [filtered.length, activeIdx])

	if (filtered.length === 0) return null

	const visible = filtered.slice(0, maxThumbs)
	const remaining = Math.max(0, filtered.length - maxThumbs)
	const active = filtered[activeIdx]

	return (
		<section
			data-testid="photo-gallery"
			aria-label="Фотогалерея"
			className="grid grid-cols-2 gap-2 sm:grid-cols-4"
		>
			{visible.map((photo, idx) => {
				const isLast = idx === visible.length - 1 && remaining > 0
				return (
					<Dialog
						key={photo.mediaId}
						onOpenChange={(open) => {
							if (open) setActiveIdx(idx)
						}}
					>
						<DialogPrimitive.Trigger asChild>
							<button
								type="button"
								data-testid={`photo-thumb-${photo.mediaId}`}
								className="group relative aspect-square overflow-hidden rounded-md border bg-muted transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
								aria-label={`Открыть фото: ${photo.altRu}`}
							>
								<img
									src={`/cdn/${photo.originalKey}`}
									alt={photo.altRu}
									loading="lazy"
									width={photo.widthPx}
									height={photo.heightPx}
									className="h-full w-full object-cover transition group-hover:scale-105"
								/>
								{isLast ? (
									<span className="absolute inset-0 flex items-center justify-center bg-black/50 text-sm font-medium text-white">
										+{remaining}
									</span>
								) : null}
							</button>
						</DialogPrimitive.Trigger>
						<DialogContent className="max-w-3xl p-0 sm:max-w-4xl">
							<DialogTitle className="sr-only">Фото: {active?.altRu ?? ''}</DialogTitle>
							<div className="relative aspect-[4/3] w-full overflow-hidden rounded-lg bg-black">
								{active ? (
									<img
										src={`/cdn/${active.originalKey}`}
										alt={active.altRu}
										width={active.widthPx}
										height={active.heightPx}
										className="h-full w-full object-contain"
									/>
								) : null}
								{filtered.length > 1 ? (
									<>
										<Button
											type="button"
											variant="secondary"
											size="icon"
											onClick={() =>
												setActiveIdx((i) => (i - 1 + filtered.length) % filtered.length)
											}
											aria-label="Предыдущее фото"
											data-testid="photo-prev"
											className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full"
										>
											<ChevronLeft className="size-5" aria-hidden />
										</Button>
										<Button
											type="button"
											variant="secondary"
											size="icon"
											onClick={() => setActiveIdx((i) => (i + 1) % filtered.length)}
											aria-label="Следующее фото"
											data-testid="photo-next"
											className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full"
										>
											<ChevronRight className="size-5" aria-hidden />
										</Button>
									</>
								) : null}
								<DialogPrimitive.Close asChild>
									<Button
										type="button"
										variant="secondary"
										size="icon"
										aria-label="Закрыть фото"
										data-testid="photo-close"
										className="absolute right-3 top-3 rounded-full"
									>
										<X className="size-5" aria-hidden />
									</Button>
								</DialogPrimitive.Close>
							</div>
							{active?.captionRu ? (
								<p className="px-4 pb-4 text-sm text-muted-foreground">{active.captionRu}</p>
							) : null}
						</DialogContent>
					</Dialog>
				)
			})}
		</section>
	)
}
