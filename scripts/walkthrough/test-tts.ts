#!/usr/bin/env node
/**
 * TTS smoke test — synthesize a short phrase via the active provider
 * (`pickTts()`) and auto-play via macOS `afplay`. Useful to:
 *
 *   1. Verify Yandex SpeechKit credentials work before re-running the
 *      full `pnpm walkthrough` (which costs more synthesis quota + time).
 *   2. Compare voice options (alyss / alena / jane / filipp) via
 *      `YC_TTS_VOICE=alena pnpm tts:test "..."`.
 *   3. Tune speech rate via `YC_TTS_SPEED=0.9 pnpm tts:test`.
 *
 * Usage:
 *   pnpm tts:test                       # default 5-sec greeting
 *   pnpm tts:test "ваш текст здесь"     # custom text
 *
 * Output: .artifacts/walkthrough/test-tts.mp3
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { pickTts } from './tts.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')
const OUT_DIR = resolve(ROOT, '.artifacts', 'walkthrough')
mkdirSync(OUT_DIR, { recursive: true })

const DEFAULT_TEXT =
	'Привет! Это голос Алисы из Yandex SpeechKit. Я буду озвучивать walkthrough-туры по платформе HoReCa Сочи.'
const text = process.argv[2] ?? DEFAULT_TEXT

const tts = pickTts()
console.log(`[test-tts] provider: ${tts.name}`)
console.log(`[test-tts] text:     "${text}"`)
console.log(`[test-tts] length:   ${text.length} chars`)

const outPath = resolve(OUT_DIR, 'test-tts.mp3')
const t0 = Date.now()
const { mp3Path, durationSec } = await tts.synthesize(text, outPath)
const wallSec = (Date.now() - t0) / 1000
console.log(
	`[test-tts] synthesized: ${mp3Path} (${durationSec.toFixed(2)}s audio, ${wallSec.toFixed(2)}s wall)`,
)

console.log('[test-tts] playing via afplay…')
execFileSync('afplay', [mp3Path], { stdio: 'inherit' })
console.log('[test-tts] done.')
