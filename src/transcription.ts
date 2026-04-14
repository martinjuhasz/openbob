/**
 * Speech-to-text transcription via the Parakeet STT service.
 *
 * Channel-agnostic: accepts raw audio bytes (any format the STT service
 * supports — OGG/Opus, WAV, FLAC, etc.) and returns transcribed text.
 *
 * The STT service is auto-detected by probing the health endpoint of the
 * openbob-stt container. The probe result is cached for 60s so we don't
 * hit a timeout on every voice message when the service is down, but
 * also recover automatically when it becomes available later.
 *
 * No configuration needed — just start with `docker compose --profile stt up`.
 */

import { logger } from './logger.js';

const STT_SERVICE_URL = 'http://openbob-stt:8000';

/** Cached probe result + timestamp. */
let sttProbe: { available: boolean; checkedAt: number } | null = null;

/** Re-probe after 60 seconds. */
const PROBE_TTL_MS = 60_000;

/**
 * Probe the STT service health endpoint.
 * Caches the result for PROBE_TTL_MS to avoid repeated timeouts.
 */
async function probeStt(): Promise<boolean> {
  const now = Date.now();
  if (sttProbe && now - sttProbe.checkedAt < PROBE_TTL_MS) {
    return sttProbe.available;
  }

  let available = false;
  try {
    const response = await fetch(`${STT_SERVICE_URL}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    available = response.ok;
    // eslint-disable-next-line no-catch-all/no-catch-all -- probe failure means STT is not available
  } catch (_err) {
    available = false;
  }

  const wasAvailable = sttProbe?.available ?? null;
  sttProbe = { available, checkedAt: now };

  // Only log on state changes to avoid spam
  if (wasAvailable !== available) {
    if (available) {
      logger.info('STT service detected at %s', STT_SERVICE_URL);
    } else {
      logger.debug('STT service not available — voice transcription disabled');
    }
  }

  return available;
}

/**
 * Whether speech-to-text transcription is available.
 * Uses the cached probe result (synchronous). Returns false if never probed.
 */
export function isTranscriptionEnabled(): boolean {
  return sttProbe?.available === true;
}

/**
 * Transcribe audio bytes to text.
 *
 * Probes the STT service first (with caching). If the service is not
 * available, returns null immediately without a long timeout.
 *
 * @param audioBuffer - Raw audio file bytes (OGG/Opus, WAV, FLAC, etc.)
 * @param filename    - Filename hint for the STT service (e.g. "voice.oga")
 * @returns Transcribed text, or null if transcription failed or is disabled.
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  filename = 'audio.oga',
): Promise<string | null> {
  const available = await probeStt();
  if (!available) {
    return null;
  }

  const url = `${STT_SERVICE_URL}/transcribe`;

  try {
    // Build multipart/form-data using the Blob/FormData APIs
    // available in Node 18+ (no external dependency needed).
    const formData = new FormData();
    const blob = new Blob([audioBuffer], { type: 'audio/ogg' });
    formData.append('file', blob, filename);

    const response = await fetch(url, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(30_000), // 30s timeout
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      logger.warn(
        { status: response.status, detail, url },
        'STT service returned error',
      );
      return null;
    }

    const data = (await response.json()) as { text?: string };
    const text = (data.text || '').trim();

    if (!text) {
      logger.debug('STT returned empty transcription');
      return null;
    }

    logger.info(
      { chars: text.length, audioBytes: audioBuffer.length },
      'Audio transcribed successfully',
    );
    return text;
    // eslint-disable-next-line no-catch-all/no-catch-all -- graceful degradation: STT failure should not break message flow
  } catch (err) {
    logger.warn({ err, url }, 'STT transcription failed');
    return null;
  }
}
