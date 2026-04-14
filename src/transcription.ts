/**
 * Speech-to-text transcription via the Parakeet STT service.
 *
 * Channel-agnostic: accepts raw audio bytes (any format the STT service
 * supports — OGG/Opus, WAV, FLAC, etc.) and returns transcribed text.
 *
 * The STT service is auto-detected at startup by probing the health endpoint
 * of the openbob-stt container. No configuration needed — just start with
 * `docker compose --profile stt up`.
 */

import { logger } from './logger.js';

const STT_SERVICE_URL = 'http://openbob-stt:8000';

let sttAvailable: boolean | null = null;

/**
 * Probe the STT service health endpoint once at startup.
 * Caches the result — subsequent calls return immediately.
 */
async function probeStt(): Promise<boolean> {
  if (sttAvailable !== null) return sttAvailable;

  try {
    const response = await fetch(`${STT_SERVICE_URL}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    sttAvailable = response.ok;
    // eslint-disable-next-line no-catch-all/no-catch-all -- probe failure means STT is not available
  } catch (_err) {
    sttAvailable = false;
  }

  if (sttAvailable) {
    logger.info('STT service detected at %s', STT_SERVICE_URL);
  } else {
    logger.debug('STT service not available — voice transcription disabled');
  }

  return sttAvailable;
}

/**
 * Whether speech-to-text transcription is available.
 * Returns false until probeStt() has been called.
 */
export function isTranscriptionEnabled(): boolean {
  return sttAvailable === true;
}

/**
 * Initialize STT: probe the service and cache availability.
 * Call once at startup.
 */
export async function initTranscription(): Promise<void> {
  await probeStt();
}

/**
 * Transcribe audio bytes to text.
 *
 * @param audioBuffer - Raw audio file bytes (OGG/Opus, WAV, FLAC, etc.)
 * @param filename    - Filename hint for the STT service (e.g. "voice.oga")
 * @returns Transcribed text, or null if transcription failed or is disabled.
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  filename = 'audio.oga',
): Promise<string | null> {
  if (!isTranscriptionEnabled()) {
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
