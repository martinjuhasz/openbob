/**
 * Media transcription module for openbob agents.
 *
 * Supports three source types:
 * 1. YouTube URLs — tries captions first, then yt-dlp auto-subs, then audio download + STT
 * 2. Remote audio/video URLs — downloads and transcribes via STT
 * 3. Local audio/video files — transcribes via STT directly
 *
 * STT is provided by the openbob-stt sidecar (Parakeet TDT) reachable
 * at http://openbob-stt:8000 on the shared Docker network.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { fetchTranscript } from 'youtube-transcript-plus';

const execFileAsync = promisify(execFile);

const STT_BASE_URL = 'http://openbob-stt:8000';
const TMP_BASE = '/tmp/transcribe';
const YT_DLP_TIMEOUT = 120_000;
const FFMPEG_TIMEOUT = 60_000;
const STT_TIMEOUT = 120_000;
const DOWNLOAD_TIMEOUT = 120_000;

export interface TranscriptSegment {
  text: string;
  offset: number;
}

export interface TranscriptResult {
  text: string;
  segments?: TranscriptSegment[];
  method: 'captions' | 'yt-dlp-subs' | 'stt';
  language?: string;
}

// ---------------------------------------------------------------------------
// YouTube URL detection & ID extraction
// ---------------------------------------------------------------------------

const YOUTUBE_PATTERNS = [
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?.*v=([a-zA-Z0-9_-]{11})/,
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/live\/([a-zA-Z0-9_-]{11})/,
  /(?:https?:\/\/)?youtu\.be\/([a-zA-Z0-9_-]{11})/,
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/v\/([a-zA-Z0-9_-]{11})/,
];

export function isYouTubeUrl(source: string): boolean {
  return YOUTUBE_PATTERNS.some((p) => p.test(source));
}

export function extractYouTubeId(source: string): string | null {
  for (const pattern of YOUTUBE_PATTERNS) {
    const match = source.match(pattern);
    if (match) return match[1];
  }
  // Bare video ID (11 chars, alphanumeric + dash + underscore)
  if (/^[a-zA-Z0-9_-]{11}$/.test(source)) return source;
  return null;
}

// ---------------------------------------------------------------------------
// Temp directory management
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = path.join(
    TMP_BASE,
    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupTmpDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// Step 1a: YouTube captions via youtube-transcript-plus
// ---------------------------------------------------------------------------

async function fetchCaptionsViaLib(
  videoIdOrUrl: string,
  lang?: string,
): Promise<TranscriptResult | null> {
  try {
    const config: { lang?: string } = {};
    if (lang) config.lang = lang;

    const segments = await fetchTranscript(videoIdOrUrl, config);
    if (!segments || segments.length === 0) return null;

    const mapped: TranscriptSegment[] = segments.map(
      (s: { text: string; offset: number }) => ({
        text: s.text,
        offset: s.offset,
      }),
    );

    return {
      text: segments.map((s: { text: string }) => s.text).join(' '),
      segments: mapped,
      method: 'captions',
      language: (segments[0] as { lang?: string }).lang ?? lang ?? undefined,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Step 1b: YouTube auto-subs via yt-dlp
// ---------------------------------------------------------------------------

async function fetchSubsViaYtDlp(
  videoId: string,
  lang?: string,
): Promise<TranscriptResult | null> {
  const tmpDir = makeTmpDir();
  try {
    const subLang = lang ?? 'en';
    const outputTemplate = path.join(tmpDir, '%(id)s');

    await execFileAsync(
      'yt-dlp',
      [
        '--write-auto-sub',
        '--write-sub',
        '--sub-lang',
        subLang,
        '--sub-format',
        'srt',
        '--skip-download',
        '--no-warnings',
        '--no-playlist',
        '-o',
        outputTemplate,
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      { timeout: YT_DLP_TIMEOUT },
    );

    // Look for .srt files (yt-dlp creates <id>.<lang>.srt)
    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.srt'));
    if (files.length === 0) return null;

    const srtContent = fs.readFileSync(path.join(tmpDir, files[0]), 'utf-8');
    const segments = parseSrt(srtContent);
    if (segments.length === 0) return null;

    return {
      text: segments.map((s) => s.text).join(' '),
      segments,
      method: 'yt-dlp-subs',
      language: subLang,
    };
  } catch {
    return null;
  } finally {
    cleanupTmpDir(tmpDir);
  }
}

// ---------------------------------------------------------------------------
// SRT parser
// ---------------------------------------------------------------------------

export function parseSrt(srt: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  // Split on blank lines to get cue blocks
  const blocks = srt.trim().split(/\n\s*\n/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 3) continue;

    // Line 1: index (skip)
    // Line 2: timestamp "00:01:23,456 --> 00:01:25,789"
    const timeLine = lines[1];
    const timeMatch = timeLine.match(
      /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->/,
    );
    if (!timeMatch) continue;

    const hours = parseInt(timeMatch[1], 10);
    const minutes = parseInt(timeMatch[2], 10);
    const seconds = parseInt(timeMatch[3], 10);
    const millis = parseInt(timeMatch[4], 10);
    const offset = hours * 3600 + minutes * 60 + seconds + millis / 1000;

    // Lines 3+: text (may span multiple lines), strip HTML tags
    const text = lines
      .slice(2)
      .join(' ')
      .replace(/<[^>]*>/g, '')
      .trim();
    if (!text) continue;

    segments.push({ text, offset });
  }

  return segments;
}

// ---------------------------------------------------------------------------
// Audio download via yt-dlp (YouTube or direct URLs)
// ---------------------------------------------------------------------------

async function downloadAudioViaYtDlp(
  source: string,
  tmpDir: string,
): Promise<string> {
  const outputPath = path.join(tmpDir, 'audio.wav');

  await execFileAsync(
    'yt-dlp',
    [
      '-x',
      '--audio-format',
      'wav',
      '--no-warnings',
      '--no-playlist',
      '-o',
      path.join(tmpDir, 'audio.%(ext)s'),
      source,
    ],
    { timeout: YT_DLP_TIMEOUT },
  );

  // yt-dlp may produce audio.wav directly, or we need to find the output
  if (fs.existsSync(outputPath)) return outputPath;

  // If not wav, find whatever audio file was downloaded and convert
  const files = fs
    .readdirSync(tmpDir)
    .filter((f) => f.startsWith('audio.') && !f.endsWith('.part'));
  if (files.length === 0) {
    throw new Error('yt-dlp did not produce an audio file');
  }

  const downloadedPath = path.join(tmpDir, files[0]);
  return convertToWav(downloadedPath, tmpDir);
}

// ---------------------------------------------------------------------------
// Remote file download via fetch
// ---------------------------------------------------------------------------

async function downloadRemoteFile(
  url: string,
  tmpDir: string,
): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT),
  });

  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  const ext = guessExtension(contentType, url);
  const filePath = path.join(tmpDir, `download${ext}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(filePath, buffer);

  return filePath;
}

function guessExtension(contentType: string, url: string): string {
  const mimeMap: Record<string, string> = {
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/ogg': '.ogg',
    'audio/flac': '.flac',
    'audio/mp4': '.m4a',
    'audio/x-m4a': '.m4a',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/quicktime': '.mov',
  };

  for (const [mime, ext] of Object.entries(mimeMap)) {
    if (contentType.includes(mime)) return ext;
  }

  // Try URL path extension
  const urlPath = new URL(url).pathname;
  const urlExt = path.extname(urlPath);
  if (urlExt) return urlExt;

  return '.audio';
}

// ---------------------------------------------------------------------------
// FFmpeg conversion to WAV (16kHz mono, required by Parakeet)
// ---------------------------------------------------------------------------

async function convertToWav(
  inputPath: string,
  tmpDir: string,
): Promise<string> {
  const outputPath = path.join(tmpDir, 'converted.wav');

  await execFileAsync(
    'ffmpeg',
    [
      '-i',
      inputPath,
      '-f',
      'wav',
      '-ar',
      '16000',
      '-ac',
      '1',
      '-y',
      outputPath,
    ],
    { timeout: FFMPEG_TIMEOUT },
  );

  return outputPath;
}

// ---------------------------------------------------------------------------
// STT via Parakeet sidecar
// ---------------------------------------------------------------------------

async function transcribeViaSTT(wavPath: string): Promise<string> {
  const audioBytes = fs.readFileSync(wavPath);
  const formData = new FormData();
  const blob = new Blob([audioBytes], { type: 'audio/wav' });
  formData.append('file', blob, 'audio.wav');

  const response = await fetch(`${STT_BASE_URL}/transcribe`, {
    method: 'POST',
    body: formData,
    signal: AbortSignal.timeout(STT_TIMEOUT),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`STT service error: HTTP ${response.status} — ${detail}`);
  }

  const data = (await response.json()) as { text?: string };
  const text = (data.text ?? '').trim();

  if (!text) {
    throw new Error('STT returned empty transcription');
  }

  return text;
}

async function isSTTAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${STT_BASE_URL}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function transcribeMedia(
  source: string,
  lang?: string,
): Promise<TranscriptResult> {
  // --- YouTube path ---
  if (isYouTubeUrl(source) || extractYouTubeId(source)) {
    const videoId = extractYouTubeId(source);
    if (!videoId) {
      throw new Error(`Could not extract YouTube video ID from: ${source}`);
    }

    const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // 1. Try captions via library (fastest, no binary needed)
    const captions = await fetchCaptionsViaLib(youtubeUrl, lang);
    if (captions) return captions;

    // 2. Try auto-subs via yt-dlp
    const subs = await fetchSubsViaYtDlp(videoId, lang);
    if (subs) return subs;

    // 3. Download audio + STT
    const sttAvailable = await isSTTAvailable();
    if (!sttAvailable) {
      throw new Error(
        'No captions available for this video and the speech-to-text service is not running. ' +
          'Start it with: docker compose --profile stt up',
      );
    }

    const tmpDir = makeTmpDir();
    try {
      const wavPath = await downloadAudioViaYtDlp(youtubeUrl, tmpDir);
      const text = await transcribeViaSTT(wavPath);
      return { text, method: 'stt' };
    } finally {
      cleanupTmpDir(tmpDir);
    }
  }

  // --- Remote URL path ---
  if (/^https?:\/\//i.test(source)) {
    const sttAvailable = await isSTTAvailable();
    if (!sttAvailable) {
      throw new Error(
        'Speech-to-text service is not running. Start it with: docker compose --profile stt up',
      );
    }

    const tmpDir = makeTmpDir();
    try {
      const filePath = await downloadRemoteFile(source, tmpDir);
      const wavPath = await convertToWav(filePath, tmpDir);
      const text = await transcribeViaSTT(wavPath);
      return { text, method: 'stt' };
    } finally {
      cleanupTmpDir(tmpDir);
    }
  }

  // --- Local file path ---
  if (!fs.existsSync(source)) {
    throw new Error(`File not found: ${source}`);
  }

  const sttAvailable = await isSTTAvailable();
  if (!sttAvailable) {
    throw new Error(
      'Speech-to-text service is not running. Start it with: docker compose --profile stt up',
    );
  }

  const tmpDir = makeTmpDir();
  try {
    const wavPath = await convertToWav(source, tmpDir);
    const text = await transcribeViaSTT(wavPath);
    return { text, method: 'stt' };
  } finally {
    cleanupTmpDir(tmpDir);
  }
}
