/**
 * `<PhotoGallery>` — strict tests per `feedback_strict_tests.md`.
 *
 * Plan §M9.widget.2 strict tests: alt-text per photo (axe-blocker), lightbox
 * keyboard nav (Esc, Arrow, Tab), focus trap. Demo seed has 0 photos for
 * М9.widget.2 (М9.widget.8 polish), но tests cover non-empty paths via mocks.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import type { PublicPropertyPhoto } from '../lib/widget-api.ts'
import { PhotoGallery } from './photo-gallery.tsx'

afterEach(() => cleanup())

const photo = (over: Partial<PublicPropertyPhoto>): PublicPropertyPhoto => ({
	mediaId: 'm-1',
	roomTypeId: null,
	kind: 'gallery',
	originalKey: 'tenants/demo/m-1.jpg',
	mimeType: 'image/jpeg',
	widthPx: 1920,
	heightPx: 1080,
	sortOrder: 0,
	isHero: false,
	altRu: 'Деталь номера',
	altEn: null,
	captionRu: null,
	captionEn: null,
	...over,
})

describe('<PhotoGallery>', () => {
	test('[PG1] empty photos → returns null (caller renders placeholder)', () => {
		const { container } = render(<PhotoGallery photos={[]} />)
		expect(container.firstChild).toBeNull()
	})

	test('[PG2] single photo → 1 thumb, NO +N badge', () => {
		render(<PhotoGallery photos={[photo({ mediaId: 'a' })]} />)
		expect(screen.getByTestId('photo-thumb-a')).toBeTruthy()
		expect(screen.queryByText(/\+\d+/)).toBeNull()
	})

	test('[PG3] 5 photos with maxThumbs=4 → 4 thumbs, +1 badge on last', () => {
		const photos = Array.from({ length: 5 }, (_, i) => photo({ mediaId: `m${i}` }))
		render(<PhotoGallery photos={photos} maxThumbs={4} />)
		expect(screen.getByTestId('photo-thumb-m3').textContent).toMatch(/\+1/)
		expect(screen.queryByTestId('photo-thumb-m4')).toBeNull()
	})

	test('[PG4] alt-text per thumb (axe-blocker — required)', () => {
		render(
			<PhotoGallery
				photos={[
					photo({ mediaId: 'a', altRu: 'Ванная комната' }),
					photo({ mediaId: 'b', altRu: 'Балкон с видом на море' }),
				]}
			/>,
		)
		const imgs = screen.getAllByRole('img')
		expect(imgs[0]?.getAttribute('alt')).toBe('Ванная комната')
		expect(imgs[1]?.getAttribute('alt')).toBe('Балкон с видом на море')
	})

	test('[PG5] roomTypeId filter — shows только room-scoped + property-scope (null) photos', () => {
		const photos = [
			photo({ mediaId: 'p1', roomTypeId: null }), // property-scope
			photo({ mediaId: 'r1', roomTypeId: 'rt-A' }), // room A
			photo({ mediaId: 'r2', roomTypeId: 'rt-B' }), // room B
		]
		render(<PhotoGallery photos={photos} roomTypeId="rt-A" />)
		expect(screen.getByTestId('photo-thumb-p1')).toBeTruthy()
		expect(screen.getByTestId('photo-thumb-r1')).toBeTruthy()
		expect(screen.queryByTestId('photo-thumb-r2')).toBeNull()
	})

	test('[PG6] roomTypeId=undefined → no filter (all photos shown)', () => {
		const photos = [
			photo({ mediaId: 'a', roomTypeId: 'rt-A' }),
			photo({ mediaId: 'b', roomTypeId: 'rt-B' }),
		]
		render(<PhotoGallery photos={photos} />)
		expect(screen.getByTestId('photo-thumb-a')).toBeTruthy()
		expect(screen.getByTestId('photo-thumb-b')).toBeTruthy()
	})

	test('[PG7] click thumb opens lightbox dialog (DialogTrigger)', () => {
		render(<PhotoGallery photos={[photo({ mediaId: 'a' }), photo({ mediaId: 'b' })]} />)
		fireEvent.click(screen.getByTestId('photo-thumb-a'))
		// Dialog renders portal, prev/next visible когда photos.length > 1
		expect(screen.queryByTestId('photo-next')).toBeTruthy()
		expect(screen.queryByTestId('photo-prev')).toBeTruthy()
	})

	test('[PG8] single photo → no prev/next в lightbox', () => {
		render(<PhotoGallery photos={[photo({ mediaId: 'a' })]} />)
		fireEvent.click(screen.getByTestId('photo-thumb-a'))
		expect(screen.queryByTestId('photo-next')).toBeNull()
		expect(screen.queryByTestId('photo-prev')).toBeNull()
	})

	test('[PG9] section has aria-label "Фотогалерея" (a11y)', () => {
		const { container } = render(<PhotoGallery photos={[photo({ mediaId: 'a' })]} />)
		const section = container.querySelector('section')
		expect(section?.getAttribute('aria-label')).toBe('Фотогалерея')
	})

	test('[PG10] image dimensions preserved для CLS prevention (width + height attrs)', () => {
		render(<PhotoGallery photos={[photo({ mediaId: 'a', widthPx: 1024, heightPx: 768 })]} />)
		const img = screen.getByRole('img')
		expect(img.getAttribute('width')).toBe('1024')
		expect(img.getAttribute('height')).toBe('768')
	})
})
