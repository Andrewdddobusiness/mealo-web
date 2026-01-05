import {
  AiConfigError,
  AiProviderError,
  AiTimeoutError,
  AiValidationError,
  type GeneratedMeal,
  extractJsonObject,
  validateGeneratedMeal,
} from './generateMeal';

type GeminiGenerateResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
  error?: { message?: string };
};

export type ImportVideoMealInput = {
  url: string;
  maxIngredients?: number;
  maxRecipes?: number;
};

export type ImportVideoMealMode = 'caption' | 'caption+thumbnail' | 'video';

type ExtractedFrom =
  | 'direct_video_url'
  | 'og_video_meta'
  | 'twitter_stream_meta'
  | 'html_video_tag'
  | 'html_mp4_url'
  | 'tiktok_sigi_state'
  | 'instagram_json'
  | 'tiktok_embed_html'
  | 'instagram_embed_html'
  | 'instagram_oembed_title'
  | 'tiktok_oembed_title'
  | 'instagram_oembed_thumbnail'
  | 'tiktok_oembed_thumbnail';

type ImportSource =
  | {
      mode: 'caption' | 'caption+thumbnail';
      platform: 'tiktok' | 'instagram' | 'other';
      sourceUrl: string;
      extractedFrom: ExtractedFrom[];
      caption: string;
      thumbnailUrl?: string;
    }
  | {
      mode: 'video';
      platform: 'tiktok' | 'instagram' | 'other';
      sourceUrl: string;
      extractedFrom: ExtractedFrom[];
      videoUrl: string;
      videoBase64: string;
      videoMimeType: string;
    };

const DEFAULT_GEMINI_MODEL = 'gemini-1.5-flash';
const DEFAULT_MAX_INGREDIENTS = 12;
const DEFAULT_MAX_RECIPES = 3;

const MAX_URL_LENGTH = 2048;
const MAX_VIDEO_BYTES = Number.parseInt(process.env.AI_IMPORT_VIDEO_MAX_BYTES || '', 10) || 18 * 1024 * 1024; // 18MB
const MAX_HTML_BYTES = 800_000;
const MAX_OEMBED_BYTES = 350_000;
const MAX_CAPTION_CHARS = 18_000;
const DEBUG_IMPORT_VIDEO = process.env.AI_IMPORT_VIDEO_DEBUG === '1' || process.env.NODE_ENV !== 'production';

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function safeTrim(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = normalizeWhitespace(value);
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLen);
}

function clampMaxIngredients(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_INGREDIENTS;
  const rounded = Math.round(value);
  if (rounded < 1) return 1;
  if (rounded > 30) return 30;
  return rounded;
}

function clampMaxRecipes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_RECIPES;
  const rounded = Math.round(value);
  if (rounded < 1) return 1;
  if (rounded > 5) return 5;
  return rounded;
}

function guessPlatform(url: string): ImportSource['platform'] {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host.includes('tiktok.com')) return 'tiktok';
    if (host.includes('instagram.com')) return 'instagram';
  } catch {
    // ignore
  }
  return 'other';
}

function extractTextFromGemini(json: GeminiGenerateResponse): string {
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('').trim();
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error: any) {
    if (error?.name === 'AbortError') throw new AiTimeoutError('Request timed out.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

type MetaTag = Record<string, string>;

function parseMetaTags(html: string): MetaTag[] {
  const tags: MetaTag[] = [];
  const metaRegex = /<meta\b[^>]*>/gi;
  const attrRegex = /([a-zA-Z_:.-]+)\s*=\s*(["'])(.*?)\2/g;

  let metaMatch: RegExpExecArray | null;
  while ((metaMatch = metaRegex.exec(html))) {
    const tag = metaMatch[0];
    const attrs: MetaTag = {};
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRegex.exec(tag))) {
      const key = attrMatch[1]?.toLowerCase();
      const value = attrMatch[3] ?? '';
      if (key) attrs[key] = value;
    }
    if (Object.keys(attrs).length) tags.push(attrs);
  }
  return tags;
}

function findMetaContent(html: string, key: string, value: string): string | undefined {
  const keyLower = key.toLowerCase();
  const valueLower = value.toLowerCase();
  for (const attrs of parseMetaTags(html)) {
    const actual = (attrs[keyLower] ?? '').toLowerCase();
    if (actual !== valueLower) continue;
    const content = attrs['content'];
    if (typeof content === 'string' && content.trim()) return content.trim();
  }
  return undefined;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function isLikelyMp4Url(url: string): boolean {
  return /\.mp4(?:$|[?#])/i.test(url);
}

function decodePossibleEscapes(value: string): string {
  const trimmed = value.trim().replace(/^["']|["']$/g, '');
  let out = decodeHtmlEntities(trimmed);
  out = out
    .replace(/\\\\u0026/g, '&')
    .replace(/\\u0026/g, '&')
    .replace(/\\\\u003d/g, '=')
    .replace(/\\u003d/g, '=')
    .replace(/\\\\u002f/gi, '/')
    .replace(/\\u002f/gi, '/')
    .replace(/\\\\\//g, '/')
    .replace(/\\\//g, '/');
  return out;
}

function extractUrlsFromText(text: string): string[] {
  const out: string[] = [];
  const urlRegex = /https?:\/\/[^\s"'<>\\]+/gi;
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(text))) {
    const raw = match[0];
    if (!raw) continue;
    out.push(raw);
    if (out.length >= 25) break;
  }
  return out;
}

function extractVideoUrlFromVideoTags(html: string, baseUrl: string): string | null {
  const tagRegex = /<(video|source)\b[^>]*\bsrc=(["'])(.*?)\2[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(html))) {
    const rawSrc = match[3];
    if (!rawSrc) continue;
    const decoded = decodePossibleEscapes(rawSrc);
    try {
      const resolved = new URL(decoded, baseUrl).toString();
      if (isLikelyMp4Url(resolved)) return resolved;
    } catch {
      // ignore
    }
  }
  return null;
}

function extractVideoUrlFromEmbeddedJson(
  html: string,
  baseUrl: string,
): { url: string; extractedFrom: ExtractedFrom } | null {
  const patterns: Array<{ regex: RegExp; extractedFrom: ExtractedFrom }> = [
    { regex: /"playAddr"\s*:\s*"([^"]+)"/gi, extractedFrom: 'tiktok_sigi_state' },
    { regex: /"downloadAddr"\s*:\s*"([^"]+)"/gi, extractedFrom: 'tiktok_sigi_state' },
    { regex: /"playUrl"\s*:\s*"([^"]+)"/gi, extractedFrom: 'tiktok_sigi_state' },
    { regex: /"video_url"\s*:\s*"([^"]+)"/gi, extractedFrom: 'instagram_json' },
    { regex: /"videoUrl"\s*:\s*"([^"]+)"/gi, extractedFrom: 'instagram_json' },
    { regex: /"contentUrl"\s*:\s*"([^"]+)"/gi, extractedFrom: 'instagram_json' },
  ];

  for (const { regex, extractedFrom } of patterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(html))) {
      const raw = match[1];
      if (!raw) continue;
      const decoded = decodePossibleEscapes(raw);
      try {
        const resolved = new URL(decoded, baseUrl).toString();
        if (!resolved.startsWith('http')) continue;
        if (!isLikelyMp4Url(resolved)) continue;
        return { url: resolved, extractedFrom };
      } catch {
        // ignore
      }
    }
  }

  return null;
}

export function validateImportVideoMealInput(input: ImportVideoMealInput): ImportVideoMealInput {
  const urlRaw = safeTrim(input.url, MAX_URL_LENGTH);
  if (!urlRaw) throw new AiValidationError('Missing required field: url');

  // Basic URL sanity; still allow unknown hosts.
  try {
    const parsed = new URL(urlRaw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new AiValidationError('URL must start with http:// or https://');
    }
  } catch (error) {
    if (error instanceof AiValidationError) throw error;
    throw new AiValidationError('Invalid URL.');
  }

  const maxIngredients = clampMaxIngredients(input.maxIngredients);
  const maxRecipes = clampMaxRecipes(input.maxRecipes);

  return {
    url: urlRaw,
    maxIngredients,
    maxRecipes,
  };
}

async function readBodyToBufferWithLimit(res: Response, maxBytes: number, label: string): Promise<Buffer> {
  const stream = res.body;
  if (!stream) return Buffer.alloc(0);

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      throw new AiValidationError(
        `${label} is too large. Please use a shorter video (max ${Math.round(maxBytes / 1024 / 1024)}MB).`,
      );
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

function normalizeContentType(value: string | null): string {
  const raw = (value ?? '').trim().toLowerCase();
  if (!raw) return '';
  return raw.split(';')[0]?.trim() || '';
}

function sanitizeUrlForLog(input: string): { url: string; queryKeys: string[] } {
  try {
    const parsed = new URL(input);
    const queryKeys = Array.from(new Set(Array.from(parsed.searchParams.keys()))).slice(0, 20);
    return { url: `${parsed.origin}${parsed.pathname}`, queryKeys };
  } catch {
    return { url: input.slice(0, 200), queryKeys: [] };
  }
}

function normalizeCaptionText(value: string): string {
  const normalizedNewlines = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalizedNewlines
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd());

  while (lines.length > 0 && !lines[0]?.trim()) lines.shift();
  while (lines.length > 0 && !lines[lines.length - 1]?.trim()) lines.pop();

  const outLines: string[] = [];
  let emptyRun = 0;
  for (const line of lines) {
    if (!line.trim()) {
      emptyRun += 1;
      if (emptyRun <= 1) outLines.push('');
      continue;
    }
    emptyRun = 0;
    outLines.push(line);
  }

  const joined = outLines.join('\n').trim();
  return joined.slice(0, MAX_CAPTION_CHARS);
}

async function fetchCaptionFromOEmbed(
  sourceUrl: string,
  platform: ImportSource['platform'],
  debug?: (event: string, meta?: Record<string, unknown>) => void,
): Promise<{ caption: string; thumbnailUrl?: string; extractedFrom: ExtractedFrom[] } | null> {
  let endpoint: string | null = null;
  let titleTag: ExtractedFrom | null = null;

  if (platform === 'instagram') {
    endpoint = `https://i.instagram.com/api/v1/oembed/?url=${encodeURIComponent(sourceUrl)}`;
    titleTag = 'instagram_oembed_title';
  } else if (platform === 'tiktok') {
    endpoint = `https://www.tiktok.com/oembed?url=${encodeURIComponent(sourceUrl)}`;
    titleTag = 'tiktok_oembed_title';
  }

  if (!endpoint || !titleTag) return null;

  const headers = {
    'user-agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
  } satisfies Record<string, string>;

  debug?.('oembed.fetch.start', { platform, url: sanitizeUrlForLog(sourceUrl) });

  let res: Response;
  try {
    res = await fetchWithTimeout(endpoint, { method: 'GET', redirect: 'follow', headers }, 12_000);
  } catch (error) {
    debug?.('oembed.fetch.error', {
      platform,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const contentType = normalizeContentType(res.headers.get('content-type'));
  debug?.('oembed.fetch.ok', {
    platform,
    status: res.status,
    contentType,
    finalUrl: sanitizeUrlForLog(res.url),
  });

  if (!res.ok) return null;

  let bytes: Buffer;
  try {
    bytes = await readBodyToBufferWithLimit(res, MAX_OEMBED_BYTES, 'oEmbed response');
  } catch (error) {
    debug?.('oembed.read.error', {
      platform,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    debug?.('oembed.parse.error', { platform, bytes: bytes.length, contentType });
    return null;
  }

  const captionRaw = typeof parsed?.title === 'string' ? parsed.title : '';
  const caption = normalizeCaptionText(captionRaw);
  const thumbnailUrl = typeof parsed?.thumbnail_url === 'string' ? parsed.thumbnail_url.trim() : '';

  debug?.('oembed.parsed', {
    platform,
    captionLength: caption.length,
    hasThumbnail: Boolean(thumbnailUrl),
  });

  if (!caption) return null;

  return {
    caption,
    thumbnailUrl: thumbnailUrl || undefined,
    extractedFrom: [titleTag],
  };
}

function extractVideoUrlFromHtml(html: string, baseUrl: string): { url: string; extractedFrom: ExtractedFrom } | null {
  const ogVideo =
    findMetaContent(html, 'property', 'og:video') ||
    findMetaContent(html, 'property', 'og:video:url') ||
    findMetaContent(html, 'property', 'og:video:secure_url');
  if (ogVideo) {
    const decoded = decodeHtmlEntities(ogVideo.trim());
    try {
      return { url: new URL(decoded, baseUrl).toString(), extractedFrom: 'og_video_meta' };
    } catch {
      // ignore
    }
  }

  const twitterStream =
    findMetaContent(html, 'name', 'twitter:player:stream') ||
    findMetaContent(html, 'name', 'twitter:player:stream:url');
  if (twitterStream) {
    const decoded = decodeHtmlEntities(twitterStream.trim());
    try {
      return { url: new URL(decoded, baseUrl).toString(), extractedFrom: 'twitter_stream_meta' };
    } catch {
      // ignore
    }
  }

  const tagSrc = extractVideoUrlFromVideoTags(html, baseUrl);
  if (tagSrc) return { url: tagSrc, extractedFrom: 'html_video_tag' };

  const embedded = extractVideoUrlFromEmbeddedJson(html, baseUrl);
  if (embedded) return embedded;

  for (const rawUrl of extractUrlsFromText(html)) {
    const decoded = decodePossibleEscapes(rawUrl);
    try {
      const resolved = new URL(decoded, baseUrl).toString();
      if (!isLikelyMp4Url(resolved)) continue;
      return { url: resolved, extractedFrom: 'html_mp4_url' };
    } catch {
      // ignore
    }
  }

  return null;
}

function extractTikTokVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const idx = parts.findIndex((p) => p === 'video');
    if (idx >= 0 && parts[idx + 1] && /^\d{8,}$/.test(parts[idx + 1])) return parts[idx + 1];
  } catch {
    // ignore
  }
  return null;
}

function extractInstagramShortcode(url: string): string | null {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const idx = parts.findIndex((p) => p === 'reel' || p === 'p');
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
  } catch {
    // ignore
  }
  return null;
}

async function resolveVideoFromUrl(
  url: string,
  debug?: (event: string, meta?: Record<string, unknown>) => void,
): Promise<{
  videoUrl: string;
  extractedFrom: ExtractedFrom[];
  videoBase64: string;
  videoMimeType: string;
}> {
  return resolveVideoFromUrlWithDebug(url, debug);
}

function makeImportVideoLogger(
  requestId?: string,
): ((event: string, meta?: Record<string, unknown>) => void) | undefined {
  if (!DEBUG_IMPORT_VIDEO) return undefined;
  return (event, meta) => {
    const prefix = requestId ? `[AI_IMPORT_VIDEO ${requestId}]` : '[AI_IMPORT_VIDEO]';
    if (meta && Object.keys(meta).length > 0) console.log(prefix, event, meta);
    else console.log(prefix, event);
  };
}

async function resolveVideoFromUrlWithDebug(
  url: string,
  debug?: (event: string, meta?: Record<string, unknown>) => void,
): Promise<{
  videoUrl: string;
  extractedFrom: ExtractedFrom[];
  videoBase64: string;
  videoMimeType: string;
}> {
  const headers = {
    // Best-effort: some platforms block unknown UAs.
    'user-agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    accept: 'video/*,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
  } satisfies Record<string, string>;

  const first = await fetchWithTimeout(
    url,
    {
      method: 'GET',
      redirect: 'follow',
      headers,
    },
    12_000,
  );

  if (!first.ok) {
    debug?.('fetch.first.error', { url: sanitizeUrlForLog(url), status: first.status });
    throw new AiValidationError(`Could not access that link (HTTP ${first.status}).`);
  }

  const contentType = normalizeContentType(first.headers.get('content-type'));
  debug?.('fetch.first.ok', {
    url: sanitizeUrlForLog(url),
    finalUrl: sanitizeUrlForLog(first.url),
    status: first.status,
    contentType,
    contentLength: first.headers.get('content-length'),
  });
  if (contentType.startsWith('video/')) {
    const bytes = await readBodyToBufferWithLimit(first, MAX_VIDEO_BYTES, 'Video');
    debug?.('video.direct', { bytes: bytes.length, contentType, finalUrl: sanitizeUrlForLog(first.url) });
    return {
      videoUrl: first.url,
      extractedFrom: ['direct_video_url'],
      videoBase64: bytes.toString('base64'),
      videoMimeType: contentType || 'video/mp4',
    };
  }

  if (contentType === 'application/octet-stream' && isLikelyMp4Url(first.url)) {
    const bytes = await readBodyToBufferWithLimit(first, MAX_VIDEO_BYTES, 'Video');
    debug?.('video.direct.octet', { bytes: bytes.length, finalUrl: sanitizeUrlForLog(first.url) });
    return {
      videoUrl: first.url,
      extractedFrom: ['direct_video_url'],
      videoBase64: bytes.toString('base64'),
      videoMimeType: 'video/mp4',
    };
  }

  if (contentType.includes('text/html') || contentType === '' || contentType === 'application/octet-stream') {
    const htmlBytes = await readBodyToBufferWithLimit(first, MAX_HTML_BYTES, 'Page content');
    const html = htmlBytes.toString('utf8');
    const extractedFrom: ExtractedFrom[] = [];
    let extracted = extractVideoUrlFromHtml(html, first.url);

    debug?.('html.fetched', {
      finalUrl: sanitizeUrlForLog(first.url),
      bytes: htmlBytes.length,
      contentType,
      probes: {
        hasOgVideo: html.includes('og:video'),
        hasSigiState: html.includes('SIGI_STATE') || html.includes('sigiState'),
        hasNextData: html.includes('__NEXT_DATA__'),
        hasCaptcha: /captcha/i.test(html),
        hasLogin: /log in|login/i.test(html),
      },
    });

    if (!extracted) {
      const platform = guessPlatform(first.url || url);
      debug?.('html.no_direct_video', { platform, finalUrl: sanitizeUrlForLog(first.url || url) });
      const embedAttempts: Array<{ url: string; tag: ExtractedFrom }> = [];

      if (platform === 'tiktok') {
        const videoId = extractTikTokVideoId(first.url || url);
        if (videoId) {
          embedAttempts.push({
            url: `https://www.tiktok.com/embed/v2/${encodeURIComponent(videoId)}`,
            tag: 'tiktok_embed_html',
          });
        }
      }

      if (platform === 'instagram') {
        const shortcode = extractInstagramShortcode(first.url || url);
        if (shortcode) {
          embedAttempts.push({
            url: `https://www.instagram.com/reel/${encodeURIComponent(shortcode)}/embed/captioned/`,
            tag: 'instagram_embed_html',
          });
          embedAttempts.push({
            url: `https://www.instagram.com/p/${encodeURIComponent(shortcode)}/embed/captioned/`,
            tag: 'instagram_embed_html',
          });
        }
      }

      for (const attempt of embedAttempts) {
        try {
          debug?.('embed.fetch.start', { url: sanitizeUrlForLog(attempt.url), tag: attempt.tag });
          const embedRes = await fetchWithTimeout(
            attempt.url,
            { method: 'GET', redirect: 'follow', headers },
            12_000,
          );
          if (!embedRes.ok) {
            debug?.('embed.fetch.error', {
              url: sanitizeUrlForLog(attempt.url),
              finalUrl: sanitizeUrlForLog(embedRes.url),
              status: embedRes.status,
              contentType: normalizeContentType(embedRes.headers.get('content-type')),
            });
            continue;
          }

          const embedType = normalizeContentType(embedRes.headers.get('content-type'));
          debug?.('embed.fetch.ok', {
            url: sanitizeUrlForLog(attempt.url),
            finalUrl: sanitizeUrlForLog(embedRes.url),
            status: embedRes.status,
            contentType: embedType,
          });
          if (!embedType.includes('text/html') && embedType !== '') {
            debug?.('embed.fetch.skip', { reason: 'non_html', contentType: embedType, finalUrl: sanitizeUrlForLog(embedRes.url) });
            continue;
          }

          const embedHtmlBytes = await readBodyToBufferWithLimit(embedRes, MAX_HTML_BYTES, 'Embed content');
          const embedHtml = embedHtmlBytes.toString('utf8');
          const embedExtracted = extractVideoUrlFromHtml(embedHtml, embedRes.url);
          if (!embedExtracted) {
            debug?.('embed.extracted.none', {
              tag: attempt.tag,
              finalUrl: sanitizeUrlForLog(embedRes.url),
              bytes: embedHtmlBytes.length,
              probes: {
                hasOgVideo: embedHtml.includes('og:video'),
                hasVideoTag: /<video\b/i.test(embedHtml) || /<source\b/i.test(embedHtml),
                hasMp4: /\.mp4(?:$|[?#])/i.test(embedHtml),
                hasEmbedJs: embedHtml.includes('instagram.com/embed.js'),
                hasCaptcha: /captcha/i.test(embedHtml),
                hasLogin: /log in|login/i.test(embedHtml),
              },
            });
            continue;
          }

          debug?.('embed.extracted', {
            tag: attempt.tag,
            extractedFrom: embedExtracted.extractedFrom,
            videoUrl: sanitizeUrlForLog(embedExtracted.url),
          });

          const videoRes = await fetchWithTimeout(
            embedExtracted.url,
            { method: 'GET', redirect: 'follow', headers },
            12_000,
          );
          if (!videoRes.ok) continue;

          const videoType = normalizeContentType(videoRes.headers.get('content-type'));
          const isOctetMp4 = videoType === 'application/octet-stream' && isLikelyMp4Url(videoRes.url);
          debug?.('embed.video.fetch.ok', {
            status: videoRes.status,
            contentType: videoType,
            finalUrl: sanitizeUrlForLog(videoRes.url),
          });
          if (!videoType.startsWith('video/') && !isOctetMp4) continue;

          const bytes = await readBodyToBufferWithLimit(videoRes, MAX_VIDEO_BYTES, 'Video');
          debug?.('embed.video.bytes', { bytes: bytes.length, contentType: videoType, finalUrl: sanitizeUrlForLog(videoRes.url) });
          return {
            videoUrl: videoRes.url,
            extractedFrom: [attempt.tag, embedExtracted.extractedFrom],
            videoBase64: bytes.toString('base64'),
            videoMimeType: videoType.startsWith('video/') ? videoType : 'video/mp4',
          };
        } catch (error) {
          debug?.('embed.error', {
            url: sanitizeUrlForLog(attempt.url),
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      throw new AiValidationError(
        'Could not find a downloadable video for that link. TikTok/Instagram may block access without an approved API.',
      );
    }

    extractedFrom.push(extracted.extractedFrom);
    debug?.('html.extracted', {
      extractedFrom: extracted.extractedFrom,
      videoUrl: sanitizeUrlForLog(extracted.url),
    });

    const videoRes = await fetchWithTimeout(
      extracted.url,
      { method: 'GET', redirect: 'follow', headers },
      12_000,
    );

    if (!videoRes.ok) {
      debug?.('video.fetch.error', { status: videoRes.status, videoUrl: sanitizeUrlForLog(extracted.url) });
      throw new AiValidationError(`Could not access video content (HTTP ${videoRes.status}).`);
    }

    const videoType = normalizeContentType(videoRes.headers.get('content-type'));
    const isOctetMp4 = videoType === 'application/octet-stream' && isLikelyMp4Url(videoRes.url);
    debug?.('video.fetch.ok', {
      status: videoRes.status,
      contentType: videoType,
      finalUrl: sanitizeUrlForLog(videoRes.url),
      contentLength: videoRes.headers.get('content-length'),
    });
    if (!videoType.startsWith('video/') && !isOctetMp4) {
      throw new AiValidationError('Resolved a link, but it did not return a video file.');
    }

    const bytes = await readBodyToBufferWithLimit(videoRes, MAX_VIDEO_BYTES, 'Video');
    debug?.('video.bytes', { bytes: bytes.length, contentType: videoType, finalUrl: sanitizeUrlForLog(videoRes.url) });
    return {
      videoUrl: videoRes.url,
      extractedFrom,
      videoBase64: bytes.toString('base64'),
      videoMimeType: videoType.startsWith('video/') ? videoType : 'video/mp4',
    };
  }

  throw new AiValidationError('Unsupported link type. Please share a public TikTok/Reel link.');
}

function validateImportedRecipes(raw: unknown, maxIngredients: number, maxRecipes: number): GeneratedMeal[] {
  const candidates: unknown[] = [];

  if (raw && typeof raw === 'object') {
    const obj = raw as any;
    if (Array.isArray(obj.recipes)) candidates.push(...obj.recipes);
    else if (Array.isArray(obj.meals)) candidates.push(...obj.meals);
    else if (obj.meal && typeof obj.meal === 'object') candidates.push(obj.meal);
    else candidates.push(raw);
  } else {
    candidates.push(raw);
  }

  const out: GeneratedMeal[] = [];
  const seenNames = new Set<string>();

  for (const candidate of candidates) {
    try {
      const normalized = validateGeneratedMeal(candidate, maxIngredients);
      const key = normalized.name.trim().toLowerCase();
      if (!key || seenNames.has(key)) continue;
      seenNames.add(key);
      out.push(normalized);
      if (out.length >= maxRecipes) break;
    } catch {
      // Ignore invalid candidates; we only fail if all are invalid.
    }
  }

  if (out.length === 0) {
    throw new AiValidationError(
      'No recipes found for that link. Try a post where the recipe is written in the caption/description.',
    );
  }

  return out;
}

function buildImportPrompt(source: ImportSource, maxIngredients: number, maxRecipes: number): string {
  const header = [
    `Source URL: ${source.sourceUrl}`,
    `Platform: ${source.platform}`,
    `Mode: ${source.mode}`,
    `Max recipes: ${maxRecipes}`,
    `Max ingredients per recipe: ${maxIngredients}`,
    '',
  ];

  if (source.mode === 'video') {
    return [
      ...header,
      `Resolved video URL: ${source.videoUrl}`,
      '',
      'Task:',
      '- Analyze the provided cooking video (visuals + audio).',
      '- Extract 1 or more recipe candidates; if the video clearly contains multiple distinct recipes/variations, return multiple.',
      '- Use spoken words, on-screen text, and visuals (ingredients shown) to infer ingredient names and rough quantities.',
      '- If a quantity is unknown, return null quantity.',
      '- If no recipe is present, return { "recipes": [] }.',
    ].join('\n');
  }

  return [
    ...header,
    'Caption/description:',
    source.caption,
    '',
    'Task:',
    '- Extract 1 or more recipe candidates from the caption/description text.',
    '- If the text clearly contains multiple distinct recipes/variations, return multiple.',
    '- Prefer explicit ingredients from the text; do not invent ingredients if the text is not recipe-like.',
    '- If a quantity is unknown, return null quantity.',
    '- If no recipe is present, return { "recipes": [] }.',
  ].join('\n');
}

export async function importMealFromVideo(
  input: ImportVideoMealInput,
  opts?: { requestId?: string },
): Promise<{
  recipes: GeneratedMeal[];
  meta: {
    platform: ImportSource['platform'];
    mode: ImportVideoMealMode;
    extractedFrom: ExtractedFrom[];
    videoUrl?: string;
  };
}> {
  const provider = (process.env.AI_PROVIDER || 'gemini').toLowerCase();
  if (provider !== 'gemini') {
    throw new AiConfigError(`Unsupported AI provider: ${provider}`);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new AiConfigError('GEMINI_API_KEY is not configured.');

  const debug = makeImportVideoLogger(opts?.requestId);
  const trace: Array<{ event: string; meta?: Record<string, unknown> }> = [];
  const record = (event: string, meta?: Record<string, unknown>) => {
    trace.push({ event, meta });
    if (trace.length > 40) trace.shift();
    debug?.(event, meta);
  };

  const validated = validateImportVideoMealInput(input);
  const maxIngredients = clampMaxIngredients(validated.maxIngredients);
  const maxRecipes = clampMaxRecipes(validated.maxRecipes);
  record('request.validated', {
    url: sanitizeUrlForLog(validated.url),
    maxIngredients,
    maxRecipes,
  });

  try {
    const platform = guessPlatform(validated.url);
    let source: ImportSource;

    const oembed = await fetchCaptionFromOEmbed(validated.url, platform, record);
    if (oembed) {
      record('source.caption.ready', {
        platform,
        captionLength: oembed.caption.length,
        hasThumbnail: Boolean(oembed.thumbnailUrl),
        extractedFrom: oembed.extractedFrom,
      });

      source = {
        mode: 'caption',
        platform,
        sourceUrl: validated.url,
        extractedFrom: oembed.extractedFrom,
        caption: oembed.caption,
        thumbnailUrl: oembed.thumbnailUrl,
      };
    } else {
      record('source.caption.missing', { platform });
      if (platform !== 'other') {
        throw new AiValidationError(
          'Could not read the caption/description for that link. Try a public post, or try another link.',
        );
      }

      const resolvedVideo = await resolveVideoFromUrl(validated.url, record);
      source = {
        mode: 'video',
        platform,
        sourceUrl: validated.url,
        extractedFrom: resolvedVideo.extractedFrom,
        videoUrl: resolvedVideo.videoUrl,
        videoBase64: resolvedVideo.videoBase64,
        videoMimeType: resolvedVideo.videoMimeType,
      };
    }

    const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model,
    )}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const systemInstruction = [
      'You extract recipes from social cooking posts for a meal planning app.',
      'You may be given a caption/description and/or a video.',
      'Return ONLY valid JSON (no markdown, no code fences, no explanations).',
      'The JSON MUST match exactly this shape:',
      '{ "recipes": [ { "name": string, "cuisines": string[]|null, "ingredients": [ { "name": string, "quantity": number|null, "unit": string, "category": string|null } ] } ] }',
      'Rules:',
      `- recipes must be 0..${maxRecipes} items`,
      `- ingredients must be 1..${maxIngredients} items`,
      '- each ingredient.name must be non-empty',
      '- prefer including quantity + unit for every ingredient, but quantity may be null',
      '- unit must never be null; choose a reasonable unit (g, piece, tbsp, tsp, cup, ml, etc.)',
      '- category should be one of: Produce, Pantry, Meat, Dairy, Bakery, Other (or null)',
    ].join('\n');

    const userPrompt = buildImportPrompt(source, maxIngredients, maxRecipes);

    record('gemini.request', {
      model,
      platform: source.platform,
      mode: source.mode,
      extractedFrom: source.extractedFrom,
      ...(source.mode === 'video'
        ? { videoUrl: sanitizeUrlForLog(source.videoUrl) }
        : { captionLength: source.caption.length }),
      maxIngredients,
      maxRecipes,
    });

    const parts =
      source.mode === 'video'
        ? [{ inlineData: { mimeType: source.videoMimeType, data: source.videoBase64 } }, { text: userPrompt }]
        : [{ text: userPrompt }];

    const res = await fetchWithTimeout(
      endpoint,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts,
            },
          ],
          systemInstruction: { parts: [{ text: systemInstruction }] },
          generationConfig: {
            temperature: 0.25,
            maxOutputTokens: 1800,
            responseMimeType: 'application/json',
          },
        }),
      },
      45_000,
    );

    const json = (await res.json().catch(() => null)) as GeminiGenerateResponse | null;

    if (!res.ok) {
      const message = json?.error?.message || `Gemini request failed (${res.status}).`;
      throw new AiProviderError(message);
    }

    const text = extractTextFromGemini(json ?? {});
    const parsed = extractJsonObject(text);
    record('gemini.response.parsed', { textLength: text.length });

    const recipes = validateImportedRecipes(parsed, maxIngredients, maxRecipes);
    record('recipes.validated', { count: recipes.length, names: recipes.map((r) => r.name).slice(0, 5) });

    return {
      recipes,
      meta: {
        platform: source.platform,
        mode: source.mode,
        extractedFrom: source.extractedFrom,
        videoUrl: source.mode === 'video' ? source.videoUrl : undefined,
      },
    };
  } catch (error) {
    if (error && typeof error === 'object') {
      (error as any).aiImportVideoTrace = trace;
    }
    throw error;
  }
}
