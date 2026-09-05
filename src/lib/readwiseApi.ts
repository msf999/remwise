/** Minimal Readwise API client (v2 export + v3 Reader list) built on the browser `fetch` API.
 *
 * Readwise responds with permissive CORS, so no client library or proxy is needed. Auth is the same
 * `Authorization: Token <token>` header for both APIs. The v2 export gives books + highlights; the v3
 * Reader list gives the inbox/archive `location` (and the Reader URL), joined to v2 books by
 * `external_id` (present only when `source === 'reader'`). Every fetch is a FULL fetch (no delta mode).
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

/** True for an abort (the popup was closed mid-fetch) — from `fetch` itself or from `sleep`. */
export function isAbortError(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError';
}

const abortError = (): Error => {
  const e = new Error('Fetch cancelled');
  e.name = 'AbortError';
  return e;
};

/** Sleep `ms`, rejecting immediately with an AbortError if `signal` aborts first. */
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

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

/** Outcome of an open-time token check. `unreachable` says nothing about the token itself. */
export type TokenCheck = 'ok' | 'invalid' | 'unreachable';

/**
 * Verify a token via `GET /api/v2/auth/` (204 ok / 401 bad). Only a 401/403 means the token is
 * wrong; being offline, a 429, or a 5xx is reported as `unreachable` so a valid token is never
 * called invalid. Never throws.
 */
export async function verifyToken(token: string): Promise<TokenCheck> {
  try {
    const res = await fetch(V2_AUTH, { headers: { Authorization: `Token ${token.trim()}` } });
    if (res.status === 204 || res.ok) return 'ok';
    if (res.status === 401 || res.status === 403) return 'invalid';
    return 'unreachable';
  } catch {
    return 'unreachable';
  }
}

interface GetOpts {
  /** Aborting it cancels the request (and any backoff sleep) with an AbortError. */
  signal?: AbortSignal;
  /** Toast a non-OK failure before throwing (default true). Best-effort callers that surface the
   *  error themselves pass false, so the user doesn't see a scary toast for a non-fatal problem. */
  toast?: boolean;
}

/**
 * GET a URL with the Readwise auth header, honoring 429 `Retry-After` (in SECONDS — multiply by 1000)
 * by sleeping then re-issuing the SAME request, capped at `MAX_RETRIES`. 401 → toasted + thrown; other
 * non-OK → toasted + thrown (unless `toast:false`). Returns the parsed JSON.
 */
async function getJson<T>(
  plugin: RNPlugin,
  url: string,
  token: string,
  scope: string,
  log?: SyncLog,
  opts: GetOpts = {}
): Promise<T> {
  const { signal, toast = true } = opts;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Token ${token}` }, signal });
    if (res.ok) return (await res.json()) as T;
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = Number.parseInt(res.headers.get('Retry-After') ?? '', 10);
      // Browsers usually hide Retry-After (CORS), so fall back to a growing backoff that can outlast
      // the API's rolling 1-minute window.
      const waitMs = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : (attempt + 1) * 8) * 1000;
      log?.log(scope, `Rate limited (429); retry ${attempt + 1}/${MAX_RETRIES} after ${waitMs}ms.`);
      await sleep(waitMs, signal);
      continue;
    }
    const msg =
      res.status === 401
        ? 'Readwise rejected the token (HTTP 401). Check it in the plugin settings.'
        : res.status === 429
          ? 'Readwise is rate-limiting requests (HTTP 429, retries exhausted) — wait a minute, then try again.'
          : `Readwise request failed: HTTP ${res.status} ${res.statusText}.`;
    log?.log(scope, `ERROR: ${msg}`);
    if (!toast) throw new Error(msg);
    await plugin.app.toast(msg);
    throw toastedError(msg);
  }
}

/**
 * Fetch EVERY source (with its highlights) from the v2 export endpoint, paginating via
 * `nextPageCursor`. Calls `onProgress` after each page; the first page's `count` is the library source
 * total. Returns the full source list plus that reported total. Throws on failure (toasted) or abort.
 */
export async function fetchExport(
  plugin: RNPlugin,
  opts: { onProgress?: FetchProgressFn; log?: SyncLog; signal?: AbortSignal }
): Promise<{ sources: ReadwiseSource[]; reportedTotal: number }> {
  const { onProgress, log, signal } = opts;
  const token = await readToken(plugin, log);
  log?.section('Fetch from Readwise (v2 export)');
  log?.log('fetch', 'Full export.');

  // Keyed by user_book_id: a book whose highlights span pages is returned ONCE PER PAGE, and two entries
  // for one book would become two create rows sharing a single selection id — one tick, two documents.
  const byBookId = new Map<number, ReadwiseSource>();
  let highlightCount = 0;
  let reportedTotal = 0;
  let cursor: string | null = null;
  let page = 0;

  while (true) {
    const params = new URLSearchParams();
    if (cursor) params.append('pageCursor', cursor);
    page += 1;
    const data = await getJson<ReadwiseExportPage>(
      plugin,
      `${V2_EXPORT}?${params.toString()}`,
      token,
      'fetch',
      log,
      { signal }
    );
    if (page === 1) reportedTotal = data.count ?? 0;
    for (const s of data.results ?? []) {
      highlightCount += s.highlights?.length ?? 0;
      const prev = byBookId.get(s.user_book_id);
      if (prev) prev.highlights = [...(prev.highlights ?? []), ...(s.highlights ?? [])];
      else byBookId.set(s.user_book_id, s);
    }
    onProgress?.(byBookId.size, highlightCount, reportedTotal);
    log?.log('fetch', `Page ${page}: +${data.results?.length ?? 0} sources (total ${byBookId.size}).`);
    cursor = data.nextPageCursor ?? null;
    if (!cursor) break;
  }

  const sources = [...byBookId.values()];
  log?.log('fetch', `Fetched ${sources.length} source(s), ${highlightCount} highlight(s).`);
  return { sources, reportedTotal };
}

/** Result of the Reader sweep. `complete:false` = it stopped early; `docs` holds what was collected. */
export interface ReaderFetchResult {
  /** Reader doc id → { location, url, sourceUrl }. */
  docs: Map<string, ReaderInfo>;
  /** True only when every page was fetched — the plan may then treat "not in the map" as "not in Reader". */
  complete: boolean;
  /** Why it stopped early (for the popup's warning line). */
  error?: string;
}

/**
 * Fetch ALL Reader (v3) documents and return a `Reader doc id → { location, url, sourceUrl }` map.
 * Same auth + same 429 backoff as v2. The Reader API is 20 req/min, so we pace pages ~1 per 3.2s —
 * a full sweep of a large library takes a while. Best-effort: a failure logs, does NOT toast, and
 * returns whatever was collected flagged `complete:false` (location is enrichment, not core data) —
 * the popup shows a warning and the plan leaves unmapped sources' locations untouched. An abort
 * (popup closed) is re-thrown so the whole preview stops.
 */
export async function fetchReaderDocs(
  plugin: RNPlugin,
  opts: { onProgress?: (count: number) => void; log?: SyncLog; signal?: AbortSignal }
): Promise<ReaderFetchResult> {
  const { onProgress, log, signal } = opts;
  const docs = new Map<string, ReaderInfo>();
  log?.section('Fetch from Readwise Reader (v3 list)');
  const token = (await plugin.settings.getSetting<string>(SETTINGS.apiKey))?.trim();
  if (!token) {
    log?.log('fetch', 'Reader fetch skipped: no token set.');
    return { docs, complete: false, error: 'no token set' };
  }
  let cursor: string | null = null;
  let page = 0;
  try {
    while (true) {
      const params = new URLSearchParams();
      params.append('limit', '100');
      if (cursor) params.append('pageCursor', cursor);
      page += 1;
      const data = await getJson<ReaderListPage>(
        plugin,
        `${V3_LIST}?${params.toString()}`,
        token,
        'fetch',
        log,
        { signal, toast: false }
      );
      for (const d of data.results ?? []) {
        if (d.id) docs.set(d.id, { location: d.location, url: d.url, sourceUrl: d.source_url });
      }
      onProgress?.(docs.size);
      log?.log('fetch', `Reader page ${page}: +${data.results?.length ?? 0} docs (total ${docs.size}).`);
      cursor = data.nextPageCursor ?? null;
      if (!cursor) break;
      await sleep(READER_PAGE_DELAY_MS, signal); // throttle: stay under the 20 req/min Reader limit
    }
  } catch (err) {
    if (isAbortError(err)) throw err; // the popup closed — stop the whole preview, not just this sweep
    // Reader location is enrichment — never let a v3 failure abort the whole sync.
    const msg = err instanceof Error ? err.message : String(err);
    log?.log(
      'fetch',
      `Reader fetch stopped early (${msg}) — ${docs.size} doc(s) mapped; locations of unmapped sources are left unchanged this run.`
    );
    return { docs, complete: false, error: msg };
  }
  log?.log('fetch', `Reader docs mapped: ${docs.size} (complete).`);
  return { docs, complete: true };
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
 * True if a source's category is included. All five toggles OFF (`included` empty) means exactly
 * what it says — nothing is included (the popup refuses to fetch and explains why). Sources with an
 * unknown category value (shouldn't happen) pass through rather than get silently dropped.
 */
export function matchesCategoryFilter(source: ReadwiseSource, included: Set<Category>): boolean {
  if (included.size === 0) return false;
  const cat = (source.category ?? '').trim().toLowerCase() as Category;
  if (!(CATEGORIES as readonly string[]).includes(cat)) return true;
  return included.has(cat);
}

/** Readwise highlight color → RemNote highlight-color format token, or undefined (plain). */
export function colorFormat(color: string | null | undefined): string | undefined {
  return COLOR_MAP[(color ?? '').trim().toLowerCase()];
}
