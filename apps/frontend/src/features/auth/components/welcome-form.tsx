import { type FormEvent, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useOrgList } from '../../tenancy/hooks/use-active-org.ts'
import { useCreateOrganization } from '../hooks/use-auth-mutations.ts'
import { slugify } from '../lib/slugify.ts'

import { DEFAULT_WELCOME_ORG_NAME } from '../lib/welcome-defaults.ts'

interface WelcomeFormProps {
	/** orgName extracted from /welcome?n=… query — magic-link signup callback. */
	prefillOrgName?: string | undefined
}

/**
 * /welcome page form — post-magic-link signup completion (passwordless canon
 * 2026-05-13 per `[[auth-passwordless-canon]]`).
 *
 * Surface:
 *   - orgName input prefilled from `prefillOrgName` (query param `n`) so the
 *     user sees what they typed on /signup и can correct typos before
 *     committing the organization name.
 *   - submit button → `useCreateOrganization` → BA org.create →
 *     afterCreateOrganization hook → navigation `/o/$slug` (handled inside
 *     the hook's onSuccess).
 *
 * Belt-and-braces existing-org guard: `useOrgList()` query runs на mount.
 * Если list.length > 0 (user landed here с already-having-an-org — race
 * condition from beforeLoad not refreshing), a destructive banner surfaces
 * explicit warning. The route's `beforeLoad` is the primary gate; this is
 * defense-in-depth.
 *
 * **Why BA org-list, not `/api/v1/properties`** (2026-05-21 fix): the
 * properties endpoint requires `session.activeOrganizationId`, which is
 * **null** for fresh signup landing на /welcome → backend returns 403 →
 * console noise + wasted round-trip. BA `organization.list()` queries
 * user→org memberships directly (no active-org dependency) — correct
 * semantic для «does this user already have any orgs».
 */
export function WelcomeForm({ prefillOrgName }: WelcomeFormProps) {
	const orgNameId = useId()
	const slugId = useId()
	const errorId = useId()
	const [orgName, setOrgName] = useState((prefillOrgName ?? '').trim())
	const create = useCreateOrganization()

	const orgListQuery = useOrgList()

	const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault()
		create.mutate({ orgName: orgName.trim() })
	}

	const error = create.error
	const slugPreview = slugify(orgName)
	const hasExistingOrg = orgListQuery.data ? orgListQuery.data.length > 0 : false

	return (
		<>
			{hasExistingOrg ? (
				<div
					role="alert"
					className="mt-6 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
				>
					<p className="font-medium">У вас уже есть гостиница</p>
					<p className="mt-1 opacity-80">
						Похоже, эта учётная запись уже использовала /welcome — переходим домой.
					</p>
				</div>
			) : null}

			<form onSubmit={handleSubmit} className="mt-8 space-y-4" noValidate>
				{error ? (
					<div
						id={errorId}
						role="alert"
						aria-live="polite"
						className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
					>
						<p className="font-medium">{error.title}</p>
						{error.description ? <p className="mt-1 opacity-80">{error.description}</p> : null}
					</div>
				) : null}

				<div className="space-y-1.5">
					<Label htmlFor={orgNameId}>Название гостиницы</Label>
					<Input
						id={orgNameId}
						type="text"
						autoComplete="organization"
						required
						minLength={2}
						maxLength={80}
						value={orgName}
						onChange={(e) => setOrgName(e.target.value)}
						aria-describedby={slugId}
						placeholder={DEFAULT_WELCOME_ORG_NAME}
					/>
					<p id={slugId} className="text-xs text-muted-foreground">
						Адрес кабинета: <span className="font-mono">/o/{slugPreview || '…'}</span>
					</p>
				</div>

				<Button
					type="submit"
					size="lg"
					className="w-full"
					disabled={create.isPending || orgName.trim().length < 2}
				>
					{create.isPending ? 'Создаём…' : 'Создать гостиницу →'}
				</Button>
			</form>
		</>
	)
}
