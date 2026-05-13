/**
 * Magic-link sign-in email template.
 *
 * Russian-first. Plain `<a>` tag (no third-party renderer like react-email) —
 * keeps the backend bundle small and ensures deterministic HTML for tests.
 * Inline CSS for max client compatibility (Mail.ru / Yandex.Mail / Outlook
 * mangle <style> blocks).
 *
 * Security copy: explicitly says «не передавайте эту ссылку никому» and
 * notes the TTL (caller passes `expiryMinutes` derived from the same
 * `MAGIC_LINK_TTL_SECONDS` constant that drives BA's `expiresIn` — see
 * `auth.ts`). Anti-phishing posture: displayed expiry always matches
 * actual token life.
 */

export interface MagicLinkEmailInput {
	signInUrl: string
	expiryMinutes: number
}

export interface RenderedEmail {
	subject: string
	html: string
	text: string
}

export function magicLinkEmail({ signInUrl, expiryMinutes }: MagicLinkEmailInput): RenderedEmail {
	const subject = 'Вход в HoReCa — ваша одноразовая ссылка'

	const html = `<!doctype html>
<html lang="ru"><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f6f7f9;margin:0;padding:24px;">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px 28px;">
<h1 style="margin:0 0 12px;font-size:20px;color:#0a0a0a;">Вход в HoReCa-портал</h1>
<p style="margin:0 0 20px;color:#4a4a4a;line-height:1.55;">Нажмите кнопку ниже, чтобы войти. Ссылка одноразовая и действует <strong>${expiryMinutes} минут</strong>.</p>
<p style="margin:0 0 24px;"><a href="${signInUrl}" style="display:inline-block;padding:12px 24px;background:#006bbd;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;">Войти в кабинет</a></p>
<p style="margin:0 0 8px;color:#737373;font-size:13px;">Если кнопка не работает, скопируйте ссылку в адресную строку браузера:</p>
<p style="margin:0 0 24px;color:#737373;font-size:13px;word-break:break-all;"><a href="${signInUrl}" style="color:#006bbd;">${signInUrl}</a></p>
<hr style="border:0;border-top:1px solid #e5e5e5;margin:24px 0;"/>
<p style="margin:0;color:#737373;font-size:12px;line-height:1.5;">Если вы не пытались войти — просто игнорируйте это письмо. <strong>Не передавайте эту ссылку никому</strong>: тот, кто откроет её, попадёт в ваш кабинет.</p>
</div></body></html>`

	const text = [
		'Вход в HoReCa-портал',
		'',
		`Перейдите по одноразовой ссылке (действует ${expiryMinutes} минут):`,
		signInUrl,
		'',
		'Если вы не пытались войти — игнорируйте это письмо. Не передавайте ссылку никому.',
	].join('\n')

	return { subject, html, text }
}
