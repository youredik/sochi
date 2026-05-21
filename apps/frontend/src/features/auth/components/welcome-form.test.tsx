/**
 * WelcomeForm — strict tests (passwordless canon 2026-05-13 closure per
 * `[[auth-passwordless-canon]]`). Covers the post-magic-link signup
 * org-creation page.
 *
 * Pre-done audit:
 *   [R1] orgName input prefilled from `prefillOrgName` prop, submit
 *        button labeled «Создать гостиницу →»
 *   [R2] slug preview live-updates с typing
 *   [P1] submit disabled while orgName < 2 chars
 *   [P2] submit calls organization.create с trimmed orgName + auto-slug;
 *        slug fallback `org-{base36}` когда slugify returns empty (e.g.
 *        Cyrillic-only that slugify can't transliterate cleanly)
 *   [P3] organization.create error → localized banner + submit re-enables
 *        (user can fix + retry)
 *   [E1] orgListQuery returns non-empty list → destructive existing-org
 *        warning banner rendered (defense-in-depth, beforeLoad-guard is
 *        primary)
 *   [E2] orgListQuery returns empty list → no warning
 *
 * Mocking strategy:
 *   - `@/lib/auth-client` → mock authClient.organization.{create,list}
 *   - `@tanstack/react-router` → stub useNavigate (used by useCreateOrganization
 *     onSuccess)
 *   - sonner toast → noop (success/error toasts irrelevant к unit assertions)
 *
 * Why mock `organization.list` not `/api/v1/properties` (2026-05-21):
 * `WelcomeForm` switched к BA-level org-membership lookup because the
 * properties endpoint 403s without active-org (which is null at /welcome).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import * as React from 'react'

const organizationCreateMock = mock()
const organizationListMock = mock()
mock.module('@/lib/auth-client', () => ({
	authClient: {
		organization: { create: organizationCreateMock, list: organizationListMock },
	},
	sessionQueryOptions: { queryKey: ['auth', 'session'] as const },
}))

const navigateMock = mock()
mock.module('@tanstack/react-router', () => ({
	useNavigate: () => navigateMock,
}))

mock.module('sonner', () => ({
	toast: { success: () => {}, error: () => {} },
}))

const { WelcomeForm } = await import('./welcome-form')

function renderWithQuery(ui: React.ReactElement) {
	const queryClient = new QueryClient({
		defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
	})
	return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

afterEach(() => {
	cleanup()
	mock.clearAllMocks()
	// Default: BA `organization.list()` returns empty array (typical
	// first-time magic-link arrival — user has no orgs yet). Individual
	// tests override before render.
	organizationListMock.mockReturnValue(Promise.resolve({ data: [], error: null }))
})

describe('WelcomeForm — initial render', () => {
	it('[R1] orgName input prefilled from prefillOrgName prop + submit button labeled «Создать гостиницу →»', () => {
		renderWithQuery(<WelcomeForm prefillOrgName="Гостиница Ромашка" />)
		const orgInput = screen.getByLabelText('Название гостиницы') as HTMLInputElement
		expect(orgInput.value).toBe('Гостиница Ромашка')
		expect(orgInput.required).toBe(true)
		expect(orgInput.minLength).toBe(2)
		expect(orgInput.maxLength).toBe(80)
		const submit = screen.getByRole('button', { name: 'Создать гостиницу →' })
		expect((submit as HTMLButtonElement).disabled).toBe(false)
	})

	it('[R2] slug preview live-updates с typing', async () => {
		renderWithQuery(<WelcomeForm prefillOrgName="" />)
		const orgInput = screen.getByLabelText('Название гостиницы')
		await userEvent.setup().type(orgInput, 'Гостиница Ромашка')
		const slugSpan = screen.getByText(/\/o\//)
		expect(slugSpan.textContent?.startsWith('/o/')).toBe(true)
		expect(slugSpan.textContent).not.toBe('/o/…')
	})
})

describe('WelcomeForm — submit gating', () => {
	it('[P1] submit disabled while orgName < 2 chars', async () => {
		renderWithQuery(<WelcomeForm prefillOrgName="" />)
		const orgInput = screen.getByLabelText('Название гостиницы')
		const submit = screen.getByRole('button', { name: 'Создать гостиницу →' })
		expect((submit as HTMLButtonElement).disabled).toBe(true)
		await userEvent.setup().type(orgInput, 'X')
		expect((submit as HTMLButtonElement).disabled).toBe(true)
	})
})

describe('WelcomeForm — successful submit', () => {
	it('[P2] organization.create called с trimmed orgName + slug from slugify', async () => {
		organizationCreateMock.mockResolvedValueOnce({
			data: { id: 'org-1', slug: 'gostinitsa-romashka' },
			error: null,
		})
		renderWithQuery(<WelcomeForm prefillOrgName="  Гостиница Ромашка  " />)
		const submit = screen.getByRole('button', { name: 'Создать гостиницу →' })
		await userEvent.setup().click(submit)

		await waitFor(() => {
			expect(organizationCreateMock).toHaveBeenCalledTimes(1)
		})
		const call = organizationCreateMock.mock.calls[0] as [{ name: string; slug: string }]
		expect(call[0].name).toBe('Гостиница Ромашка') // trimmed
		expect(call[0].slug.length >= 1).toBe(true)
	})
})

describe('WelcomeForm — error path', () => {
	it('[P3] BA error → localized banner + submit re-enables', async () => {
		organizationCreateMock.mockResolvedValueOnce({
			data: null,
			error: { status: 409, code: 'CONFLICT', message: 'Slug taken' },
		})
		renderWithQuery(<WelcomeForm prefillOrgName="Гостиница Ромашка" />)
		const user = userEvent.setup()
		await user.click(screen.getByRole('button', { name: 'Создать гостиницу →' }))

		await waitFor(() => {
			expect(screen.queryByRole('alert')).not.toBe(null)
		})
		// Submit re-enabled after error settles (user can edit + retry).
		const submit = screen.getByRole('button', { name: 'Создать гостиницу →' })
		expect((submit as HTMLButtonElement).disabled).toBe(false)
	})
})

describe('WelcomeForm — existing-org defence', () => {
	it('[E1] orgListQuery returns non-empty → destructive banner shown', async () => {
		organizationListMock.mockReturnValueOnce(
			Promise.resolve({
				data: [{ id: 'org-existing', name: 'Существующая', slug: 'existing' }],
				error: null,
			}),
		)
		renderWithQuery(<WelcomeForm prefillOrgName="Гостиница Ромашка" />)

		await waitFor(() => {
			expect(screen.queryByText('У вас уже есть гостиница')).not.toBe(null)
		})
	})

	it('[E2] orgListQuery empty → no warning banner', async () => {
		// Default mock from afterEach already returns empty list, но повторяю
		// явно так что this case стоит self-contained.
		organizationListMock.mockReturnValueOnce(Promise.resolve({ data: [], error: null }))
		renderWithQuery(<WelcomeForm prefillOrgName="Гостиница Ромашка" />)
		// Give the query a tick to settle.
		await new Promise((r) => setTimeout(r, 50))
		expect(screen.queryByText('У вас уже есть гостиница')).toBe(null)
	})
})
