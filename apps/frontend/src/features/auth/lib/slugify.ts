/**
 * Cyrillic-aware slug generator for organization names.
 *
 * Better Auth's built-in slugify is Latin-only; passing a Cyrillic org name
 * ("Гостиница Ромашка") would yield an empty slug and the server would
 * reject the `organization.create` call. We transliterate first, then
 * lowercase + strip non-URL-safe chars. If the result is empty (e.g. user
 * typed emoji-only), we return an empty string so the caller can either
 * ask the user to edit or fall back to a random id.
 *
 * GOST 7.79 (system B) transliteration for individual characters —
 * single-letter mapping chosen over context-aware rules because admin
 * slugs prioritize uniqueness and editability over phonetic accuracy.
 */

const CYRILLIC_TO_LATIN: Record<string, string> = {
	а: 'a',
	б: 'b',
	в: 'v',
	г: 'g',
	д: 'd',
	е: 'e',
	ё: 'yo',
	ж: 'zh',
	з: 'z',
	и: 'i',
	й: 'j',
	к: 'k',
	л: 'l',
	м: 'm',
	н: 'n',
	о: 'o',
	п: 'p',
	р: 'r',
	с: 's',
	т: 't',
	у: 'u',
	ф: 'f',
	х: 'h',
	ц: 'c',
	ч: 'ch',
	ш: 'sh',
	щ: 'shh',
	ъ: '',
	ы: 'y',
	ь: '',
	э: 'e',
	ю: 'yu',
	я: 'ya',
}

export function slugify(input: string): string {
	const lowered = input.trim().toLowerCase()
	let out = ''
	for (const ch of lowered) {
		out += CYRILLIC_TO_LATIN[ch] ?? ch
	}
	return out
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48)
}
