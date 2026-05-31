/**
 * IdentifyStep — strict tests (placeholder-as-default UX-trap fix, 2026-05-14).
 *
 * Pre-done audit:
 *   [A1] Confirm DaData party when activeOrg.name == default placeholder
 *        → authClient.organization.update called с {data:{name: party.name}}
 *        + wizard advances к step 'inventory'.
 *   [A2] Confirm DaData party when activeOrg.name customized («МойОтель»)
 *        → update NOT called (user intent preserved); wizard still advances.
 *   [A3] BA update rejection → wizard still advances (fail-soft canon).
 *   [A4] Manual-override path (party=null) → update NOT called.
 *
 * Mocking strategy:
 *   - `@/lib/auth-client` → mock authClient.organization.update +
 *     authClient.organization.list (used by useActiveOrg via useOrgList).
 *   - sessionQueryOptions stub returns a session shape carrying
 *     activeOrganizationId so useActiveOrg can match against org.list.
 *   - `useFindByInn` is bypassed by directly seeding the wizard store
 *     with a party before render — exercises confirm path without the
 *     mutation roundtrip.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type * as React from 'react'
import type { DaDataParty } from '../lib/dadata.ts'

const organizationUpdateMock = mock()
const organizationListMock = mock()

await mock.module('@/lib/auth-client', () => ({
	authClient: {
		organization: {
			update: organizationUpdateMock,
			list: organizationListMock,
		},
	},
	sessionQueryOptions: {
		queryKey: ['auth', 'session'] as const,
		queryFn: async () => ({ session: { activeOrganizationId: 'org-1' } }),
	},
}))

const { IdentifyStep } = await import('./identify-step.tsx')
const { useWizardStore } = await import('../wizard-store.ts')
const { DEFAULT_WELCOME_ORG_NAME } = await import('@/features/auth/lib/welcome-defaults')

const PARTY: DaDataParty = {
	inn: '7709758887',
	ogrn: '1077760619672',
	name: 'ООО «Сочи-Парк Отель»',
	legalForm: 'LEGAL',
	address: 'Краснодарский край, пгт Сириус, Континентальный пр-кт, д 6, офис 4',
	city: 'Сириус',
	taxRegime: 'UNKNOWN',
	status: 'ACTIVE',
}

function renderWithQuery(ui: React.ReactElement, sessionActiveOrgId = 'org-1') {
	const queryClient = new QueryClient({
		defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
	})
	queryClient.setQueryData(['auth', 'session'], {
		session: { activeOrganizationId: sessionActiveOrgId },
	})
	return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

function seedActiveOrgName(name: string) {
	organizationListMock.mockReturnValue(
		Promise.resolve({ data: [{ id: 'org-1', name, slug: 'whatever' }] }),
	)
}

beforeEach(() => {
	useWizardStore.getState().reset()
	organizationUpdateMock.mockReset()
	organizationListMock.mockReset()
	organizationUpdateMock.mockReturnValue(Promise.resolve({ data: {} }))
})

afterEach(() => {
	cleanup()
})

describe('IdentifyStep — DaData party wins org rename canon (2026-05-22)', () => {
	it('[A1] confirm с DaData party + default-placeholder orgName → org.update({name: party.name}) + step→inventory', async () => {
		seedActiveOrgName(DEFAULT_WELCOME_ORG_NAME)
		useWizardStore.setState({ party: PARTY, manualOverride: false })

		renderWithQuery(<IdentifyStep />)
		await waitFor(() => {
			expect(screen.queryByText('ООО «Сочи-Парк Отель»')).not.toBe(null)
		})

		await userEvent.setup().click(screen.getByRole('button', { name: /Подтвердить/ }))

		await waitFor(() => {
			expect(organizationUpdateMock).toHaveBeenCalledTimes(1)
		})
		expect(organizationUpdateMock.mock.calls[0]).toEqual([
			{ data: { name: 'ООО «Сочи-Парк Отель»' } },
		])
		await waitFor(() => {
			expect(useWizardStore.getState().step).toBe('inventory')
		})
	})

	it('[A2] confirm с DaData party + CUSTOM orgName differing from party → ALSO update (DaData wins)', async () => {
		// Canon change 2026-05-22: prior gating «only rename if name === placeholder»
		// пропускало случай когда user в /welcome ввёл custom value (e.g. ИНН вместо
		// org name) → sidebar показывал «2310123920» при property header «ПАО
		// СБЕРБАНК». New canon: DaData party.name всегда выигрывает (single source
		// of truth для legal entity name).
		seedActiveOrgName('МойОтель Pro')
		useWizardStore.setState({ party: PARTY, manualOverride: false })

		renderWithQuery(<IdentifyStep />)
		await waitFor(() => {
			expect(screen.queryByText('ООО «Сочи-Парк Отель»')).not.toBe(null)
		})

		await userEvent.setup().click(screen.getByRole('button', { name: /Подтвердить/ }))

		await waitFor(() => {
			expect(organizationUpdateMock).toHaveBeenCalledTimes(1)
		})
		expect(organizationUpdateMock.mock.calls[0]).toEqual([
			{ data: { name: 'ООО «Сочи-Парк Отель»' } },
		])
		await waitFor(() => {
			expect(useWizardStore.getState().step).toBe('inventory')
		})
	})

	it('[A2b] confirm с orgName ALREADY equal к party.name → update NOT called (no-op)', async () => {
		// Idempotency check — if names already match, skip the BA call entirely.
		seedActiveOrgName('ООО «Сочи-Парк Отель»')
		useWizardStore.setState({ party: PARTY, manualOverride: false })

		renderWithQuery(<IdentifyStep />)
		await waitFor(() => {
			expect(screen.queryByText('ООО «Сочи-Парк Отель»')).not.toBe(null)
		})

		await userEvent.setup().click(screen.getByRole('button', { name: /Подтвердить/ }))

		await waitFor(() => {
			expect(useWizardStore.getState().step).toBe('inventory')
		})
		expect(organizationUpdateMock).toHaveBeenCalledTimes(0)
	})

	it('[A3] BA org.update rejects → wizard still advances (fail-soft)', async () => {
		seedActiveOrgName(DEFAULT_WELCOME_ORG_NAME)
		useWizardStore.setState({ party: PARTY, manualOverride: false })
		organizationUpdateMock.mockImplementation(() => Promise.reject(new Error('boom')))

		renderWithQuery(<IdentifyStep />)
		await waitFor(() => {
			expect(screen.queryByText('ООО «Сочи-Парк Отель»')).not.toBe(null)
		})

		await userEvent.setup().click(screen.getByRole('button', { name: /Подтвердить/ }))

		await waitFor(() => {
			expect(useWizardStore.getState().step).toBe('inventory')
		})
		expect(organizationUpdateMock).toHaveBeenCalledTimes(1)
	})

	it('[A4] manual-override path (party=null) → update NOT called', async () => {
		seedActiveOrgName(DEFAULT_WELCOME_ORG_NAME)
		useWizardStore.setState({ party: null, manualOverride: false })

		renderWithQuery(<IdentifyStep />)

		await userEvent.setup().click(screen.getByRole('button', { name: /Заполнить вручную/ }))

		await waitFor(() => {
			expect(useWizardStore.getState().step).toBe('inventory')
		})
		expect(organizationUpdateMock).toHaveBeenCalledTimes(0)
	})
})
