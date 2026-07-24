#!/usr/bin/env node
/**
 * Phase 3 Task 4 — audio synthesis for the on-device transcription MEASUREMENT spike.
 *
 *   node spikes/transcription-measurement/synth.mjs
 *
 * Turns each authored transcript in `spikes/extraction-snuggpro/transcripts/*.txt` into 16 kHz mono
 * WAV audio via macOS `say` (TTS) + `afconvert`, so we can feed REAL synthesized speech through the
 * real `OnDeviceTranscriber` and measure WER/RTF against text we wrote ourselves (exact ground truth,
 * no consent dependency).
 *
 * ## Why it chunks
 *
 * Whisper's feature extractor truncates to a 30 s window and the transcriber does NOT chunk yet
 * (worker.ts: "audio beyond that is silently clipped"). At say -r 155 (~2.85 words/s) every corpus
 * transcript except the very shortest exceeds 30 s, so a single clip would drop most of the tail and
 * make WER meaningless. This script therefore splits each transcript into <=~24 s segments at
 * SENTENCE boundaries, synthesizes one WAV per segment, and records the segment list in the manifest.
 * The browser harness transcribes each segment through the real transcriber and concatenates the text
 * — the chunking lives HERE (harness level), the transcriber itself is unchanged and still 30 s-bound.
 *
 * ## TTS is a floor, not a forecast
 *
 * `say` audio is clean: no background noise, no mic handling, no disfluent delivery, no cross-talk.
 * The numbers this produces are a FLOOR for on-device Whisper quality, not a prediction of real field
 * recordings (still gated on recording consent — out of scope).
 *
 * Output (all git-ignored via the testdata/*.wav rule; the manifest is regenerable):
 *   testdata/NN-slug--kK.wav     one 16 kHz mono WAV per segment
 *   testdata/manifest.json       { rate, voice, transcripts: [{ slug, sourceText, segments:[{wav,words,durationSec}], totalWords, totalDurationSec }] }
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CORPUS = join(HERE, "..", "extraction-snuggpro", "transcripts");
const OUT = join(HERE, "testdata");

const VOICE = "Samantha";
const RATE = 155; // words/min. Matches the manual test's fixture recipe.
const WORD_BUDGET = 66; // ~23 s at this rate; a safety margin under Whisper's 30 s window.
const MAX_SEG_SEC = 29; // hard ceiling; a segment above this would be truncated by Whisper.

/** Split a transcript into sentence-ish units, preserving every word. */
function sentences(text) {
  return text
    .split(/\n+/)
    .flatMap((para) => para.match(/[^.!?]+[.!?]*\s*/g) ?? (para.trim() ? [para] : []))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Greedily pack sentences into <=WORD_BUDGET-word segments (a long sentence stands alone). */
function segmentize(text) {
  const segs = [];
  let cur = [];
  let curWords = 0;
  for (const s of sentences(text)) {
    const w = s.split(/\s+/).length;
    if (curWords > 0 && curWords + w > WORD_BUDGET) {
      segs.push(cur.join(" "));
      cur = [];
      curWords = 0;
    }
    cur.push(s);
    curWords += w;
  }
  if (cur.length) segs.push(cur.join(" "));
  return segs;
}

function synth(text, wavPath) {
  const aiff = wavPath.replace(/\.wav$/, ".aiff");
  execFileSync("say", ["-v", VOICE, "-r", String(RATE), "-o", aiff, text]);
  // 16 kHz mono LEI16 — the rate Whisper decodes to internally. (The manual test uses 48 kHz to
  // exercise resampling; here we synthesize AT 16 kHz — the decode still runs, just as a pass-through,
  // and it keeps the fixtures small for 14 transcripts x many segments.)
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wavPath]);
  rmSync(aiff, { force: true });
  const info = execFileSync("afinfo", [wavPath], { encoding: "utf8" });
  const m = info.match(/estimated duration:\s*([\d.]+)\s*sec/);
  return m ? Number(m[1]) : NaN;
}

function main() {
  mkdirSync(OUT, { recursive: true });
  // Clear stale fixtures so a re-run is deterministic.
  for (const f of readdirSync(OUT)) if (f.endsWith(".wav")) rmSync(join(OUT, f), { force: true });

  const slugs = readdirSync(CORPUS)
    .filter((f) => f.endsWith(".txt"))
    .sort();

  const transcripts = [];
  for (const file of slugs) {
    const slug = basename(file, ".txt");
    const sourceText = readFileSync(join(CORPUS, file), "utf8").trim();
    const segTexts = segmentize(sourceText);
    const segments = [];
    segTexts.forEach((segText, i) => {
      const wav = `${slug}--k${i}.wav`;
      const durationSec = synth(segText, join(OUT, wav));
      const words = segText.split(/\s+/).length;
      if (durationSec > MAX_SEG_SEC) {
        console.warn(
          `!! ${wav} is ${durationSec.toFixed(1)}s (> ${MAX_SEG_SEC}s) — tail will clip`,
        );
      }
      segments.push({ wav, words, durationSec });
    });
    const totalWords = sourceText.split(/\s+/).length;
    const totalDurationSec = segments.reduce((a, s) => a + s.durationSec, 0);
    transcripts.push({ slug, sourceText, segments, totalWords, totalDurationSec });
    console.log(
      `${slug}: ${segments.length} seg, ${totalWords} words, ${totalDurationSec.toFixed(1)}s`,
    );
  }

  const manifest = { rate: RATE, voice: VOICE, wordBudget: WORD_BUDGET, transcripts };
  writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const totSec = transcripts.reduce((a, t) => a + t.totalDurationSec, 0);
  const totSeg = transcripts.reduce((a, t) => a + t.segments.length, 0);
  console.log(
    `\nWrote ${transcripts.length} transcripts, ${totSeg} segments, ${totSec.toFixed(0)}s audio total`,
  );
  console.log(`Manifest: ${join(OUT, "manifest.json")}`);
}

main();
