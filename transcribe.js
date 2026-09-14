/**
 * Voice-note transcription with the Gemini API (the free tier is enough).
 *
 *   GEMINI_API_KEY   required — https://aistudio.google.com/apikey
 *   GEMINI_MODEL     optional — tried first, before the defaults below
 *
 * Audio leaves the machine only when a transcription is asked for, and only
 * that one file. Nothing here runs in the background.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEDIA_DIR } from './db.js';

const API = process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta';
const MAX_INLINE_BYTES = 19 * 1024 * 1024;   // Gemini caps an inline request at 20 MB

// Google retires model names regularly; a missing one falls through to the next.
const MODELS = [...new Set([process.env.GEMINI_MODEL, 'gemini-flash-latest', 'gemini-2.5-flash'].filter(Boolean))];

const PROMPT = [
  'Transcribe this WhatsApp voice note word for word, in the language it is spoken in.',
  'If several languages are mixed, keep them as spoken.',
  'If it is not entirely in English, add a blank line and then "English:" followed by a translation.',
  'Mark inaudible parts as [inaudible]. If there is no speech, reply exactly: [no speech]',
  'Reply with the transcript only — no preamble, no timestamps, no speaker labels.',
].join(' ');

export const transcriptionConfigured = () => Boolean(process.env.GEMINI_API_KEY);

/** Bytes of a voice note: the downloaded file if we have it, otherwise fetched from WhatsApp's CDN. */
export async function audioBytes(msg) {
  if (msg.media_path && existsSync(msg.media_path)) {
    return { buf: readFileSync(msg.media_path), path: msg.media_path, fetched: false };
  }
  if (!msg.media_ref) {
    throw new Error('This voice note was never downloaded and has no download reference '
      + '(it was stored by an older version of the bridge). Only newer voice notes can be transcribed.');
  }
  const ref = JSON.parse(msg.media_ref);
  // Loaded lazily: Baileys is heavy and most calls never need it.
  const { downloadContentFromMessage } = await import('baileys');
  let buf;
  try {
    const stream = await downloadContentFromMessage(
      { mediaKey: Buffer.from(ref.mediaKey, 'base64'), directPath: ref.directPath, url: ref.url },
      'audio',
    );
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    buf = Buffer.concat(chunks);
  } catch (e) {
    throw new Error(`Couldn't download the voice note from WhatsApp (${e.message}). `
      + 'Older media expires off WhatsApp\'s servers after a few weeks.');
  }
  const path = join(MEDIA_DIR, `${msg.id}_${msg.id}.${msg.kind === 'voice' ? 'ogg' : 'm4a'}`);
  writeFileSync(path, buf);
  return { buf, path, fetched: true };
}

/** "audio/ogg; codecs=opus" -> "audio/ogg" */
function baseMime(mime, kind) {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  if (m.startsWith('audio/')) return m;
  return kind === 'voice' ? 'audio/ogg' : 'audio/mp4';
}

export async function transcribe(buf, { mime, kind }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error('Transcription is off: set GEMINI_API_KEY (free at https://aistudio.google.com/apikey) '
      + 'in the .env file next to server.js, then restart Claude Code.');
  }
  if (buf.length > MAX_INLINE_BYTES) {
    throw new Error(`Audio is ${(buf.length / 1048576).toFixed(1)} MB; Gemini accepts up to 20 MB inline.`);
  }

  const body = JSON.stringify({
    contents: [{
      parts: [
        { text: PROMPT },
        { inline_data: { mime_type: baseMime(mime, kind), data: buf.toString('base64') } },
      ],
    }],
    generationConfig: { temperature: 0 },
  });

  let lastError;
  for (const model of MODELS) {
    const res = await fetch(`${API}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body,
      signal: AbortSignal.timeout(120_000),
    });
    const json = await res.json().catch(() => ({}));

    if (res.status === 404) { lastError = `model ${model} not found`; continue; }
    if (res.status === 429) {
      throw new Error('Gemini rate limit reached (the free tier allows a handful of requests per minute '
        + 'and a daily quota). Wait a minute and try again.');
    }
    if (res.status === 400 && /api key/i.test(json.error?.message || '')) {
      throw new Error('Gemini rejected the API key. Check GEMINI_API_KEY.');
    }
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${json.error?.message || res.statusText}`);

    const cand = json.candidates?.[0];
    const out = (cand?.content?.parts || []).map((p) => p.text || '').join('').trim();
    if (!out) {
      const why = json.promptFeedback?.blockReason || cand?.finishReason || 'empty response';
      throw new Error(`Gemini returned no transcript (${why}).`);
    }
    return { text: out, model };
  }
  throw new Error(`No usable Gemini model (${lastError}). Set GEMINI_MODEL to a current model name.`);
}
