/** Minimal Readwise API client (v2 export + v3 Reader list) built on the browser `fetch` API.
 *
 * Readwise responds with permissive CORS, so no client library or proxy is needed. Auth is the same
 * `Authorization: Token <token>` header for both APIs. The v2 export gives books + highlights; the v3
 * Reader list gives the inbox/archive `location` (and the Reader URL), joined to v2 books by
 * `external_id` (present only when `source === 'reader'`).
 */
import type { RNPlugin } from '@remnote/plugin-sdk';
import { CATEGORIES, type Category, categorySettingId, COLOR_MAP, SETTINGS } from './consts';
import type { SyncLog } from './log';
import type {
  ReaderInfo,
  ReaderListPage,
  ReadwiseExportPage,
  ReadwiseHighlight,
  ReadwiseSource,
} from './types/readwise';

const V2_EXPORT = 'https://readwise.io/api/v2/export/';
const V2_AUTH = 'https://readwise.io/api/v2/auth/';
const V3_LIST = 'https://readwise.io/api/v3/list/';
const MAX_RETRIES = 5;
/** Reader (v3) is 20 req/min — pace pages ~1 per 3.2s to stay under the limit (20 in any rolling minute). */
const READER_PAGE_DELAY_MS = 3200;

/** Reports fetch progress to the UI: sources kept, highlights seen, and the library total (0 if unknown). */
export type FetchProgressFn = (sources: number, highlights: number, total: number) => void;

/**
 * Build an Error that's ALREADY been surfaced to the user via `plugin.app.toast`. The popup's catch
 * checks `isToastedError` to avoid showing a second, duplicate toast.
 */
export function toastedError(msg: string): Error {
  const e = new Error(msg) as Error & { toasted?: boolean };
  e.toasted = true;
  return e;
}

/** True for an Error already surfaced via a toast (so callers don't double-toast). */
export function isToastedError(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { toasted?: boolean }).toasted === true;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Read + validate the Readwise token. Throws (after a toast) if missing. */
async function readToken(plugin: RNPlugin, log?: SyncLog): Promise<string> {
  const token = (await plugin.settings.getSetting<string>(SETTINGS.apiKey))?.trim();
  // Never log the token itself — only whether it's set and how long it is.
  log?.log('fetch', `Token setting: ${token ? `present (${token.length} chars)` : '(missing)'}`);
  if (!token) {
    const msg = 'Set your Readwise access token in the plugin settings first (readwise.io/access_token).';
    await plugin.app.toast(msg);
    throw toastedError(msg);
  }
  return token;
}

/** Verify a token via `GET /api/v2/auth/` (204 ok / 401 bad). Returns true/false; never throws. */
export async function verifyToken(token: string): Promise<boolean> {
  try {
    const res = await fetch(V2_AUTH, { headers: { Authorization: `Token ${token.trim()}` } });
    return res.status === 204 || res.ok;
  } catch {
    return false;
  }
}

/**
 * GET a URL with the Readwise auth header, honoring 429 `Retry-After` (in SECONDS — multiply by 1000)
 * by sleeping then re-issuing the SAME request, capped at `MAX_RETRIES`. 401 → toasted + thrown; other
 * non-OK → toasted + thrown. Returns the parsed JSON.
 */
async function getJson<T>(
  plugin: RNPlugin,
  url: string,
  token: string,
  scope: string,
  log?: SyncLog
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Token ${token}` } });
    if (res.ok) return (await res.json()) as T;
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = Number.parseInt(res.headers.get('Retry-After') ?? '', 10);
      // Browsers usually hide Retry-After (CORS), so fall back to a growing backoff that can outlast
      // the API's rolling 1-minute window.
      const waitMs = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : (attempt + 1) * 8) * 1000;
      log?.log(scope, `Rate limited (429); retry ${attempt + 1}/${MAX_RETRIES} after ${waitMs}ms.`);
      await sleep(waitMs);
      continue;
    }
    const msg =
      res.status === 401
        ? 'Readwise rejected the token (HTTP 401). Check it in the plugin settings.'
        : `Readwise request failed: HTTP ${res.status} ${res.statusText}.`;
    log?.log(scope, `ERROR: ${msg}`);
    await plugin.app.toast(msg);
    throw toastedError(msg);
  }
}

/**
 * Fetch every source (with its highlights) from the v2 export endpoint, paginating via
 * `nextPageCursor`. `updatedAfter` (ISO) limits to sources changed since then (passed only when the
 * `incremental` setting is on; dedup is always per-source via the ledger regardless). Calls
 * `onProgress` after each page; the first page's `count` is the library source total. Returns the full
 * source list plus that reported total (for the popup's truncation awareness).
 */
export async function fetchExport(
  plugin: RNPlugin,
  opts: { updatedAfter?: string; onProgress?: FetchProgressFn; log?: SyncLog }
): Promise<{ sources: ReadwiseSource[]; reportedTotal: number }> {
  const { updatedAfter, onProgress, log } = opts;
  const token = await readToken(plugin, log);
  log?.section('Fetch from Readwise (v2 export)');
  log?.log('fetch', updatedAfter ? `Incremental — changes since ${updatedAfter}.` : 'Full export.');

  const sources: ReadwiseSource[] = [];
  let highlightCount = 0;
  let reportedTotal = 0;
  let cursor: string | null = null;
  let page = 0;

  while (true) {
    const params = new URLSearchParams();
    if (cursor) params.append('pageCursor', cursor);
    if (updatedAfter) params.append('updatedAfter', updatedAfter);
    page += 1;
    const data = await getJson<ReadwiseExportPage>(
      plugin,
      `${V2_EXPORT}?${params.toString()}`,
      token,
      'fetch',
      log
    );
    if (page === 1) reportedTotal = data.count ?? 0;
    for (const s of data.results ?? []) {
      sources.push(s);
      highlightCount += s.highlights?.length ?? 0;
    }
    onProgress?.(sources.length, highlightCount, reportedTotal);
    log?.log('fetch', `Page ${page}: +${data.results?.length ?? 0} sources (total ${sources.length}).`);
    cursor = data.nextPageCursor ?? null;
    if (!cursor) break;
  }

  log?.log('fetch', `Fetched ${sources.length} source(s), ${highlightCount} highlight(s).`);
  return { sources, reportedTotal };
}

/**
 * Fetch Reader (v3) documents and return a `Reader doc id → { location, url, sourceUrl }` map.
 * Same auth + same 429 backoff as v2; `updatedAfter` (ISO) limits to recently-changed Reader docs
 * (passed only when `incremental` is on). The Reader API is 20 req/min, so we pace pages ~1 per 3.2s —
 * a full sweep of a large library takes a while. Best-effort: a failure logs and returns whatever was
 * collected (location is enrichment, not core data).
 */
export async function fetchReaderDocs(
  plugin: RNPlugin,
  opts: { updatedAfter?: string; onProgress?: (count: number) => void; log?: SyncLog }
): Promise<Map<string, ReaderInfo>> {
  const { updatedAfter, onProgress, log } = opts;
  const out = new Map<string, ReaderInfo>();
  const token = (await plugin.settings.getSetting<string>(SETTINGS.apiKey))?.trim();
  if (!token) return out;
  log?.section('Fetch from Readwise Reader (v3 list)');
  let cursor: string | null = null;
  let page = 0;
  try {
    while (true) {
      const params = new URLSearchParams();
      params.append('limit', '100');
      if (cursor) params.append('pageCursor', cursor);
      if (updatedAfter) params.append('updatedAfter', updatedAfter);
      page += 1;
      const data = await getJson<ReaderListPage>(
        plugin,
        `${V3_LIST}?${params.toString()}`,
        token,
        'fetch',
        log
      );
      for (const d of data.results ?? []) {
        if (d.id) out.set(d.id, { location: d.location, url: d.url, sourceUrl: d.source_url });
      }
      onProgress?.(out.size);
      log?.log('fetch', `Reader page ${page}: +${data.results?.length ?? 0} docs (total ${out.size}).`);
      cursor = data.nextPageCursor ?? null;
      if (!cursor) break;
      await sleep(READER_PAGE_DELAY_MS); // throttle: stay under the 20 req/min Reader limit
    }
  } catch (err) {
    // Reader location is enrichment — never let a v3 failure abort the whole sync.
    log?.log('fetch', `Reader fetch stopped early (${err instanceof Error ? err.message : String(err)}).`);
  }
  log?.log('fetch', `Reader docs mapped: ${out.size}.`);
  return out;
}

/** Parse the comma-separated tag-filter setting into a trimmed, lowercased, de-duped list. */
export function parseTagFilter(raw: string | undefined): string[] {
  return [
    ...new Set(
      (raw ?? '')
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
    ),
  ];
}

/**
 * True if a highlight should be copied per the tag filter: case-insensitive, match-ANY against the
 * highlight's own tags. An empty filter copies everything.
 */
export function matchesTagFilter(highlight: ReadwiseHighlight, tagList: string[]): boolean {
  if (tagList.length === 0) return true;
  const tags = (highlight.tags ?? []).map((t) => t.name.trim().toLowerCase());
  return tags.some((t) => tagList.includes(t));
}

/**
 * True if the SOURCE (book) itself carries a matching tag (`book_tags`). When it does, ALL of that
 * source's highlights are copied — not only the individually-tagged ones. Empty filter → false (the
 * per-highlight `matchesTagFilter` already copies everything in that case, so no source override needed).
 */
export function sourceMatchesTagFilter(source: ReadwiseSource, tagList: string[]): boolean {
  if (tagList.length === 0) return false;
  const tags = (source.book_tags ?? []).map((t) => t.name.trim().toLowerCase());
  return tags.some((t) => tagList.includes(t));
}

/** Read the five per-category include booleans (default ON). Returns the set of included categories. */
export async function getIncludedCategories(plugin: RNPlugin): Promise<Set<Category>> {
  const out = new Set<Category>();
  for (const c of CATEGORIES) {
    const v = await plugin.settings.getSetting<boolean>(categorySettingId(c));
    // default true: a never-set boolean reads as undefined → treat as included.
    if (v === undefined || v) out.add(c);
  }
  return out;
}

/**
 * True if a source's category is included. `included` empty (all five unchecked) is treated as "all"
 * so a misconfiguration never silently syncs nothing. AND-combined with the tag filter at the
 * highlight level.
 */
export function matchesCategoryFilter(source: ReadwiseSource, included: Set<Category>): boolean {
  if (included.size === 0) return true;
  const cat = (source.category ?? '').trim().toLowerCase() as Category;
  // Unknown categories (shouldn't happen) pass through rather than get silently dropped.
  if (!(CATEGORIES as readonly string[]).includes(cat)) return true;
  return included.has(cat);
}

/** Readwise highlight color → RemNote highlight-color format token, or undefined (plain). */
export function colorFormat(color: string | null | undefined): string | undefined {
  return COLOR_MAP[(color ?? '').trim().toLowerCase()];
}
