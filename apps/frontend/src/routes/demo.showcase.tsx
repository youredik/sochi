/**
 * Round 9 — sales-demo side-by-side showcase route.
 *
 * Mounts at `/demo/showcase` — full-bleed split-pane layout that lets the
 * presenter demonstrate the «book on Yandex.Путешествия → reservation appears
 * в PMS grid» loop в one screen. Supports optional `?channel=ostrovok`
 * search param to default the left iframe to the Островок side.
 *
 * **NOT auth-gated** — the demo URL is meant to be openable from a fresh
 * incognito session при sales presentations. The admin POST endpoints
 * (`/api/_mock-ota/admin/*`) are also unauthed — defense via env-gate at
 * the backend `_demo/` mount site.
 */
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { ShowcasePage } from '../_demo/side-by-side/showcase-page.tsx'

const searchSchema = z.object({
	channel: z.enum(['yandex', 'ostrovok']).optional(),
})

export const Route = createFileRoute('/demo/showcase')({
	component: DemoShowcaseRoute,
	validateSearch: searchSchema,
})

function DemoShowcaseRoute() {
	const search = Route.useSearch()
	return <ShowcasePage initialChannel={search.channel ?? 'yandex'} />
}
