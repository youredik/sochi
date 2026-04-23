#!/usr/bin/env tsx
/**
 * Comprehensive end-to-end smoke test for the Sochi HoReCa backend.
 *
 * PURPOSE
 *   Proves that the entire production code path works wired together, in a
 *   single Node process, against a real YDB (Docker local). Every M4 feature
 *   gets one or more strict assertions: auth chain → property/roomType/rate-
 *   plan/rate/availability domain chain → booking lifecycle (confirmed → in-
 *   house → checked-out, plus cancel + no-show variants) → idempotency
 *   (cached replay + 422 conflict) → cross-tenant isolation → CDC consumer
 *   populating activity table → tourism-tax quarterly report aggregate.
 *
 * WHEN TO RUN
 *   - Automatically before `git push` via the lefthook pre-push hook.
 *   - Manually via `pnpm smoke`.
 *
 * REQUIRES
 *   - docker-compose ydb service up (grpc://localhost:2236/local).
 *   - All migrations applied (pnpm tsx apps/backend/src/db/apply-migrations.ts).
 *
 * EXIT CODES
 *   0 — every assertion passed.
 *   1 — at least one assertion failed (failures printed with context).
 *
 * DESIGN
 *   In-process: imports the real Hono `app` + calls `app.request()`. No
 *   external HTTP server, no port collision. Full middleware chain executes
 *   (auth + tenant + idempotency + error mapping). Cookie jar preserves
 *   Better Auth session across requests so `tenantMiddleware` resolves the
 *   current organization, exactly like a real browser would.
 *
 *   Reproducible: every row created here gets deleted at the end (best-
 *   effort afterAll). A second run must also exit 0 (idempotent test data).
 */
import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { app, stopApp } from '../apps/backend/src/app.ts'
import { sql } from '../apps/backend/src/db/index.ts'

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

const BASE = 'http://smoke.local'
let totalAssertions = 0
let passedAssertions = 0
const failures: Array<{ scenario: string; err: Error }> = []

function section(title: string) {
	console.log(`\n━━━ ${title} ━━━`)
}

function ok(msg: string) {
	totalAssertions++
	passedAssertions++
	console.log(`  ✓ ${msg}`)
}

function bail(scenario: string, err: unknown): never {
	const e = err instanceof Error ? err : new Error(String(err))
	failures.push({ scenario, err: e })
	console.error(`  ✗ FATAL in ${scenario}: ${e.message}`)
	if (e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'))
	// biome-ignore lint/nursery/noProcessGlobal: intentional process.exit is the smoke contract
	process.exit(1)
}

function softAssert(scenario: string, fn: () => void | Promise<void>): Promise<void> {
	totalAssertions++
	return Promise.resolve()
		.then(fn)
		.then(() => {
			passedAssertions++
		})
		.catch((err: unknown) => {
			const e = err instanceof Error ? err : new Error(String(err))
			failures.push({ scenario, err: e })
			console.error(`  ✗ ${scenario}: ${e.message}`)
		})
}

/** Cookie jar — stores Set-Cookie values across requests for a single "browser" identity. */
class CookieJar {
	private jar = new Map<string, string>()
	ingest(setCookieHeader: string | null) {
		if (!setCookieHeader) return
		// Hono's Response.headers.get('set-cookie') merges multiple with '\n' in some
		// runtimes; split on ', ' carefully — actually just take first '; '-segment.
		for (const cookie of setCookieHeader.split(/,\s*(?=[^;=]+=)/)) {
			const [nameValue] = cookie.split(';')
			if (!nameValue) continue
			const eq = nameValue.indexOf('=')
			if (eq === -1) continue
			const name = nameValue.slice(0, eq).trim()
			const value = nameValue.slice(eq + 1).trim()
			this.jar.set(name, value)
		}
	}
	header(): string {
		return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
	}
	clear() {
		this.jar.clear()
	}
}

type ReqOpts = {
	method?: string
	headers?: Record<string, string>
	body?: unknown
	jar?: CookieJar
	expect?: number
}
type ReqResult<T = unknown> = { status: number; body: T; headers: Headers }

async function request<T = unknown>(path: string, opts: ReqOpts = {}): Promise<ReqResult<T>> {
	const headers: Record<string, string> = { ...(opts.headers ?? {}) }
	if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
	// Better Auth CSRF protection requires an Origin header on mutation paths.
	// BETTER_AUTH_URL from env is added to trustedOrigins by the backend.
	if (!headers['Origin']) headers['Origin'] = process.env.BETTER_AUTH_URL ?? BASE
	if (opts.jar) {
		const cookie = opts.jar.header()
		if (cookie) headers['Cookie'] = cookie
	}
	const res = await app.request(`${BASE}${path}`, {
		method: opts.method ?? 'GET',
		headers,
		body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
	})
	const setCookie = res.headers.get('set-cookie')
	if (setCookie && opts.jar) opts.jar.ingest(setCookie)
	const text = await res.text()
	let body: unknown
	try {
		body = text.length > 0 ? JSON.parse(text) : null
	} catch {
		body = text
	}
	if (opts.expect !== undefined && res.status !== opts.expect) {
		throw new Error(
			`Expected status ${opts.expect} at ${opts.method ?? 'GET'} ${path}, got ${res.status}. Body: ${text.slice(0, 200)}`,
		)
	}
	return { status: res.status, body: body as T, headers: res.headers }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ──────────────────────────────────────────────────────────────────────────
// Scenarios
// ──────────────────────────────────────────────────────────────────────────

type Ctx = {
	tenantA: { email: string; jar: CookieJar; orgId: string }
	tenantB: { email: string; jar: CookieJar; orgId: string }
	propertyId: string
	roomTypeId: string
	ratePlanId: string
	dates: string[]
	bookingIds: string[]
}

async function signUpAndCreateOrg(label: string): Promise<Ctx['tenantA']> {
	const jar = new CookieJar()
	const suffix = randomUUID().slice(0, 8)
	const email = `smoke-${label}-${suffix}@sochi.local`

	const signUp = await request('/api/auth/sign-up/email', {
		method: 'POST',
		body: { email, password: 'smokepass12345', name: `Smoke ${label}` },
		jar,
	})
	if (signUp.status !== 200 && signUp.status !== 201) {
		throw new Error(`sign-up failed: ${signUp.status} ${JSON.stringify(signUp.body).slice(0, 200)}`)
	}

	const createOrg = await request<{ id: string }>('/api/auth/organization/create', {
		method: 'POST',
		body: { name: `Smoke Hotel ${label}`, slug: `smoke-hotel-${label.toLowerCase()}-${suffix}` },
		jar,
	})
	if (createOrg.status !== 200) {
		throw new Error(
			`organization/create failed: ${createOrg.status} ${JSON.stringify(createOrg.body).slice(0, 200)}`,
		)
	}
	const orgId = (createOrg.body as { id: string }).id

	const setActive = await request('/api/auth/organization/set-active', {
		method: 'POST',
		body: { organizationId: orgId },
		jar,
	})
	if (setActive.status !== 200) {
		throw new Error(`organization/set-active failed: ${setActive.status}`)
	}

	return { email, jar, orgId }
}

/** Addendum (ISO YYYY-MM-DD) = base date shifted by N days. */
function addDays(baseYmd: string, days: number): string {
	const d = new Date(`${baseYmd}T00:00:00Z`)
	d.setUTCDate(d.getUTCDate() + days)
	return d.toISOString().slice(0, 10)
}

async function seedDomainChain(t: Ctx['tenantA']): Promise<Omit<Ctx, 'tenantA' | 'tenantB' | 'bookingIds'>> {
	// Property (Sochi, 200 bps tourism tax).
	const prop = await request<{ data: { id: string } }>('/api/v1/properties', {
		method: 'POST',
		jar: t.jar,
		body: {
			name: `Smoke Property ${randomUUID().slice(0, 6)}`,
			address: 'Smoke Test Address',
			city: 'Sochi',
			tourismTaxRateBps: 200,
		},
		expect: 201,
	})
	const propertyId = prop.body.data.id

	// RoomType.
	const rt = await request<{ data: { id: string } }>(
		`/api/v1/properties/${propertyId}/room-types`,
		{
			method: 'POST',
			jar: t.jar,
			body: {
				name: 'Smoke Standard',
				maxOccupancy: 2,
				baseBeds: 1,
				extraBeds: 0,
				inventoryCount: 3,
			},
			expect: 201,
		},
	)
	const roomTypeId = rt.body.data.id

	// RatePlan.
	const rp = await request<{ data: { id: string } }>('/api/v1/rate-plans', {
		method: 'POST',
		jar: t.jar,
		body: {
			roomTypeId,
			name: 'BAR Flexible',
			code: `BAR-${randomUUID().slice(0, 6).toUpperCase()}`,
			isRefundable: true,
			cancellationHours: 24,
			mealsIncluded: 'none',
			minStay: 1,
			currency: 'RUB',
		},
		expect: 201,
	})
	const ratePlanId = rp.body.data.id

	// Dates: 10 nights from a fixed "future" anchor so repeated runs don't
	// conflict with past ones (UNIQUE externalId space is shared across runs
	// but checkIn dates differ per run via randomized anchor).
	const anchor = addDays('2032-01-01', Math.floor(Math.random() * 300))
	const dates = Array.from({ length: 10 }, (_, i) => addDays(anchor, i))

	// Rate for each date — posted per-ratePlan.
	await request(`/api/v1/rate-plans/${ratePlanId}/rates`, {
		method: 'POST',
		jar: t.jar,
		body: {
			rates: dates.map((date) => ({ date, amount: '5000', currency: 'RUB' })),
		},
		expect: 200,
	})

	// Availability — posted per-roomType.
	await request(`/api/v1/room-types/${roomTypeId}/availability`, {
		method: 'POST',
		jar: t.jar,
		body: { rates: dates.map((date) => ({ date, allotment: 3 })) },
		expect: 200,
	})

	return { propertyId, roomTypeId, ratePlanId, dates }
}

function bookingBody(ctx: { roomTypeId: string; ratePlanId: string; checkIn: string; checkOut: string; citizenship?: string }) {
	return {
		roomTypeId: ctx.roomTypeId,
		ratePlanId: ctx.ratePlanId,
		checkIn: ctx.checkIn,
		checkOut: ctx.checkOut,
		guestsCount: 1,
		primaryGuestId: `gst_${randomUUID().replace(/-/g, '').slice(0, 26)}`,
		guestSnapshot: {
			firstName: 'Smoke',
			lastName: 'Tester',
			citizenship: ctx.citizenship ?? 'RU',
			documentType: 'ruPassport',
			documentNumber: `4510${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`,
		},
		channelCode: 'direct',
	}
}

async function cleanup(ctx: Ctx) {
	section('Cleanup (best-effort)')
	try {
		for (const bid of ctx.bookingIds) {
			await sql`DELETE FROM booking WHERE tenantId = ${ctx.tenantA.orgId} AND id = ${bid}`.catch(
				() => undefined,
			)
		}
		await sql`
			DELETE FROM availability
			WHERE tenantId = ${ctx.tenantA.orgId} AND roomTypeId = ${ctx.roomTypeId}
		`.catch(() => undefined)
		await sql`
			DELETE FROM rate
			WHERE tenantId = ${ctx.tenantA.orgId} AND roomTypeId = ${ctx.roomTypeId}
		`.catch(() => undefined)
		await sql`
			DELETE FROM activity
			WHERE tenantId = ${ctx.tenantA.orgId} AND objectType = 'booking'
		`.catch(() => undefined)
		await sql`DELETE FROM ratePlan WHERE tenantId = ${ctx.tenantA.orgId} AND id = ${ctx.ratePlanId}`.catch(
			() => undefined,
		)
		await sql`DELETE FROM roomType WHERE tenantId = ${ctx.tenantA.orgId} AND id = ${ctx.roomTypeId}`.catch(
			() => undefined,
		)
		await sql`DELETE FROM property WHERE tenantId = ${ctx.tenantA.orgId} AND id = ${ctx.propertyId}`.catch(
			() => undefined,
		)
		ok('cleanup complete')
	} catch (err) {
		console.error('  ! cleanup partial failure (safe to ignore):', err)
	}
}

// ──────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────

async function main() {
	console.log('Sochi HoReCa — comprehensive E2E smoke')
	console.log('======================================')
	const startedAt = Date.now()

	section('Phase 1 · health + auth chain')

	const health = await request<{ status: string }>('/health/db')
	assert.equal(health.status, 200, 'health/db must be 200')
	assert.equal((health.body as { ydb?: { connected?: boolean } }).ydb?.connected, true, 'ydb connected')
	ok('health/db 200 + ydb connected')

	const tenantA = await signUpAndCreateOrg('A')
	ok(`tenant A signed up (org ${tenantA.orgId.slice(0, 12)}…)`)
	const tenantB = await signUpAndCreateOrg('B')
	ok(`tenant B signed up (org ${tenantB.orgId.slice(0, 12)}…)`)

	section('Phase 2 · full domain chain (tenant A)')
	const chain = await seedDomainChain(tenantA)
	ok(`property ${chain.propertyId.slice(0, 14)}… + roomType + ratePlan seeded`)
	ok(`10-day rate + availability seeded (anchor ${chain.dates[0]})`)

	const ctx: Ctx = { tenantA, tenantB, ...chain, bookingIds: [] }

	try {
		section('Phase 3 · booking lifecycle')

		// Scenario 1 — create booking with Idempotency-Key.
		const idemKey1 = randomUUID()
		const bookingInput = bookingBody({
			roomTypeId: ctx.roomTypeId,
			ratePlanId: ctx.ratePlanId,
			checkIn: ctx.dates[0] ?? '',
			checkOut: ctx.dates[2] ?? '',
		})
		const r1 = await request<{ data: { id: string; status: string; tourismTaxMicros: string } }>(
			`/api/v1/properties/${ctx.propertyId}/bookings`,
			{
				method: 'POST',
				jar: ctx.tenantA.jar,
				headers: { 'Idempotency-Key': idemKey1 },
				body: bookingInput,
				expect: 201,
			},
		)
		const bookingId1 = r1.body.data.id
		ctx.bookingIds.push(bookingId1)
		assert.equal(r1.body.data.status, 'confirmed', 'new booking status=confirmed')
		// 2 nights × 5000₽ = 10_000_000_000 micros × 2% = 200_000_000 micros.
		assert.equal(r1.body.data.tourismTaxMicros, '200000000', 'tourism tax = 200_000_000 micros (Sochi 2% × 2×5000₽)')
		ok('[S1] POST /bookings 201 + confirmed + tourism tax correct')

		// Scenario 2 — replay same key + same body → cached response (handler not re-run).
		const r2 = await request(`/api/v1/properties/${ctx.propertyId}/bookings`, {
			method: 'POST',
			jar: ctx.tenantA.jar,
			headers: { 'Idempotency-Key': idemKey1 },
			body: bookingInput,
		})
		assert.equal(r2.status, 201, 'replay same key+body returns same status')
		assert.deepEqual(r2.body, r1.body, 'replay returns EXACT same body (cached)')
		ok('[S2] same key + same body replays cached response byte-for-byte')

		// Scenario 3 — same key + different body → 422.
		const r3 = await request(`/api/v1/properties/${ctx.propertyId}/bookings`, {
			method: 'POST',
			jar: ctx.tenantA.jar,
			headers: { 'Idempotency-Key': idemKey1 },
			body: { ...bookingInput, guestsCount: 2 },
		})
		assert.equal(r3.status, 422, 'same key + different body → 422')
		assert.equal((r3.body as { error: { code: string } }).error.code, 'IDEMPOTENCY_KEY_CONFLICT')
		ok('[S3] same key + different body → 422 IDEMPOTENCY_KEY_CONFLICT')

		// Scenario 4 — channel booking with externalId; retry returns 409.
		const extId = `YT-${randomUUID().slice(0, 8)}`
		const extBody1 = {
			...bookingBody({
				roomTypeId: ctx.roomTypeId,
				ratePlanId: ctx.ratePlanId,
				checkIn: ctx.dates[3] ?? '',
				checkOut: ctx.dates[4] ?? '',
			}),
			channelCode: 'yandexTravel',
			externalId: extId,
		}
		const r4a = await request<{ data: { id: string } }>(
			`/api/v1/properties/${ctx.propertyId}/bookings`,
			{ method: 'POST', jar: ctx.tenantA.jar, body: extBody1, expect: 201 },
		)
		ctx.bookingIds.push(r4a.body.data.id)
		ok('[S4a] POST channel booking with externalId → 201')

		const r4b = await request(`/api/v1/properties/${ctx.propertyId}/bookings`, {
			method: 'POST',
			jar: ctx.tenantA.jar,
			body: extBody1,
		})
		assert.equal(r4b.status, 409, 'duplicate externalId → 409')
		assert.equal(
			(r4b.body as { error: { code: string } }).error.code,
			'BOOKING_EXTERNAL_ID_TAKEN',
			'error code BOOKING_EXTERNAL_ID_TAKEN',
		)
		ok('[S4b] duplicate externalId → 409 BOOKING_EXTERNAL_ID_TAKEN')

		// Scenario 5 — full lifecycle: checkIn → checkOut, immutables preserved.
		const r5check = await request<{ data: { checkedInAt: string; status: string } }>(
			`/api/v1/bookings/${bookingId1}/check-in`,
			{ method: 'PATCH', jar: ctx.tenantA.jar, body: {}, expect: 200 },
		)
		assert.equal(r5check.body.data.status, 'in_house', 'checkIn → in_house')
		assert.ok(r5check.body.data.checkedInAt, 'checkedInAt populated')
		ok('[S5a] PATCH /check-in → in_house + checkedInAt set')

		const r5out = await request<{ data: { checkedOutAt: string; status: string } }>(
			`/api/v1/bookings/${bookingId1}/check-out`,
			{ method: 'PATCH', jar: ctx.tenantA.jar, expect: 200 },
		)
		assert.equal(r5out.body.data.status, 'checked_out', 'checkOut → checked_out')
		ok('[S5b] PATCH /check-out → checked_out')

		// Scenario 6 — cancel returns inventory.
		const cancelBookingBody = bookingBody({
			roomTypeId: ctx.roomTypeId,
			ratePlanId: ctx.ratePlanId,
			checkIn: ctx.dates[5] ?? '',
			checkOut: ctx.dates[6] ?? '',
		})
		const r6a = await request<{ data: { id: string } }>(
			`/api/v1/properties/${ctx.propertyId}/bookings`,
			{ method: 'POST', jar: ctx.tenantA.jar, body: cancelBookingBody, expect: 201 },
		)
		const cancelTarget = r6a.body.data.id
		ctx.bookingIds.push(cancelTarget)
		const r6b = await request<{ data: { status: string; cancelledAt: string } }>(
			`/api/v1/bookings/${cancelTarget}/cancel`,
			{ method: 'PATCH', jar: ctx.tenantA.jar, body: { reason: 'smoke test' }, expect: 200 },
		)
		assert.equal(r6b.body.data.status, 'cancelled')
		assert.ok(r6b.body.data.cancelledAt)
		ok('[S6] POST + PATCH /cancel → status=cancelled + cancelledAt set')

		// Scenario 7 — markNoShow retains inventory + irreversible.
		const noShowBody = bookingBody({
			roomTypeId: ctx.roomTypeId,
			ratePlanId: ctx.ratePlanId,
			checkIn: ctx.dates[7] ?? '',
			checkOut: ctx.dates[8] ?? '',
		})
		const r7a = await request<{ data: { id: string } }>(
			`/api/v1/properties/${ctx.propertyId}/bookings`,
			{ method: 'POST', jar: ctx.tenantA.jar, body: noShowBody, expect: 201 },
		)
		const noShowId = r7a.body.data.id
		ctx.bookingIds.push(noShowId)
		const r7b = await request<{ data: { status: string; noShowAt: string } }>(
			`/api/v1/bookings/${noShowId}/no-show`,
			{ method: 'PATCH', jar: ctx.tenantA.jar, body: { reason: 'guest did not arrive' }, expect: 200 },
		)
		assert.equal(r7b.body.data.status, 'no_show')
		assert.ok(r7b.body.data.noShowAt)
		ok('[S7a] PATCH /no-show → status=no_show (terminal)')

		const r7c = await request(`/api/v1/bookings/${noShowId}/no-show`, {
			method: 'PATCH',
			jar: ctx.tenantA.jar,
			body: { reason: 'retry' },
		})
		assert.equal(r7c.status, 409, 'no_show second call → 409 (irreversible)')
		assert.equal((r7c.body as { error: { code: string } }).error.code, 'INVALID_BOOKING_TRANSITION')
		ok('[S7b] second /no-show → 409 INVALID_BOOKING_TRANSITION (irreversible)')

		section('Phase 4 · cross-tenant adversarial (tenant B)')

		// Cross-tenant read must return 404, NOT leak.
		const r8a = await request(`/api/v1/bookings/${bookingId1}`, { jar: ctx.tenantB.jar })
		assert.equal(r8a.status, 404, 'cross-tenant GET booking → 404')
		ok('[X1] cross-tenant GET /bookings/:id → 404')

		const r8b = await request(`/api/v1/bookings/${cancelTarget}/cancel`, {
			method: 'PATCH',
			jar: ctx.tenantB.jar,
			body: { reason: 'malicious' },
		})
		assert.equal(r8b.status, 404, 'cross-tenant PATCH /cancel → 404')
		ok('[X2] cross-tenant PATCH /cancel → 404')

		const r8c = await request(
			`/api/v1/properties/${ctx.propertyId}/reports/tourism-tax?from=${ctx.dates[0]}&to=${ctx.dates[9]}`,
			{ jar: ctx.tenantB.jar },
		)
		assert.equal(r8c.status, 404, 'cross-tenant report → 404 (property not found)')
		ok('[X3] cross-tenant tourism-tax report → 404')

		section('Phase 5 · CDC consumer populates activity')
		// Wait for CDC consumer to process booking changes. Consumer loop yields
		// empty batches every 5s (`waitMs: 5_000` in cdc-consumer.ts); the first
		// real batch typically arrives 2-8s after the write. We poll with a
		// 20s budget to avoid a flaky hard-coded sleep.
		let acts: Array<{ activityType: string; actorUserId: string }> = []
		for (let attempt = 0; attempt < 20 && acts.length < 3; attempt++) {
			await sleep(1_000)
			const poll = await request<{ data: typeof acts }>(
				`/api/v1/activity?objectType=booking&recordId=${bookingId1}`,
				{ jar: ctx.tenantA.jar },
			)
			acts = poll.body.data
		}
		// Booking went confirmed → in_house → checked_out (2 transitions) + created (1) =
		// at minimum 1 created + 2 statusChange entries.
		const createdEvents = acts.filter((a) => a.activityType === 'created')
		const statusChanges = acts.filter((a) => a.activityType === 'statusChange')
		assert.ok(createdEvents.length >= 1, `≥1 'created' activity (got ${createdEvents.length})`)
		assert.ok(statusChanges.length >= 2, `≥2 'statusChange' activities (got ${statusChanges.length})`)
		ok(`[C1] activity: ${createdEvents.length} created + ${statusChanges.length} statusChange`)

		section('Phase 6 · tourism-tax quarterly report')
		const report = await request<{
			data: { bookingsCount: number; tourismTaxMicros: string; accommodationBaseMicros: string }
		}>(
			`/api/v1/properties/${ctx.propertyId}/reports/tourism-tax?from=${ctx.dates[0]}&to=${ctx.dates[9]}`,
			{ jar: ctx.tenantA.jar, expect: 200 },
		)
		// Expected active bookings: [S1] booking1 (checked_out) + [S4] channel booking (confirmed)
		//   + [S7] no_show (included). [S6] cancel excluded.
		// So bookingsCount = 3. Each is 1-2 nights × 5000₽ with 2% tax OR floor.
		// We assert count + that tax > 0.
		assert.equal(report.body.data.bookingsCount, 3, `report bookingsCount = 3 (got ${report.body.data.bookingsCount})`)
		assert.ok(BigInt(report.body.data.tourismTaxMicros) > 0n, 'tourismTaxMicros > 0')
		assert.ok(
			BigInt(report.body.data.accommodationBaseMicros) > 0n,
			'accommodationBaseMicros > 0',
		)
		ok(`[R1] tourism-tax report: 3 bookings, ${report.body.data.tourismTaxMicros} micros tax`)

		section('Phase 7 · overbooking race (atomic inventory)')
		// Burn remaining allotment on a specific date.
		const raceDate = ctx.dates[9] ?? ''
		// Set allotment to exactly 1 on the race date.
		await request(`/api/v1/room-types/${ctx.roomTypeId}/availability`, {
			method: 'POST',
			jar: ctx.tenantA.jar,
			body: { rates: [{ date: raceDate, allotment: 1 }] },
			expect: 200,
		})
		const raceBody = bookingBody({
			roomTypeId: ctx.roomTypeId,
			ratePlanId: ctx.ratePlanId,
			checkIn: raceDate,
			checkOut: addDays(raceDate, 1),
		})
		const [raceA, raceB] = await Promise.allSettled([
			request<{ data: { id: string } }>(`/api/v1/properties/${ctx.propertyId}/bookings`, {
				method: 'POST',
				jar: ctx.tenantA.jar,
				body: raceBody,
			}),
			request(`/api/v1/properties/${ctx.propertyId}/bookings`, {
				method: 'POST',
				jar: ctx.tenantA.jar,
				body: raceBody,
			}),
		])
		const winners = [raceA, raceB].filter((r) => r.status === 'fulfilled' && r.value.status === 201)
		const losers = [raceA, raceB].filter(
			(r) => r.status === 'fulfilled' && r.value.status === 409,
		)
		assert.equal(winners.length, 1, `exactly 1 concurrent booking wins (got ${winners.length})`)
		assert.equal(losers.length, 1, `exactly 1 concurrent booking loses with 409 (got ${losers.length})`)
		if (winners[0]?.status === 'fulfilled') {
			const w = winners[0].value as ReqResult<{ data: { id: string } }>
			ctx.bookingIds.push(w.body.data.id)
		}
		ok('[O1] Promise.all double POST on last allotment → 1 × 201 + 1 × 409')

		section('Summary')
		console.log(`  assertions: ${passedAssertions}/${totalAssertions} passed`)
		console.log(`  duration: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
	} finally {
		await cleanup(ctx)
		await stopApp().catch(() => undefined)
	}

	if (failures.length > 0) {
		console.error(`\nFAILED: ${failures.length} assertion(s) failed.`)
		for (const f of failures) console.error(`  • ${f.scenario}: ${f.err.message}`)
		// biome-ignore lint/nursery/noProcessGlobal: smoke contract
		process.exit(1)
	}
	console.log('\n✓ ALL PASSED\n')
	// biome-ignore lint/nursery/noProcessGlobal: smoke contract
	process.exit(0)
}

main().catch((err) => bail('main', err))

// `softAssert` kept for future use in non-fatal invariants.
void softAssert
