import { createFileRoute, Link } from '@tanstack/react-router'

/**
 * Privacy policy. начальная версия — public access (no auth guard), ru-RU only,
 * based on the Roskomnadzor template for small operators of personal data
 * under 152-ФЗ. This file is NOT a stub: the text below is the initial
 * real policy customers can sign via the /signup consent checkbox.
 * Updates to this text should bump `policyVersion` (future feature) so
 * existing users re-consent.
 *
 * When we publicly launch and collect PD from guests (not just owners),
 * this policy splits into operator ↔ data-subject templates — see
 * project_ru_compliance_blockers memory for the full compliance roadmap.
 */
export const Route = createFileRoute('/privacy')({
	component: PrivacyPage,
})

function PrivacyPage() {
	return (
		<main className="mx-auto max-w-3xl px-6 py-12">
			<Link to="/" className="text-sm text-blue-400 hover:text-blue-300">
				← На главную
			</Link>
			<h1 className="mt-4 text-2xl font-semibold tracking-tight">Политика конфиденциальности</h1>
			<p className="mt-1 text-xs text-neutral-500">Редакция: 23 апреля 2026 г.</p>

			<div className="prose prose-invert mt-8 space-y-4 text-sm text-neutral-300">
				<h2 className="text-lg font-semibold text-neutral-100">1. Оператор</h2>
				<p>
					Настоящая Политика действует в отношении персональных данных, которые Оператор (далее —{' '}
					<em>«Портал»</em>) может получить от пользователя при регистрации, создании организации и
					использовании сервиса HoReCa для управления гостиничным бизнесом в регионе Большого Сочи.
				</p>

				<h2 className="text-lg font-semibold text-neutral-100">2. Состав обрабатываемых данных</h2>
				<ul className="list-disc pl-6">
					<li>контактные данные: имя, email, телефон (опционально);</li>
					<li>данные учётной записи: логин, пароль (в виде хеша), сессионные токены;</li>
					<li>данные организации: название, ИНН (опционально), адрес;</li>
					<li>операционные данные о бронированиях и гостях, вносимые пользователем.</li>
				</ul>

				<h2 className="text-lg font-semibold text-neutral-100">3. Цели обработки</h2>
				<ul className="list-disc pl-6">
					<li>оказание услуг по управлению гостиничным бизнесом;</li>
					<li>
						выполнение требований законодательства РФ, в том числе передача данных в МВД по
						миграционному учёту (ПП №1668);
					</li>
					<li>техническая поддержка, защита инфраструктуры;</li>
					<li>формирование агрегированной статистики без идентификации лиц.</li>
				</ul>

				<h2 className="text-lg font-semibold text-neutral-100">4. Правовые основания</h2>
				<p>
					Обработка осуществляется на основании согласия пользователя (ст. 6 ч. 1 п. 1 152-ФЗ), для
					исполнения договора (п. 5), и в силу закона (п. 2 — миграционный учёт).
				</p>

				<h2 className="text-lg font-semibold text-neutral-100">5. Хранение и безопасность</h2>
				<p>
					Данные хранятся на серверах Yandex Cloud (регион <code>ru-central1</code>) с соблюдением
					ФЗ-242 о локализации. Активность по учётным записям журналируется с удержанием 2 года
					(включает события создания, изменения и удаления броней, входы, смены пароля и другие
					действия, влияющие на целостность данных).
				</p>

				<h2 className="text-lg font-semibold text-neutral-100">6. Передача третьим лицам</h2>
				<p>
					Персональные данные не передаются третьим лицам, за исключением случаев, предусмотренных
					законодательством РФ (МВД, налоговые органы). Данные не передаются за пределы РФ.
				</p>

				<h2 className="text-lg font-semibold text-neutral-100">7. Права субъекта</h2>
				<p>
					Пользователь вправе запросить уточнение, блокирование, удаление своих данных, а также
					отозвать согласие на обработку. Запросы направляются на адрес поддержки, ответ — в течение
					10 рабочих дней.
				</p>

				<h2 className="text-lg font-semibold text-neutral-100">8. Контакты</h2>
				<p>
					По вопросам обработки персональных данных:{' '}
					<a className="text-blue-400" href="mailto:privacy@horeca.local">
						privacy@horeca.local
					</a>
					. Уведомление об обработке зарегистрировано в реестре Роскомнадзора (сведения появятся
					после публичного запуска сервиса).
				</p>
			</div>
		</main>
	)
}
