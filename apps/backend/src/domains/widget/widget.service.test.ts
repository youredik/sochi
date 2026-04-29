/**
 * Widget service — strict orchestration tests per `feedback_strict_tests.md`.
 *
 * Service layer = resolver + repo orchestration. Tests SPECIFICALLY for
 * orchestration paths NOT covered transitively by widget.routes.test.ts:
 *
 *   ─── Tenant resolution ────────────────────────────────────────
 *     [TR1] listProperties — unknown slug → throws TenantNotFoundError
 *           (not generic Error — specific class для типизированного catch)
 *     [TR2] getPropertyDetail — unknown slug → throws TenantNotFoundError
 *
 *   ─── Property resolution ──────────────────────────────────────
 *     [PR1] getPropertyDetail — known tenant + non-existent property →
 *           throws PublicPropertyNotFoundError (NOT TenantNotFoundError)
 *     [PR2] getPropertyDetail — property принадлежит другому tenant →
 *           throws PublicPropertyNotFoundError (cross-tenant leak guard)
 *
 *   ─── Mode passthrough ─────────────────────────────────────────
 *     [M1] tenant.mode='demo' → propagates в DTO
 *     [M2] tenant.mode='production' → propagates в DTO
 *     [M3] tenant без organizationProfile → mode=null (not omitted)
 *
 *   ─── Adversarial: data leakage ────────────────────────────────
 *     [AL1] listProperties returns PublicProperty type — NO `isPublic`
 *           field в response (internal flag должен скрываться)
 *     [AL2] returned tenant DTO has only {slug, name, mode} — NO `id`
 *           leak (tenantId — internal, не должен попасть к anonymous)
 */
import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createWidgetFactory } from './widget.factory.ts'
import { PublicPropertyNotFoundError, TenantNotFoundError } from './widget.service.ts'

describe('widget.service — orchestration', { tags: ['db'], timeout: 60_000 }, () => {
	beforeAll(async () => {
		await setupTestDb()
	})

	afterAll(async () => {
		await teardownTestDb()
	})

	async function seedTenant(opts: {
		slug: string
		mode?: 'demo' | 'production' | null
		propertyId?: string
		propertyIsPublic?: boolean
	}) {
		const sql = getTestSql()
		const tenantId = newId('organization')
		const now = new Date()
		await sql`
			UPSERT INTO organization (id, name, slug, createdAt)
			VALUES (${tenantId}, ${'Test'}, ${opts.slug}, ${now})
		`
		if (opts.mode !== undefined) {
			await sql`
				UPSERT INTO organizationProfile (organizationId, plan, createdAt, updatedAt, mode)
				VALUES (${tenantId}, ${'free'}, ${now}, ${now}, ${opts.mode})
			`
		}
		if (opts.propertyId) {
			await sql`
				UPSERT INTO property (
					\`tenantId\`, \`id\`, \`name\`, \`address\`, \`city\`, \`timezone\`,
					\`isActive\`, \`isPublic\`, \`createdAt\`, \`updatedAt\`
				) VALUES (
					${tenantId}, ${opts.propertyId},
					${'Test Property'}, ${'addr'}, ${'Sochi'}, ${'Europe/Moscow'},
					${true}, ${opts.propertyIsPublic ?? true}, ${now}, ${now}
				)
			`
		}
		return { tenantId }
	}

	test('[TR1] listProperties — unknown slug → TenantNotFoundError (specific class)', async () => {
		const { service } = createWidgetFactory(getTestSql())
		await expect(service.listProperties(`tr1-nonexistent-${Date.now()}`)).rejects.toThrow(
			TenantNotFoundError,
		)
		// Adversarial: assert NOT a generic Error (typed catch matters)
		await expect(service.listProperties(`tr1-nonexistent-${Date.now()}`)).rejects.toBeInstanceOf(
			TenantNotFoundError,
		)
	})

	test('[TR2] getPropertyDetail — unknown slug → TenantNotFoundError', async () => {
		const { service } = createWidgetFactory(getTestSql())
		await expect(
			service.getPropertyDetail(`tr2-${Date.now()}`, newId('property')),
		).rejects.toBeInstanceOf(TenantNotFoundError)
	})

	test('[PR1] getPropertyDetail — known tenant + nonexistent property → PublicPropertyNotFoundError', async () => {
		const { service } = createWidgetFactory(getTestSql())
		const slug = `pr1-${Date.now().toString(36)}`
		await seedTenant({ slug, mode: 'demo' })
		// NO property seeded
		await expect(service.getPropertyDetail(slug, newId('property'))).rejects.toBeInstanceOf(
			PublicPropertyNotFoundError,
		)
	})

	test('[PR2] getPropertyDetail — property принадлежит другому tenant → PublicPropertyNotFoundError (NOT a leak)', async () => {
		const { service } = createWidgetFactory(getTestSql())
		const slugA = `pr2a-${Date.now().toString(36)}`
		const slugB = `pr2b-${Date.now().toString(36)}`
		const propertyId = newId('property')
		await seedTenant({ slug: slugA, mode: 'demo', propertyId, propertyIsPublic: true })
		await seedTenant({ slug: slugB, mode: 'demo' })
		// Try get tenant A's property через tenant B's slug
		await expect(service.getPropertyDetail(slugB, propertyId)).rejects.toBeInstanceOf(
			PublicPropertyNotFoundError,
		)
	})

	test('[M1] tenant.mode=demo propagates в DTO', async () => {
		const { service } = createWidgetFactory(getTestSql())
		const slug = `m1-${Date.now().toString(36)}`
		await seedTenant({ slug, mode: 'demo', propertyId: newId('property') })
		const view = await service.listProperties(slug)
		expect(view.tenant.mode).toBe('demo')
	})

	test('[M2] tenant.mode=production propagates в DTO', async () => {
		const { service } = createWidgetFactory(getTestSql())
		const slug = `m2-${Date.now().toString(36)}`
		await seedTenant({ slug, mode: 'production', propertyId: newId('property') })
		const view = await service.listProperties(slug)
		expect(view.tenant.mode).toBe('production')
	})

	test('[M3] tenant без organizationProfile → mode=null (not undefined / not omitted)', async () => {
		const { service } = createWidgetFactory(getTestSql())
		const slug = `m3-${Date.now().toString(36)}`
		await seedTenant({ slug }) // no mode → no organizationProfile row
		const view = await service.listProperties(slug)
		expect(view.tenant.mode).toBeNull()
		expect('mode' in view.tenant).toBe(true) // exact: mode key IS present
	})

	test('[AL1] PublicProperty DTO has NO isPublic field (internal flag не утечёт)', async () => {
		const { service } = createWidgetFactory(getTestSql())
		const slug = `al1-${Date.now().toString(36)}`
		await seedTenant({ slug, mode: 'demo', propertyId: newId('property') })
		const view = await service.listProperties(slug)
		expect(view.properties.length).toBeGreaterThan(0)
		const firstProp = view.properties[0]!
		expect('isPublic' in firstProp).toBe(false)
		expect('isActive' in firstProp).toBe(false) // internal flag тоже не должен утечь
	})

	test('[AL2] tenant DTO имеет только {slug,name,mode} — tenantId НЕ leaked', async () => {
		const { service } = createWidgetFactory(getTestSql())
		const slug = `al2-${Date.now().toString(36)}`
		await seedTenant({ slug, mode: 'demo', propertyId: newId('property') })
		const view = await service.listProperties(slug)
		// Exact key set (immutable-field check per feedback_strict_tests.md)
		const tenantKeys = Object.keys(view.tenant).sort()
		expect(tenantKeys).toEqual(['mode', 'name', 'slug'])
		// Adversarial: verify tenantId NOT present под любым именем
		expect('id' in view.tenant).toBe(false)
		expect('tenantId' in view.tenant).toBe(false)
		expect('organizationId' in view.tenant).toBe(false)
	})
})
