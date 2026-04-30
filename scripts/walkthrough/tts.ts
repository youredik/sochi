/**
 * TTS adapter — narration-text → MP3 file with measured duration.
 *
 * Default: macOS native `say` with Milena (ru_RU). Zero-config, works
 * offline, fine for PoC.
 *
 * Future: Yandex SpeechKit with «Алиса» (or alena/jane neural). When
 * `YC_API_KEY` + `YC_FOLDER_ID` are set in env, `pickTts()` swaps to
 * the SpeechKit provider — no other code changes needed.
 *
 * Both providers conform to `TtsProvider` so adding a third (e.g.
 * Coqui XTTS local, ElevenLabs) is one file + one entry in `pickTts()`.
 */
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'

export interface TtsResult {
	mp3Path: string
	durationSec: number
}

export interface TtsProvider {
	readonly name: string
	synthesize(text: string, mp3OutPath: string): Promise<TtsResult>
}

/* ============================================================ macOS say */

export const sayMac: TtsProvider = {
	name: 'macOS say (Milena ru_RU)',
	async synthesize(text, mp3OutPath) {
		const aiff = mp3OutPath.replace(/\.mp3$/, '.aiff')
		execFileSync('say', ['-v', 'Milena', '-r', '180', '-o', aiff, text], {
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', aiff, '-q:a', '4', mp3OutPath], {
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		rmSync(aiff)
		const durationSec = probeDuration(mp3OutPath)
		return { mp3Path: mp3OutPath, durationSec }
	},
}

/* ============================================================ Yandex SpeechKit */

/**
 * Yandex SpeechKit v1 REST synthesis — voice `alyss` (canonical Алиса).
 *
 * v1 chosen over v3 because v3's REST is gRPC-Web style (chunked JSON with
 * base64-encoded OPUS audio per chunk), requiring stream reassembly. v1
 * returns a single binary MP3 in one shot — much simpler, identical voice
 * quality for non-streaming use cases (which is exactly our case).
 *
 * Auth: `Authorization: Api-Key {YC_API_KEY}` (Service Account API Key).
 * The key is bound to a service account inside `YC_FOLDER_ID`; that folder
 * must have SpeechKit enabled and the SA must have role
 * `ai.speechkit-user` (or `ai.editor` / `editor`).
 *
 * Voice catalog (2026): alyss = Алиса (canonical), alena = "from Alice"
 * (similar timbre, more corporate), jane = softer female, ermil/filipp =
 * male announcers. See https://yandex.cloud/en/docs/speechkit/tts/voices.
 */
const SPEECHKIT_V1_URL = 'https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize'

export const speechKitAlisa: TtsProvider = {
	name: 'Yandex SpeechKit (alyss / Алиса)',
	async synthesize(text, mp3OutPath) {
		const apiKey = process.env.YC_API_KEY
		const folderId = process.env.YC_FOLDER_ID
		if (!apiKey || !folderId) {
			throw new Error(
				'speechKitAlisa: YC_API_KEY + YC_FOLDER_ID must be set in .env. ' +
					'See scripts/walkthrough/README.md for setup steps.',
			)
		}

		const body = new URLSearchParams({
			text,
			lang: 'ru-RU',
			voice: process.env.YC_TTS_VOICE ?? 'alyss',
			format: 'mp3',
			folderId,
			speed: process.env.YC_TTS_SPEED ?? '1.0',
		})

		const res = await fetch(SPEECHKIT_V1_URL, {
			method: 'POST',
			headers: {
				Authorization: `Api-Key ${apiKey}`,
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: body.toString(),
		})

		if (!res.ok) {
			const errText = await res.text()
			throw new Error(`SpeechKit ${res.status} ${res.statusText}: ${errText}`)
		}

		const audioBuf = Buffer.from(await res.arrayBuffer())
		if (audioBuf.length === 0) {
			throw new Error('SpeechKit returned empty audio body')
		}
		const { writeFileSync } = await import('node:fs')
		writeFileSync(mp3OutPath, audioBuf)

		const durationSec = probeDuration(mp3OutPath)
		return { mp3Path: mp3OutPath, durationSec }
	},
}

/* ============================================================ picker */

export function pickTts(): TtsProvider {
	if (process.env.YC_API_KEY && process.env.YC_FOLDER_ID) {
		return speechKitAlisa
	}
	return sayMac
}

/* ============================================================ helpers */

function probeDuration(path: string): number {
	const out = execFileSync(
		'ffprobe',
		['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
		{ encoding: 'utf8' },
	).trim()
	const n = Number(out)
	if (!Number.isFinite(n)) throw new Error(`ffprobe returned non-numeric duration: ${out}`)
	return n
}
