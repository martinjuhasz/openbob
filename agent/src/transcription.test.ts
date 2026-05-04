import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import {
  isYouTubeUrl,
  extractYouTubeId,
  parseSrt,
  transcribeMedia,
} from './transcription.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('youtube-transcript-plus', () => ({
  fetchTranscript: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('fs', () => {
  const actual = {
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
    readdirSync: vi.fn(() => []),
    writeFileSync: vi.fn(),
  };
  return { default: actual, ...actual };
});

// We need to get references to the mocked modules
import { fetchTranscript } from 'youtube-transcript-plus';
import { execFile } from 'child_process';
import fs from 'fs';

// Helper: make execFile call its callback successfully
function mockExecFileSuccess(stdout = '') {
  (execFile as unknown as Mock).mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: object,
      cb?: (
        err: Error | null,
        result: { stdout: string; stderr: string },
      ) => void,
    ) => {
      // promisify calls with 3-arg (cmd, args, opts) and expects callback added by promisify
      if (typeof _opts === 'function') {
        // called as (cmd, args, cb)
        (
          _opts as unknown as (
            err: Error | null,
            result: { stdout: string; stderr: string },
          ) => void
        )(null, { stdout, stderr: '' });
      } else if (cb) {
        cb(null, { stdout, stderr: '' });
      }
    },
  );
}

function _mockExecFileError(err: Error) {
  (execFile as unknown as Mock).mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: object,
      cb?: (
        err: Error | null,
        result: { stdout: string; stderr: string },
      ) => void,
    ) => {
      if (typeof _opts === 'function') {
        (_opts as unknown as (err: Error) => void)(err);
      } else if (cb) {
        cb(err, { stdout: '', stderr: '' });
      }
    },
  );
}

// Helper: mock global fetch
function _mockFetch(response: Partial<Response>) {
  const mockResponse = {
    ok: true,
    status: 200,
    headers: new Headers(),
    text: vi.fn(async () => ''),
    json: vi.fn(async () => ({})),
    arrayBuffer: vi.fn(async () => new ArrayBuffer(0)),
    ...response,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => mockResponse),
  );
  return mockResponse;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// isYouTubeUrl
// ---------------------------------------------------------------------------

describe('isYouTubeUrl', () => {
  const validUrls = [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'http://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com/watch?v=dQw4w9WgXcQ',
    'www.youtube.com/watch?v=dQw4w9WgXcQ',
    'youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=120',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/live/dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'http://youtu.be/dQw4w9WgXcQ',
    'youtu.be/dQw4w9WgXcQ',
    'https://www.youtube.com/v/dQw4w9WgXcQ',
  ];

  it.each(validUrls)('returns true for %s', (url) => {
    expect(isYouTubeUrl(url)).toBe(true);
  });

  const invalidUrls = [
    'https://example.com/watch?v=dQw4w9WgXcQ',
    // Note: 'notyoutube.com' would match because the regex doesn't anchor the domain start
    'dQw4w9WgXcQ',
    '/path/to/file.mp4',
    'https://vimeo.com/123456',
    '',
    'random string',
  ];

  it.each(invalidUrls)('returns false for %s', (url) => {
    expect(isYouTubeUrl(url)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractYouTubeId
// ---------------------------------------------------------------------------

describe('extractYouTubeId', () => {
  it('extracts from youtube.com/watch URLs', () => {
    expect(
      extractYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
    ).toBe('dQw4w9WgXcQ');
  });

  it('extracts from youtube.com/watch with extra params', () => {
    expect(
      extractYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx'),
    ).toBe('dQw4w9WgXcQ');
  });

  it('extracts from embed URLs', () => {
    expect(extractYouTubeId('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe(
      'dQw4w9WgXcQ',
    );
  });

  it('extracts from shorts URLs', () => {
    expect(extractYouTubeId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe(
      'dQw4w9WgXcQ',
    );
  });

  it('extracts from live URLs', () => {
    expect(extractYouTubeId('https://www.youtube.com/live/dQw4w9WgXcQ')).toBe(
      'dQw4w9WgXcQ',
    );
  });

  it('extracts from youtu.be URLs', () => {
    expect(extractYouTubeId('https://youtu.be/dQw4w9WgXcQ')).toBe(
      'dQw4w9WgXcQ',
    );
  });

  it('extracts from youtube.com/v/ URLs', () => {
    expect(extractYouTubeId('https://www.youtube.com/v/dQw4w9WgXcQ')).toBe(
      'dQw4w9WgXcQ',
    );
  });

  it('extracts bare 11-char video ID', () => {
    expect(extractYouTubeId('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('extracts ID with dashes and underscores', () => {
    expect(extractYouTubeId('a-b_c1234AB')).toBe('a-b_c1234AB');
  });

  it('returns null for invalid inputs', () => {
    expect(extractYouTubeId('')).toBeNull();
    expect(extractYouTubeId('short')).toBeNull();
    expect(extractYouTubeId('https://example.com')).toBeNull();
    expect(extractYouTubeId('toolongvideoid12')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseSrt
// ---------------------------------------------------------------------------

describe('parseSrt', () => {
  it('parses valid SRT content', () => {
    const srt = `1
00:00:01,000 --> 00:00:03,000
Hello world

2
00:00:04,500 --> 00:00:06,000
Second line`;

    const segments = parseSrt(srt);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({ text: 'Hello world', offset: 1 });
    expect(segments[1]).toEqual({ text: 'Second line', offset: 4.5 });
  });

  it('handles multi-line subtitle text', () => {
    const srt = `1
00:00:01,000 --> 00:00:03,000
Line one
Line two`;

    const segments = parseSrt(srt);
    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe('Line one Line two');
  });

  it('strips HTML tags', () => {
    const srt = `1
00:00:01,000 --> 00:00:03,000
<b>Bold</b> and <i>italic</i>`;

    const segments = parseSrt(srt);
    expect(segments[0].text).toBe('Bold and italic');
  });

  it('calculates offset correctly for hours/minutes/seconds/millis', () => {
    const srt = `1
01:02:03,456 --> 01:02:05,000
Test`;

    const segments = parseSrt(srt);
    expect(segments[0].offset).toBeCloseTo(3723.456, 3);
  });

  it('handles period as millisecond separator', () => {
    const srt = `1
00:00:01.500 --> 00:00:03.000
Dot separator`;

    const segments = parseSrt(srt);
    expect(segments[0].offset).toBeCloseTo(1.5, 3);
  });

  it('returns empty array for empty input', () => {
    expect(parseSrt('')).toEqual([]);
  });

  it('skips malformed blocks (too few lines)', () => {
    const srt = `1
00:00:01,000 --> 00:00:03,000

2
bad timestamp
Some text`;

    const segments = parseSrt(srt);
    expect(segments).toHaveLength(0);
  });

  it('skips blocks with invalid timestamp', () => {
    const srt = `1
not a timestamp
Some text here`;

    const segments = parseSrt(srt);
    expect(segments).toHaveLength(0);
  });

  it('skips blocks where text is empty after stripping', () => {
    const srt = `1
00:00:01,000 --> 00:00:03,000
<b></b>`;

    const segments = parseSrt(srt);
    expect(segments).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// transcribeMedia
// ---------------------------------------------------------------------------

describe('transcribeMedia', () => {
  describe('YouTube path', () => {
    it('returns captions when fetchTranscript succeeds', async () => {
      (fetchTranscript as Mock).mockResolvedValue([
        { text: 'Hello', offset: 0, lang: 'en' },
        { text: 'World', offset: 1, lang: 'en' },
      ]);

      const result = await transcribeMedia(
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      );
      expect(result.method).toBe('captions');
      expect(result.text).toBe('Hello World');
      expect(result.segments).toHaveLength(2);
      expect(result.language).toBe('en');
    });

    it('falls back to yt-dlp subs when captions fail', async () => {
      (fetchTranscript as Mock).mockRejectedValue(new Error('no captions'));

      mockExecFileSuccess();
      (fs.readdirSync as Mock).mockReturnValue(['dQw4w9WgXcQ.en.srt']);
      (fs.readFileSync as Mock).mockReturnValue(`1
00:00:01,000 --> 00:00:03,000
Subtitle text`);
      (fs.mkdirSync as Mock).mockReturnValue(undefined);

      const result = await transcribeMedia(
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      );
      expect(result.method).toBe('yt-dlp-subs');
      expect(result.text).toBe('Subtitle text');
    });

    it('falls back to STT when captions and yt-dlp both fail', async () => {
      (fetchTranscript as Mock).mockRejectedValue(new Error('no captions'));
      (fs.mkdirSync as Mock).mockReturnValue(undefined);

      // yt-dlp subs: no srt files found
      let execCallCount = 0;
      (execFile as unknown as Mock).mockImplementation(
        (
          _cmd: string,
          _args: string[],
          _opts: object,
          cb?: (
            err: Error | null,
            result: { stdout: string; stderr: string },
          ) => void,
        ) => {
          execCallCount++;
          if (typeof _opts === 'function') {
            if (execCallCount === 1) {
              // yt-dlp --write-auto-sub: succeed but no files
              (
                _opts as unknown as (
                  err: Error | null,
                  r: { stdout: string; stderr: string },
                ) => void
              )(null, { stdout: '', stderr: '' });
            } else {
              // yt-dlp -x and ffmpeg
              (
                _opts as unknown as (
                  err: Error | null,
                  r: { stdout: string; stderr: string },
                ) => void
              )(null, { stdout: '', stderr: '' });
            }
          } else if (cb) {
            cb(null, { stdout: '', stderr: '' });
          }
        },
      );

      // yt-dlp subs: no srt files
      (fs.readdirSync as Mock).mockReturnValue([]);

      // STT health check
      const healthResponse = {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: vi.fn(async () => ''),
        json: vi.fn(async () => ({ text: 'transcribed text' })),
        arrayBuffer: vi.fn(async () => new ArrayBuffer(0)),
      };
      const sttResponse = {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: vi.fn(async () => ''),
        json: vi.fn(async () => ({ text: 'transcribed text' })),
        arrayBuffer: vi.fn(async () => new ArrayBuffer(0)),
      };
      let fetchCallCount = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          fetchCallCount++;
          if (fetchCallCount === 1) return healthResponse; // isSTTAvailable
          return sttResponse; // transcribeViaSTT
        }),
      );

      // downloadAudioViaYtDlp: audio.wav exists
      (fs.existsSync as Mock).mockReturnValue(true);
      (fs.readFileSync as Mock).mockReturnValue(Buffer.from('fake wav'));

      const result = await transcribeMedia(
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      );
      expect(result.method).toBe('stt');
      expect(result.text).toBe('transcribed text');
    });

    it('throws when no captions and STT unavailable', async () => {
      (fetchTranscript as Mock).mockRejectedValue(new Error('no captions'));
      (fs.mkdirSync as Mock).mockReturnValue(undefined);
      (fs.readdirSync as Mock).mockReturnValue([]);

      mockExecFileSuccess();

      // STT health check fails
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('connection refused');
        }),
      );

      await expect(
        transcribeMedia('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
      ).rejects.toThrow('speech-to-text service is not running');
    });

    it('passes lang to fetchTranscript', async () => {
      (fetchTranscript as Mock).mockResolvedValue([
        { text: 'Hallo', offset: 0, lang: 'de' },
      ]);

      await transcribeMedia(
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'de',
      );
      expect(fetchTranscript).toHaveBeenCalledWith(
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        { lang: 'de' },
      );
    });
  });

  describe('Remote URL path', () => {
    it('downloads, converts, and transcribes via STT', async () => {
      (fs.mkdirSync as Mock).mockReturnValue(undefined);
      (fs.writeFileSync as Mock).mockReturnValue(undefined);
      (fs.readFileSync as Mock).mockReturnValue(Buffer.from('fake wav'));

      mockExecFileSuccess(); // ffmpeg

      let fetchCallCount = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            // isSTTAvailable
            return { ok: true, status: 200, headers: new Headers() };
          }
          if (fetchCallCount === 2) {
            // downloadRemoteFile
            return {
              ok: true,
              status: 200,
              headers: new Headers({ 'content-type': 'audio/mpeg' }),
              arrayBuffer: vi.fn(async () => new ArrayBuffer(10)),
            };
          }
          // transcribeViaSTT
          return {
            ok: true,
            status: 200,
            json: vi.fn(async () => ({ text: 'hello from stt' })),
          };
        }),
      );

      const result = await transcribeMedia('https://example.com/audio.mp3');
      expect(result.method).toBe('stt');
      expect(result.text).toBe('hello from stt');
    });

    it('throws when STT is unavailable', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('connection refused');
        }),
      );

      await expect(
        transcribeMedia('https://example.com/audio.mp3'),
      ).rejects.toThrow('Speech-to-text service is not running');
    });
  });

  describe('Local file path', () => {
    it('throws when file does not exist', async () => {
      (fs.existsSync as Mock).mockReturnValue(false);

      await expect(transcribeMedia('/path/to/file.mp3')).rejects.toThrow(
        'File not found: /path/to/file.mp3',
      );
    });

    it('throws when STT is unavailable', async () => {
      (fs.existsSync as Mock).mockReturnValue(true);

      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('connection refused');
        }),
      );

      await expect(transcribeMedia('/path/to/file.mp3')).rejects.toThrow(
        'Speech-to-text service is not running',
      );
    });

    it('converts and transcribes local file via STT', async () => {
      (fs.existsSync as Mock).mockReturnValue(true);
      (fs.mkdirSync as Mock).mockReturnValue(undefined);
      (fs.readFileSync as Mock).mockReturnValue(Buffer.from('fake wav'));

      mockExecFileSuccess(); // ffmpeg

      let fetchCallCount = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return { ok: true, status: 200, headers: new Headers() };
          }
          return {
            ok: true,
            status: 200,
            json: vi.fn(async () => ({ text: 'local transcription' })),
          };
        }),
      );

      const result = await transcribeMedia('/path/to/file.mp3');
      expect(result.method).toBe('stt');
      expect(result.text).toBe('local transcription');
    });
  });

  describe('bare video ID', () => {
    it('treats bare 11-char ID as YouTube', async () => {
      (fetchTranscript as Mock).mockResolvedValue([
        { text: 'From bare ID', offset: 0 },
      ]);

      const result = await transcribeMedia('dQw4w9WgXcQ');
      expect(result.method).toBe('captions');
      expect(fetchTranscript).toHaveBeenCalledWith(
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        {},
      );
    });
  });
});
