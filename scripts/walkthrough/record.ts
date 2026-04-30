#!/usr/bin/env node
/**
 * Walkthrough recorder — produces a narrated MP4 tour of the whole platform.
 *
 * Pipeline:
 *   1. TTS provider (Milena now, Алиса/SpeechKit when YC keys are set)
 *      synthesizes each chapter's narration → MP3 + measured duration.
 *   2. ffmpeg concatenates MP3s with small inter-chapter silence gaps
 *      → single audio track.
 *   3. Playwright 1.59 page.screencast records WEBM, with showChapter +
 *      showActions overlays for narrative context. Each chapter's actions
 *      are paced to match the corresponding narration audio length.
 *   4. ffmpeg muxes WEBM + combined MP3 → final MP4 with H.264/AAC.
 *
 * Output: .artifacts/walkthrough/tour.mp4 (gitignored)
 *
 * Prerequisites: dev servers up (`pnpm dev`), ffmpeg installed (`brew install
 * ffmpeg`), macOS for Milena voice. CI/Linux: needs SpeechKit creds (future).
 *
 * Usage: pnpm walkthrough
 *
 * NOT a test — no assertions, doesn't gate pre-push. Failures of individual
 * chapters are logged + screenshot-dumped, the recording continues so a
 * partial tour is recoverable.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { type Chapter, chapters, type TourState } from './chapters.ts'
import { pickTts } from './tts.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')
const OUT = resolve(ROOT, '.artifacts', 'walkthrough')
const AUDIO_DIR = resolve(OUT, 'audio')
mkdirSync(AUDIO_DIR, { recursive: true })

const BASE_URL = process.env.WALKTHROUGH_BASE_URL ?? 'http://localhost:5273'
const VIEWPORT = { width: 1280, height: 720 } as const
const INTER_CHAPTER_GAP_SEC = 0.4
const TAIL_BUFFER_MS = 800

const log = (...a: unknown[]) => console.log('[walk]', ...a)
const sh = (cmd: string, args: string[]): void => {
	execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
}

/* ============================================================ 1. TTS */

const tts = pickTts()
log(`TTS provider: ${tts.name}`)

const durations: number[] = []
for (const ch of chapters) {
	const mp3 = resolve(AUDIO_DIR, `${ch.id}.mp3`)
	const { durationSec } = await tts.synthesize(ch.narration, mp3)
	durations.push(durationSec)
	log(`  ${ch.id}: ${durationSec.toFixed(2)}s — "${ch.title}"`)
}

const totalNarration = durations.reduce((a, b) => a + b, 0)
log(`total narration: ${totalNarration.toFixed(1)}s (${(totalNarration / 60).toFixed(1)} min)`)

/* ============================================================ 2. concat audio */

log('concatenating audio with inter-chapter silence…')
const silenceMp3 = resolve(AUDIO_DIR, '_silence.mp3')
sh('ffmpeg', [
	'-y',
	'-loglevel',
	'error',
	'-f',
	'lavfi',
	'-i',
	'anullsrc=channel_layout=mono:sample_rate=22050',
	'-t',
	String(INTER_CHAPTER_GAP_SEC),
	'-q:a',
	'4',
	silenceMp3,
])

const listFile = resolve(AUDIO_DIR, '_concat.txt')
const listLines: string[] = []
for (let i = 0; i < chapters.length; i++) {
	listLines.push(`file '${resolve(AUDIO_DIR, `${chapters[i].id}.mp3`)}'`)
	if (i < chapters.length - 1) listLines.push(`file '${silenceMp3}'`)
}
writeFileSync(listFile, listLines.join('\n'))
const combinedAudio = resolve(AUDIO_DIR, 'combined.mp3')
sh('ffmpeg', [
	'-y',
	'-loglevel',
	'error',
	'-f',
	'concat',
	'-safe',
	'0',
	'-i',
	listFile,
	'-c',
	'copy',
	combinedAudio,
])

/* ============================================================ 3. Playwright screencast */

log('launching Playwright (headless chromium)…')
const browser = await chromium.launch({ headless: true, slowMo: 120 })
const context = await browser.newContext({
	baseURL: BASE_URL,
	viewport: VIEWPORT,
	deviceScaleFactor: 1,
	locale: 'ru-RU',
})
const page = await context.newPage()

const videoPath = resolve(OUT, 'tour.webm')
log(`recording → ${videoPath}`)
await page.screencast.start({
	path: videoPath,
	size: VIEWPORT,
	quality: 85,
})
await page.screencast.showActions({ position: 'top-right', duration: 1800, fontSize: 22 })

const state: TourState = {
	orgSlug: null,
	bookingId: null,
	folioId: null,
	propertyId: null,
}

const t0 = Date.now()
let cumulativeAudioSec = 0

for (let i = 0; i < chapters.length; i++) {
	const ch: Chapter = chapters[i]
	const audioSec = durations[i]
	log(`  → chapter ${ch.id}: "${ch.title}" (audio ${audioSec.toFixed(1)}s)`)

	await page.screencast.showChapter(ch.title, {
		description: ch.description,
		duration: 2500,
	})

	try {
		await ch.run(page, state)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		log(`  ! chapter ${ch.id} failed: ${message}`)
		const dumpPath = resolve(OUT, `fail-${ch.id}.png`)
		await page.screenshot({ path: dumpPath, fullPage: true }).catch(() => {})
		log(`    page url: ${page.url()}`)
		log(`    dumped: ${dumpPath}`)
	}

	cumulativeAudioSec += audioSec
	if (i < chapters.length - 1) cumulativeAudioSec += INTER_CHAPTER_GAP_SEC

	const targetMs = cumulativeAudioSec * 1000
	const elapsedMs = Date.now() - t0
	const padMs = targetMs - elapsedMs
	if (padMs > 0) {
		log(`    padding ${(padMs / 1000).toFixed(1)}s to sync with audio`)
		await page.waitForTimeout(padMs)
	} else {
		log(`    chapter ran ${(-padMs / 1000).toFixed(1)}s longer than audio (audio will trail)`)
	}
}

await page.waitForTimeout(TAIL_BUFFER_MS)
log('stopping screencast…')
await page.screencast.stop()
await browser.close()

const videoStat = statSync(videoPath)
log(`video: ${videoPath} (${(videoStat.size / 1e6).toFixed(2)} MB)`)

/* ============================================================ 4. mux */

const finalMp4 = resolve(OUT, 'tour.mp4')
log(`muxing → ${finalMp4}`)
sh('ffmpeg', [
	'-y',
	'-loglevel',
	'error',
	'-i',
	videoPath,
	'-i',
	combinedAudio,
	'-c:v',
	'libx264',
	'-preset',
	'medium',
	'-crf',
	'23',
	'-c:a',
	'aac',
	'-b:a',
	'128k',
	'-pix_fmt',
	'yuv420p',
	'-movflags',
	'+faststart',
	finalMp4,
])

const finalStat = statSync(finalMp4)
log(`✅ done: ${finalMp4} (${(finalStat.size / 1e6).toFixed(2)} MB)`)
