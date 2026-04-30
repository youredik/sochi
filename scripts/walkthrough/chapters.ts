/**
 * Walkthrough chapters: ordered scenes covering the full HoReCa Sochi feature
 * surface — onboarding, daily admin work, finance, reporting.
 *
 * Adapted from working E2E patterns (selectors verified there):
 *   - tests/e2e/auth.setup.ts (signup + 4-step wizard)
 *   - tests/e2e/bookings.spec.ts (cell-click → guest-fill → submit)
 *   - tests/e2e/bookings-edit.spec.ts (band-click → state machine)
 *   - tests/e2e/payments.spec.ts (folio + Mark Paid Sheet)
 *
 * `TourState` accumulates IDs as the scene plays so later chapters
 * (folio, payment) can deep-link via real URLs derived from real records.
 */
import type { Page } from '@playwright/test'

export interface TourState {
	orgSlug: string | null
	bookingId: string | null
	folioId: string | null
	propertyId: string | null
}

export interface Chapter {
	readonly id: string
	readonly title: string
	readonly description: string
	readonly narration: string
	run(page: Page, state: TourState): Promise<void>
}

const ts = Date.now()
const tsShort = String(ts).slice(-6)
const email = `tour-${ts}@sochi.local`
const password = 'walkthrough-demo-01'
const orgName = `Гранд-Отель Сочи ${tsShort}`

const API = 'http://localhost:8787/api/v1'
const BOOKING_DAY = 5

function futureIso(daysFromToday: number): string {
	const d = new Date()
	d.setUTCHours(12, 0, 0, 0)
	d.setUTCDate(d.getUTCDate() + daysFromToday)
	return d.toISOString().slice(0, 10)
}

export const chapters: Chapter[] = [
	{
		id: '01-intro',
		title: 'HoReCa Sochi',
		description: 'Управление малым отелем',
		narration:
			'Это HoReCa Sochi — современная система управления для малых отелей и гостиниц. ' +
			'Покажем полный путь: от регистрации и настройки до ежедневной работы администратора, финансов и отчётности.',
		async run(page) {
			await page.goto('/login')
			await page.waitForLoadState('networkidle')
		},
	},
	{
		id: '02-signup',
		title: 'Регистрация владельца',
		description: 'Имя, email, пароль и название гостиницы',
		narration:
			'Отельер регистрируется одним экраном. Заполняем имя, электронную почту, пароль и название гостиницы. ' +
			'Согласие на обработку персональных данных по сто пятьдесят второму федеральному закону обязательно — без него форма не отправляется.',
		async run(page, state) {
			await page.goto('/signup')
			await page.waitForLoadState('networkidle')
			await page.getByLabel('Ваше имя').pressSequentially('Демо Владелец', { delay: 50 })
			await page.getByLabel('Email').pressSequentially(email, { delay: 25 })
			await page.getByLabel('Пароль').fill(password)
			await page.getByLabel('Название гостиницы').pressSequentially(orgName, { delay: 35 })
			await page.getByLabel(/согласие/).check()
			await page.getByRole('button', { name: 'Создать аккаунт' }).click()
			await page.waitForURL(/\/o\/.*\/setup$/, { timeout: 15_000 })
			const m = page.url().match(/\/o\/([^/]+)/)
			state.orgSlug = m?.[1] ?? null
		},
	},
	{
		id: '03-wizard-property',
		title: 'Шаг 1: Гостиница',
		description: 'Адрес, город, туристический налог',
		narration:
			'Запускается мастер настройки. Первый шаг — данные гостиницы. ' +
			'Город Сочи подставляется автоматически, и туристический налог в двести базисных пунктов — то есть два процента — уже учтён по тарифу две тысячи двадцать шестого года.',
		async run(page) {
			await page
				.getByLabel('Название гостиницы')
				.pressSequentially(`${orgName} — корпус А`, { delay: 25 })
			await page
				.getByLabel('Адрес')
				.pressSequentially('Имеретинская низменность, Сириус', { delay: 25 })
			await page.waitForTimeout(800)
			await page.getByRole('button', { name: /Далее — тип номеров/ }).click()
		},
	},
	{
		id: '04-wizard-roomtype',
		title: 'Шаг 2: Тип номера',
		description: 'Стандартный двухместный номер',
		narration:
			'Второй шаг — категория номера. По умолчанию создаётся Стандарт на двух гостей. ' +
			'Этого достаточно для старта — категории расширяются позже из главного меню.',
		async run(page) {
			await page.waitForTimeout(1500)
			await page.getByRole('button', { name: /Далее — номера/ }).click()
		},
	},
	{
		id: '05-wizard-rooms',
		title: 'Шаг 3: Номера',
		description: 'Добавляем фактический фонд',
		narration:
			'Третий шаг — добавляем сами номера. Создадим сто первый и сто второй. ' +
			'Этаж — опциональное поле, что важно для гостевых домов без этажности.',
		async run(page) {
			const numField = page.getByLabel('Номер')
			await numField.fill('')
			await numField.pressSequentially('101', { delay: 80 })
			await page.getByRole('button', { name: /Добавить номер/ }).click()
			await page.getByText(/Добавлено: 1/).waitFor({ timeout: 5_000 })
			await numField.fill('')
			await numField.pressSequentially('102', { delay: 80 })
			const floorField = page.getByLabel(/Этаж/)
			await floorField.fill('')
			await floorField.pressSequentially('1', { delay: 80 })
			await page.getByRole('button', { name: /Добавить номер/ }).click()
			await page.getByText(/Добавлено: 2/).waitFor({ timeout: 5_000 })
			await page.getByRole('button', { name: /Далее — тариф/ }).click()
		},
	},
	{
		id: '06-wizard-rateplan',
		title: 'Шаг 4: Тариф',
		description: 'Базовый BAR — пять тысяч за ночь',
		narration:
			'Финальный шаг — базовый тариф БАР. Пять тысяч рублей за ночь, без ограничений по предоплате. ' +
			'Это публичная цена, от которой потом считаются скидки и негибкие тарифы.',
		async run(page) {
			await page.waitForTimeout(1500)
			await page.getByRole('button', { name: /Завершить настройку/ }).click()
			await page.waitForURL(/\/o\/[^/]+\/?$/, { timeout: 15_000 })
		},
	},
	{
		id: '07-grid',
		title: 'Шахматка',
		description: 'Главный экран дежурного администратора',
		narration:
			'Готово. Чтобы шахматка не пустовала, заведём несколько демонстрационных бронирований. ' +
			'Видны типы номеров слева и календарная сетка на пятнадцать дней. ' +
			'Это центральный инструмент дежурного администратора, из которого создаются и редактируются бронирования.',
		async run(page, state) {
			// Capture property + roomType + ratePlan IDs (also reused by later chapters).
			const propsRes = await page.request.get(`${API}/properties`)
			state.propertyId = ((await propsRes.json()) as { data: Array<{ id: string }> }).data[0]?.id ?? null
			if (!state.propertyId) throw new Error('07-grid: no property in tenant')

			const [rtRes, rpRes] = await Promise.all([
				page.request.get(`${API}/properties/${state.propertyId}/room-types`),
				page.request.get(`${API}/properties/${state.propertyId}/rate-plans`),
			])
			const roomTypeId = ((await rtRes.json()) as { data: Array<{ id: string }> }).data[0]?.id
			const ratePlanId = ((await rpRes.json()) as { data: Array<{ id: string }> }).data[0]?.id
			if (!roomTypeId || !ratePlanId) throw new Error('07-grid: missing roomType/ratePlan')

			// Seed bookings: non-overlapping with chapter 8's BOOKING_DAY=5 (1 night).
			const seeds: Array<{
				day: number
				nights: number
				lastName: string
				firstName: string
				doc: string
			}> = [
				{ day: 1, nights: 1, lastName: 'Петров', firstName: 'Пётр', doc: '4510800001' },
				{ day: 3, nights: 2, lastName: 'Сидорова', firstName: 'Анна', doc: '4510800002' },
				{ day: 7, nights: 1, lastName: 'Кузнецов', firstName: 'Алексей', doc: '4510800003' },
				{ day: 9, nights: 2, lastName: 'Михайлов', firstName: 'Андрей', doc: '4510800004' },
				{ day: 12, nights: 1, lastName: 'Васильева', firstName: 'Мария', doc: '4510800005' },
			]
			for (const s of seeds) {
				const guestRes = await page.request.post(`${API}/guests`, {
					data: {
						lastName: s.lastName,
						firstName: s.firstName,
						citizenship: 'RU',
						documentType: 'passport',
						documentNumber: s.doc,
					},
				})
				if (!guestRes.ok()) {
					throw new Error(`07-grid: guest.create HTTP ${guestRes.status()}: ${await guestRes.text()}`)
				}
				const guestId = ((await guestRes.json()) as { data: { id: string } }).data.id

				const bookingRes = await page.request.post(
					`${API}/properties/${state.propertyId}/bookings`,
					{
						data: {
							roomTypeId,
							ratePlanId,
							checkIn: futureIso(s.day),
							checkOut: futureIso(s.day + s.nights),
							guestsCount: 1,
							primaryGuestId: guestId,
							guestSnapshot: {
								firstName: s.firstName,
								lastName: s.lastName,
								citizenship: 'RU',
								documentType: 'passport',
								documentNumber: s.doc,
							},
							channelCode: 'walkIn',
						},
					},
				)
				if (!bookingRes.ok()) {
					throw new Error(
						`07-grid: booking.create HTTP ${bookingRes.status()}: ${await bookingRes.text()}`,
					)
				}
			}

			// Give CDC consumer headroom to drain the 5 booking_created events
			// before chapter 8 stacks another one on top — otherwise chapter 10's
			// folio-poll races with backed-up CDC.
			await page.waitForTimeout(2500)

			await page.getByRole('link', { name: /Шахматка/ }).click()
			await page.waitForURL(/\/grid$/, { timeout: 10_000 })
			await page.waitForLoadState('networkidle')
			await page.waitForTimeout(1500)
		},
	},
	{
		id: '08-booking-create',
		title: 'Создание бронирования',
		description: 'Клик по ячейке → данные гостя → подтверждение',
		narration:
			'Создаём бронирование. Кликаем по ячейке нужной даты — открывается диалог. ' +
			'Заполняем данные гостя: фамилию, имя и номер паспорта. Документ обязателен по требованию МВД.',
		async run(page, state) {
			const date = futureIso(BOOKING_DAY)
			await page.locator(`button[data-cell-date="${date}"]`).click()
			const dialog = page.getByRole('dialog')
			await dialog.waitFor()
			await dialog.getByLabel('Фамилия').pressSequentially('Иванов', { delay: 60 })
			await dialog.getByLabel('Имя').pressSequentially('Иван', { delay: 60 })
			await dialog.getByLabel('Номер документа').pressSequentially('4510123456', { delay: 40 })
			await dialog.getByRole('button', { name: /Создать бронирование/ }).click()
			await page.getByText('Бронирование создано').waitFor({ timeout: 10_000 })
			// CRITICAL: wait for `book_*` prefix — `[data-booking-id]` alone matches the
			// `pending_*` optimistic placeholder before server-truth replaces it. Folio
			// API regex is `/^book_[26]$/`, so capturing `pending_xyz` → 400 ZodError
			// downstream in chapter 10.
			const band = page
				.locator(`[data-booking-id^="book_"][aria-label*="${date} —"]`)
				.first()
			await band.waitFor({ timeout: 10_000 })
			state.bookingId = await band.getAttribute('data-booking-id')
			await page.waitForTimeout(800)
		},
	},
	{
		id: '09-checkin',
		title: 'Заезд гостя',
		description: 'Бронь → В проживании, palette меняется',
		narration:
			'Гость прибыл. Кликаем на бронь, нажимаем Заезд — статус меняется на «В проживании», ' +
			'а цвет полосы переключается с синего на чёрный. Администратор видит изменение мгновенно.',
		async run(page) {
			const date = futureIso(BOOKING_DAY)
			const band = page.locator(`[data-booking-id^="book_"][aria-label*="${date} —"]`).first()
			await band.click()
			const dialog = page.getByRole('dialog')
			await dialog.waitFor()
			await dialog.getByRole('button', { name: 'Заезд' }).click()
			await page.getByText('Гость заселён').waitFor({ timeout: 10_000 })
			await page.waitForTimeout(800)
		},
	},
	{
		id: '10-folio',
		title: 'Фолио гостя',
		description: 'Счёт: проживание, налог, баланс',
		narration:
			'У каждой брони — свой счёт, фолио. Добавим позицию проживания на пять тысяч рублей. ' +
			'Здесь же видно баланс, статус оплат и историю всех операций.',
		async run(page, state) {
			if (!state.bookingId || !state.orgSlug) {
				throw new Error('chapter 10 requires bookingId + orgSlug from earlier chapters')
			}
			const propsRes = await page.request.get(`${API}/properties`)
			const propsBody = (await propsRes.json()) as { data: Array<{ id: string }> }
			state.propertyId = propsBody.data?.[0]?.id ?? null
			if (!state.propertyId) throw new Error('no property in tenant')

			// Poll for CDC-created folio. With 6+ booking events from chapter 7
			// seeding + chapter 8 user booking, CDC consumer can be backed up.
			// Bumped 8s → 20s; if still nothing, fallback to explicit POST
			// (mirrors `payments.spec.ts` seedFolioFixture pattern).
			const deadline = Date.now() + 20_000
			let folioId: string | undefined
			while (Date.now() < deadline) {
				const r = await page.request.get(
					`${API}/properties/${state.propertyId}/bookings/${state.bookingId}/folios`,
				)
				const body = (await r.json()) as { data: Array<{ id: string }> }
				if (body.data?.[0]) {
					folioId = body.data[0].id
					break
				}
				await page.waitForTimeout(250)
			}
			if (!folioId) {
				const createRes = await page.request.post(
					`${API}/properties/${state.propertyId}/bookings/${state.bookingId}/folios`,
					{
						data: { kind: 'guest', currency: 'RUB' },
						headers: {
							'Idempotency-Key': crypto.randomUUID(),
							'content-type': 'application/json',
						},
					},
				)
				if (createRes.ok()) {
					folioId = ((await createRes.json()) as { data: { id: string } }).data.id
				} else {
					const errBody = await createRes.text()
					// Final race-safe re-list (CDC may have won between poll + POST).
					const r = await page.request.get(
						`${API}/properties/${state.propertyId}/bookings/${state.bookingId}/folios`,
					)
					const body = (await r.json()) as { data: Array<{ id: string }> }
					folioId = body.data?.[0]?.id
					if (!folioId) {
						throw new Error(
							`folio neither auto-created (CDC) nor explicitly created — POST ${createRes.status()}: ${errBody}`,
						)
					}
				}
			}
			state.folioId = folioId

			await page.request.post(`${API}/folios/${folioId}/lines`, {
				data: {
					category: 'accommodation',
					description: 'Проживание, 1 ночь',
					amountMinor: 500_000,
					isAccommodationBase: true,
					taxRateBps: 0,
				},
				headers: {
					'Idempotency-Key': crypto.randomUUID(),
					'content-type': 'application/json',
				},
			})

			await page.goto(`/o/${state.orgSlug}/bookings/${state.bookingId}/folios/${folioId}`)
			await page.getByRole('heading', { name: /Фолио/ }).waitFor({ timeout: 10_000 })
			await page.waitForLoadState('networkidle')
			await page.waitForTimeout(1500)
		},
	},
	{
		id: '11-mark-paid',
		title: 'Принять оплату',
		description: 'Sheet справа — фискализация ЮKassa',
		narration:
			'Принимаем оплату. Открывается боковая панель — сумма уже подставлена из баланса. ' +
			'В продакшене платёж идёт через ЮKassa с фискализацией по пятьдесят четвёртому федеральному закону. ' +
			'В демо используется заглушка-провайдер.',
		async run(page) {
			await page
				.getByRole('button', { name: /Принять оплату/, exact: false })
				.first()
				.click()
			const sheet = page.getByRole('dialog', { name: /Принять оплату/ })
			await sheet.waitFor()
			await page.waitForTimeout(1200)
			await sheet
				.getByRole('button', { name: /^Принять$/ })
				.waitFor({ state: 'visible' })
			await sheet.getByRole('button', { name: /^Принять$/ }).click()
			await page.waitForTimeout(2000)
		},
	},
	{
		id: '12-checkout',
		title: 'Выезд гостя',
		description: 'Возврат на шахматку → Выезд',
		narration:
			'Возвращаемся на шахматку и оформляем выезд. Один клик — статус «Выехал», ' +
			'бронь окрашивается в серый, цикл проживания закрыт.',
		async run(page, state) {
			if (!state.orgSlug) throw new Error('chapter 12 requires orgSlug')
			// Folio page header has no "Шахматка" link (only on dashboard) — go direct.
			await page.goto(`/o/${state.orgSlug}/grid`)
			await page.waitForURL(/\/grid$/, { timeout: 10_000 })
			await page.waitForLoadState('networkidle')
			const date = futureIso(BOOKING_DAY)
			const band = page.locator(`[data-booking-id^="book_"][aria-label*="${date} —"]`).first()
			await band.click()
			const dialog = page.getByRole('dialog')
			await dialog.waitFor()
			await dialog.getByRole('button', { name: 'Выезд' }).click()
			await page.getByText('Гость выселен').waitFor({ timeout: 10_000 })
			await page.waitForTimeout(800)
		},
	},
	{
		id: '13-receivables',
		title: 'Дебиторская задолженность',
		description: 'KPI, aging, реестр',
		narration:
			'Раздел задолженностей показывает финансовое здоровье отеля. ' +
			'Ключевые метрики, разбивка по срокам, таблица должников — это пульс кэшфлоу.',
		async run(page, state) {
			if (!state.orgSlug) throw new Error('chapter 13 requires orgSlug')
			await page.goto(`/o/${state.orgSlug}/receivables`)
			await page.waitForLoadState('networkidle')
			await page.waitForTimeout(1800)
		},
	},
	{
		id: '14-admin-tax',
		title: 'Туристический налог',
		description: 'Сочи 2026, декларация КНД 1153008',
		narration:
			'Туристический налог уже учтён по тарифу два процента — норматив Сочи на две тысячи двадцать шестой год. ' +
			'KPI, разбивка по месяцам, выгрузка XLSX для бухгалтера или интеграции с 1С.',
		async run(page, state) {
			if (!state.orgSlug) throw new Error('chapter 14 requires orgSlug')
			await page.goto(`/o/${state.orgSlug}/admin/tax`)
			await page.waitForLoadState('networkidle')
			await page.waitForTimeout(1800)
		},
	},
	{
		id: '15-admin-notifications',
		title: 'Журнал уведомлений',
		description: 'Email рассылки гостям',
		narration:
			'Журнал автоматических email-рассылок гостям: подтверждения брони, напоминания о заезде, просьбы об отзыве. ' +
			'Видно статус доставки каждого письма, есть ручной retry для неудавшихся.',
		async run(page, state) {
			if (!state.orgSlug) throw new Error('chapter 15 requires orgSlug')
			await page.goto(`/o/${state.orgSlug}/admin/notifications`)
			await page.waitForLoadState('networkidle')
			await page.waitForTimeout(1800)
		},
	},
	{
		id: '16-final',
		title: 'HoReCa Sochi',
		description: 'Спасибо за внимание',
		narration:
			'Это HoReCa Sochi — современная PMS для малых отелей и гостиниц. ' +
			'Регистрация, настройка, ежедневная работа администратора, финансы и отчётность — в одной системе.',
		async run(page, state) {
			if (!state.orgSlug) throw new Error('chapter 16 requires orgSlug')
			await page.goto(`/o/${state.orgSlug}`)
			await page.waitForLoadState('networkidle')
			await page.waitForTimeout(2000)
		},
	},
]
