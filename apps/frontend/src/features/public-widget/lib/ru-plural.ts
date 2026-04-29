/**
 * RU plural rules — three forms (one / few / many) per CLDR canonical.
 * Used для пользовательских сообщений widget'а: «N объект/объекта/объектов».
 *
 * Rules (CLDR Russian):
 *   - mod100 in 11..14 → many (объектов): «11/12/13/14 объектов»
 *   - mod10 === 1 → one (объект): «1, 21, 101, 1001 объект»
 *   - mod10 in 2..4 → few (объекта): «2, 3, 4, 22, 23, 104 объекта»
 *   - else → many (объектов): «0, 5..9, 10 объектов»
 *
 * Edge cases (verified тестами):
 *   - 0 → many (object pluralization vs absent — CLDR canonical)
 *   - 11..14 special case (always many, despite mod10 in 1..4)
 *   - 111..114 same special case (mod100 propagation)
 *   - 121, 122 fall-through к mod10 rule (mod100=21,22 NOT in 11..14)
 *
 * Caller guards негативные / non-integer values — zero-config helper.
 *
 * Why separate file (not inline в widget-page.tsx): Vite Fast Refresh
 * требует чтобы component files exported только components. Mixed exports
 * triggers `lint/style/useComponentExportOnlyModules`.
 */
export function ruPlural(n: number, one: string, few: string, many: string): string {
	const mod10 = n % 10
	const mod100 = n % 100
	if (mod100 >= 11 && mod100 <= 14) return many
	if (mod10 === 1) return one
	if (mod10 >= 2 && mod10 <= 4) return few
	return many
}
