/**
 * Round 9 — sales-demo OTA showcase layout root.
 *
 * Layout route at `/demo` — provides a shared Outlet for `/demo/ota/yandex/*`
 * and `/demo/ota/ostrovok/*` sub-routes. Public (no auth gate) — the demo
 * is meant to be shown в sales presentations from a fresh incognito session.
 *
 * No auth, no AdminSidebar, no AppShell — Round 9 canon: «visitor sees
 * mock OTA UI, not our PMS chrome». Sub-routes mount full-bleed pages
 * с their own brand-safe headers.
 */
import { createFileRoute, Outlet } from '@tanstack/react-router'

export const Route = createFileRoute('/demo')({
	component: () => <Outlet />,
})
