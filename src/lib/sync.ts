/** Add-only sync: copy tagged Readwise highlights into `Readwise / Sources` and keep source metadata
 *  fresh. Highlights are plain bullets (dedup via a per-source ledger); sources have a powerup with
 *  metadata + a hidden ledger. Adapted from the Zot2Rem sync engine. */
import { type PluginRem, type RNPlugin, type RichTextInterface } from '@remnote/plugin-sdk';
import {
  AUTHOR_TITLE_SEP,
  CATEGORY_LABEL,
  type Category,
  DISAMBIG_SEP,
  HIERARCHY,
  IE,
  LOCATION_LABEL,
  NOT_IN_READER,
  SETTINGS,
  SOURCE_POWERUP,
  SOURCE_SLOTS,
  SUPPLEMENT_DOC_SUFFIX,
  SUPPLEMENTAL_CATEGORY,
  SUPPLEMENTS_HEADER,
  type UpdatableField,
} from './consts';
import { colorFormat, matchesCategoryFilter, matchesTagFilter, sourceMatchesTagFilter } from './readwiseApi';
import type { SyncLog } from './log';
import type { ReaderInfo, ReadwiseHighlight, ReadwiseSource } from './types/readwise';

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Yield to the macrotask queue so the plugin-widget iframe can paint, run GC, and answer the host's
 *  liveness pings BETWEEN apply items. Without this a large apply is one tight burst of thousands of
 *  SDK round-trips and the iframe can exhaust its renderer-process memory → the browser kills the frame
 *  (the grey "sad tab" crash seen on big syncs). A macrotask (setTimeout) — not a microtask — is what
 *  actually lets the event loop breathe between items. */
const yieldToHost = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Display/base title for a source with no title. Stored in the `baseTitle` slot too, so an untitled
 *  doc groups the same way on every run (a blank slot would fall back to the doc name). */
const UNTITLED = '(untitled)';
const baseTitleOf = (s: ReadwiseSource): string => (s.title ?? '').trim() || UNTITLED;

/** The document title before any collision disambiguation: `Author - Title`, or just `Title` when the
 *  source has no author. Sorting by name therefore groups every source by the same author together. */
const displayBase = (title: string, author: string): string => {
  const t = title.trim() || UNTITLED;
  const a = author.trim();
  return a ? `${a}${AUTHOR_TITLE_SEP}${t}` : t;
};

/** True for a Readwise "supplementals" source (curated popular highlights for a book). These never get
 *  their own document — their highlights go under the main source's `Supplements` header. */
const isSupplemental = (s: ReadwiseSource): boolean =>
  (s.category ?? '').trim().toLowerCase() === SUPPLEMENTAL_CATEGORY;

/** Join key for matching a supplemental to its main source: normalised title + author. */
const titleAuthorKey = (title: string, author: string): string =>
  `${nameKey(title).toLowerCase()}\u0000${nameKey(author).toLowerCase()}`;
const titleOnlyKey = (title: string): string => nameKey(title).toLowerCase();

/** Recover the RAW title from a document name when the `baseTitle` slot is blank: strip the
 *  `Author - ` prefix AND a trailing ` - Supplement`. Both must go, or the next run re-adds whichever
 *  was left and the affix compounds on every sync (`Author - Author - Title`, `… - Supplement - Supplement`). */
function rawTitleFromName(name: string, author: string): string {
  const prefix = author.trim() ? author.trim() + AUTHOR_TITLE_SEP : '';
  let out = prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
  while (out.endsWith(SUPPLEMENT_DOC_SUFFIX)) out = out.slice(0, -SUPPLEMENT_DOC_SUFFIX.length);
  return out;
}

/** True for a document that holds a supplemental's highlights (its Category property says so). */
const isSupplementDocCategory = (category: string): boolean =>
  nameKey(category).toLowerCase() === SUPPLEMENTAL_CATEGORY;

/** True when a doc's name is EXACTLY the holding-document name we would generate for it — i.e. the
 *  ` - Supplement` really is our suffix, not part of the source's own title. */
const nameIsGeneratedSupplementName = (es: ExistingSource): boolean =>
  nameKey(es.name) === nameKey(displayBase(es.baseTitle, es.author) + SUPPLEMENT_DOC_SUFFIX);

/** True if `rem` is a source document's `Supplements` header. Checked against the already-fetched
 *  `text` (a single plain string), so finding it costs NO extra SDK round-trips. */
const isSupplementsRem = (rem: PluginRem): boolean => {
  const t = rem.text;
  return !!t && t.length === 1 && typeof t[0] === 'string' && t[0].trim() === SUPPLEMENTS_HEADER;
};

// ───────────────────────── Plan types ─────────────────────────

/** One source-metadata field whose Readwise value differs from what's stored on the doc. */
export interface FieldChange {
  field: UpdatableField;
  fromDisplay: string;
  toDisplay: string;
}

/** A Readwise source with no matching doc yet → create it + all its eligible highlights. */
export interface SourceCreateEntry {
  id: string; // `sc:<userBookId>`
  userBookId: number;
  name: string; // the disambiguated displayTitle
  categoryLabel: string;
  source: ReadwiseSource;
  eligible: ReadwiseHighlight[];
  /** Highlights from matching `supplementals` sources — written under this doc's `Supplements` header. */
  supplements: ReadwiseHighlight[];
  /** True for a SUPPLEMENT DOCUMENT: a supplemental whose main source isn't in RemNote yet, so its
   *  highlights are held in their own `… - Supplement` doc until the main source appears and the sync
   *  stages a merge. Its highlights are plain bullets (the whole document is the supplement). */
  isSupplementDoc: boolean;
}

/** An existing source whose metadata (or name) changed. `source` is undefined for a location-only row. */
export interface SourceUpdateEntry {
  id: string; // `su:<remId>`
  name: string;
  rem: PluginRem;
  source?: ReadwiseSource;
  changes: FieldChange[];
}

/** An existing source gaining new highlights (not yet in its ledger). */
export interface SourceAddHighlights {
  id: string; // `ha:<remId>`
  sourceRemId: string;
  name: string;
  rem: PluginRem;
  highlights: ReadwiseHighlight[]; // selectable ids are `ha:<remId>:<hlId>`
}

/** An EXISTING source doc gaining supplemental highlights (under its `Supplements` header). A new
 *  doc's supplements ride along in its `SourceCreateEntry` instead, so there's no cross-row ordering. */
export interface SupplementAddEntry {
  id: string; // `hs:<remId>`
  name: string;
  rem: PluginRem;
  highlights: ReadwiseHighlight[]; // selectable ids are `hs:<remId>:<hlId>`
}

/** A source already fully in sync (read-only in the preview). */
export interface KeptEntry {
  id: string; // `k:<remId>`
  name: string;
}

/** The full set of changes a sync would make (add-only). */
export interface SyncPlan {
  toCreateSources: SourceCreateEntry[];
  toUpdateSources: SourceUpdateEntry[];
  toAddHighlights: SourceAddHighlights[];
  toAddSupplements: SupplementAddEntry[];
  /** Supplement documents whose main source now exists — fold them in and delete the emptied doc. */
  toMergeSupplementDocs: SupplementMerge[];
  /** Duplicate lookup rems a cross-device race created. Destructive, so it is a row like any other. */
  toFoldLookupDuplicates: LookupDuplicate[];
  alreadyInSync: KeptEntry[];
  fetchedSources: number;
  matchingHighlights: number;
  /** Non-deleted fetched sources skipped by the "Include …" category settings (for the status text). */
  excludedByCategory: number;
  /** Names of powerup-tagged docs with no readable Readwise id (see `SyncContext.orphanDocNames`). */
  orphanDocNames: string[];
}

// ───────────────────────── Context ─────────────────────────

/** An existing source doc under `Readwise/Sources`, with its identity + ledger read once. */
interface ExistingSource {
  rem: PluginRem;
  userBookId: number;
  externalId: string;
  /** The stored raw Readwise title — the base every display name is derived from. */
  baseTitle: string;
  /** The stored Author property, resolved to text. Needed by EVERY name now (`Author - Title`). */
  author: string;
  /** True when the Author slot references a rem that no longer exists. `author` then reads as '', which
   *  must NOT be taken to mean "no author" — it would strip the author out of the document's title. */
  authorDangling: boolean;
  /** The stored Category property, resolved to text. Identifies a SUPPLEMENT DOCUMENT durably — the
   *  fetch can't, because a supplemental deleted from Readwise simply stops being returned. */
  category: string;
  name: string;
  ledger: Set<string>;
}

/** Once-per-run inputs `makeIncremental` needs (IE powerup + inherited priority/rotation). */
interface IncSetup {
  pu: PluginRem;
  incParent: PluginRem | undefined;
  priority: string;
  rotation: string;
}

/** Per-run context: settings, the Reader map, lookup caches, and the existing-source index. */
export interface SyncContext {
  tagList: string[];
  included: Set<Category>;
  /** When true, apply each highlight's Readwise color as a RemNote highlight color. */
  applyColors: boolean;
  /** Reader doc id → { location, url, sourceUrl }; joined to v2 books by `external_id`. */
  readerByExternalId: Map<string, ReaderInfo>;
  /** True when the Reader sweep fetched EVERY page this run. When false (it failed mid-way), a reader
   *  source missing from the map is "unknown" — its location is left alone — not "Not in Reader". */
  readerComplete: boolean;
  /** `doc <name>` → lookup doc rem; `ref <doc> <value>` → plain reference rem. */
  lookupCache: Map<string, PluginRem>;
  /** Parent rem id → (trimmed child name → OLDEST child rem). One scan per parent per run. */
  childNameMaps: Map<string, Map<string, PluginRem>>;
  /** Rem id → resolved name, so the diff never re-resolves the same reference. */
  refNameCache: Map<string, string>;
  /** Powerup-tagged docs under `Sources/` with no readable Readwise id — surfaced in the popup, because
   *  a sync on top of one silently imports its source a second time. */
  orphanDocNames: string[];
  existingSources: ExistingSource[];
  /** user_book_id → the OLDEST source doc carrying that id. */
  sourceByBookId: Map<number, ExistingSource>;
  incSetup?: IncSetup | null;
}

// ───────────────────────── Small rem helpers (adapted from Zot2Rem) ─────────────────────────

async function remName(plugin: RNPlugin, rem: PluginRem): Promise<string> {
  return rem.text ? (await plugin.richText.toString(rem.text)).trim() : '';
}

/** NFC + whitespace-collapse for name/value comparisons (stops phantom re-write loops). */
function nameKey(s: string): string {
  return s.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** True for RemNote's internal machinery rems (powerup defs, slots, property rems). Never content. */
async function isStructuralRem(rem: PluginRem): Promise<boolean> {
  const flags = await Promise.all([
    rem.isPowerup().catch(() => false),
    rem.isPowerupProperty().catch(() => false),
    rem.isPowerupSlot().catch(() => false),
    rem.isPowerupEnum().catch(() => false),
    rem.isPowerupPropertyListItem().catch(() => false),
    rem.isSlot().catch(() => false),
  ]);
  return flags.some(Boolean);
}

async function getProp(rem: PluginRem, slot: string): Promise<string> {
  try {
    return ((await rem.getPowerupProperty(SOURCE_POWERUP, slot)) ?? '').trim();
  } catch {
    return '';
  }
}

async function setProp(rem: PluginRem, slot: string, value: RichTextInterface): Promise<void> {
  await rem.setPowerupProperty(SOURCE_POWERUP, slot, value);
}

/** Read a slot as RichText (references preserved); undefined if unset/error. */
async function getSlotRichText(rem: PluginRem, slot: string): Promise<RichTextInterface | undefined> {
  try {
    return await rem.getPowerupPropertyAsRichText(SOURCE_POWERUP, slot);
  } catch {
    return undefined;
  }
}

/** Rem id → resolved name. Passed around instead of the whole SyncContext so the one-time migration
 *  (which has no sync context) can resolve slot references too. */
export type RefNameCache = Map<string, string>;

async function resolveRefName(plugin: RNPlugin, cache: RefNameCache, id: string): Promise<string> {
  const cached = cache.get(id);
  if (cached !== undefined) return cached;
  const r = await plugin.rem.findOne(id);
  const name = r ? await remName(plugin, r) : '';
  cache.set(id, name);
  return name;
}

/** Flatten a slot's RichText to a comparable string: references → their names, text as-is. */
async function slotToComparable(
  plugin: RNPlugin,
  cache: RefNameCache,
  rt: RichTextInterface | undefined
): Promise<string> {
  if (!rt) return '';
  let out = '';
  for (const el of rt) {
    if (typeof el === 'string') out += el;
    else if (el && (el as { i?: string }).i === 'q')
      out += await resolveRefName(plugin, cache, (el as { _id: string })._id);
    else if (el && (el as { i?: string }).i === 'm') out += (el as { text?: string }).text ?? '';
    else out += '\n';
  }
  return out.trim();
}

/** Canonical key for comparing a stored Link slot against a raw URL (ignore scheme/punctuation). */
const linkKey = (s: string): string =>
  s
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[^a-z0-9]+/g, '');

// ───────────────────────── Hierarchy + lookups ─────────────────────────

async function findSourcesParent(plugin: RNPlugin): Promise<PluginRem | undefined> {
  const root = await plugin.rem.findByName([HIERARCHY.root], null);
  if (!root) return undefined;
  return (await plugin.rem.findByName([HIERARCHY.sources], root._id)) ?? undefined;
}

/** Find (or create) `Readwise / Sources` and return the `Sources` rem. */
async function ensureSourcesParent(plugin: RNPlugin): Promise<PluginRem> {
  const root = await ensureRoot(plugin);
  let sources = await plugin.rem.findByName([HIERARCHY.sources], root._id);
  if (!sources) {
    sources = await plugin.rem.createRem();
    if (!sources) throw new Error('Failed to create the Sources document.');
    await sources.setText([HIERARCHY.sources]);
    await sources.setParent(root);
    await sources.setIsDocument(true);
  }
  return sources;
}

async function ensureRoot(plugin: RNPlugin): Promise<PluginRem> {
  let root = await plugin.rem.findByName([HIERARCHY.root], null);
  if (!root) {
    root = await plugin.rem.createRem();
    if (!root) throw new Error('Failed to create the Readwise root document.');
    await root.setText([HIERARCHY.root]);
    await root.setIsDocument(true);
  }
  return root;
}

/** Find the OLDEST non-structural child of `parent` named `name`. One scan per parent per run. */
async function oldestChildByName(
  plugin: RNPlugin,
  ctx: SyncContext,
  parent: PluginRem,
  name: string
): Promise<PluginRem | undefined> {
  let map = ctx.childNameMaps.get(parent._id);
  if (!map) {
    map = new Map<string, PluginRem>();
    for (const child of await parent.getChildrenRem()) {
      if (await isStructuralRem(child)) continue;
      const n = (await remName(plugin, child)).trim();
      if (!n) continue;
      const cur = map.get(n);
      if (!cur || child.createdAt < cur.createdAt) map.set(n, child);
    }
    ctx.childNameMaps.set(parent._id, map);
  }
  return map.get(name.trim());
}

function registerChildName(ctx: SyncContext, parent: PluginRem, name: string, child: PluginRem): void {
  ctx.childNameMaps.get(parent._id)?.set(name.trim(), child);
}

/** Find-or-create a lookup document (Categories/Authors/Locations) under the Readwise root. Cached. */
async function ensureLookupDoc(plugin: RNPlugin, ctx: SyncContext, docName: string): Promise<PluginRem> {
  const cacheKey = `doc ${docName}`;
  const cached = ctx.lookupCache.get(cacheKey);
  if (cached) return cached;
  const root = await ensureRoot(plugin);
  let doc = await oldestChildByName(plugin, ctx, root, docName);
  if (!doc) {
    doc = await plugin.rem.createRem();
    if (!doc) throw new Error(`Failed to create the "${docName}" document.`);
    await doc.setText([docName]);
    await doc.setParent(root);
    await doc.setIsDocument(true);
    registerChildName(ctx, root, docName, doc);
  }
  ctx.lookupCache.set(cacheKey, doc);
  return doc;
}

/** Find-or-create a PLAIN rem named `value` under lookup document `docName`. Cached. */
async function ensureRefRem(
  plugin: RNPlugin,
  ctx: SyncContext,
  docName: string,
  value: string
): Promise<PluginRem> {
  const cacheKey = `ref ${docName} ${value}`;
  const cached = ctx.lookupCache.get(cacheKey);
  if (cached) return cached;
  const doc = await ensureLookupDoc(plugin, ctx, docName);
  let rem = await oldestChildByName(plugin, ctx, doc, value);
  if (!rem) {
    rem = await plugin.rem.createRem();
    if (!rem) throw new Error(`Failed to create reference rem "${value}" under "${docName}".`);
    await rem.setText([value]);
    await rem.setParent(doc);
    registerChildName(ctx, doc, value, rem);
  }
  ctx.lookupCache.set(cacheKey, rem);
  return rem;
}

/** A single rem-reference rich text value. */
async function refValue(plugin: RNPlugin, rem: PluginRem): Promise<RichTextInterface> {
  return plugin.richText.rem(rem._id).value();
}

// ───────────────────────── Cross-device dedup (lookup rems) ─────────────────────────

/**
 * A group of same-name duplicate lookup rems (Categories/Authors/Locations) that a cross-device sync
 * race created. Folding one is DESTRUCTIVE — it moves the duplicate's children (which may be the user's
 * own notes), rewrites every rem in the knowledge base that references it, and deletes it — so it is a
 * previewable, tickable plan row like everything else, never an unconditional sweep.
 */
export interface LookupDuplicate {
  id: string; // `ld:<duplicate remId>`
  /** Which lookup document it sits under (Categories / Authors / Locations). */
  docName: string;
  name: string;
  canonical: PluginRem;
  duplicate: PluginRem;
  /** Non-structural children of the duplicate that will move to the canonical rem. */
  childCount: number;
  /** Rems in the KB whose references will be re-pointed at the canonical rem. */
  referenceCount: number;
}

/**
 * Find same-name duplicate lookup rems under `Readwise/{Categories,Authors,Locations}`. READ-ONLY —
 * it only reports what folding WOULD do (the oldest copy is kept). `rem.merge` is not used: it leaves
 * references dangling.
 */
async function findLookupDuplicates(plugin: RNPlugin, log?: SyncLog): Promise<LookupDuplicate[]> {
  const out: LookupDuplicate[] = [];
  const root = await plugin.rem.findByName([HIERARCHY.root], null);
  if (!root) return out;

  for (const docName of [HIERARCHY.categories, HIERARCHY.authors, HIERARCHY.locations]) {
    const doc = await plugin.rem.findByName([docName], root._id);
    if (!doc) continue;
    const groups = new Map<string, PluginRem[]>();
    for (const child of await doc.getChildrenRem()) {
      if (await isStructuralRem(child)) continue;
      const name = (await remName(plugin, child)).trim();
      if (!name) continue;
      (groups.get(name) ?? groups.set(name, []).get(name)!).push(child);
    }
    for (const [name, rems] of groups) {
      if (rems.length < 2) continue;
      rems.sort((a, b) => a.createdAt - b.createdAt);
      for (let i = 1; i < rems.length; i++) {
        const duplicate = rems[i];
        out.push({
          id: `ld:${duplicate._id}`,
          docName,
          name,
          canonical: rems[0],
          duplicate,
          childCount: (await movableChildren(duplicate)).length,
          referenceCount: (await duplicate.remsReferencingThis()).length,
        });
      }
    }
  }
  if (out.length) log?.log('plan', `Found ${out.length} duplicate lookup rem(s) that could be folded into the oldest copy.`);
  return out;
}

/** Fold ONE duplicate lookup rem into its canonical twin: move children, re-point every reference, then
 *  remove it. Throws on failure so the caller can count the row as failed and leave the rem in place. */
async function foldLookupDuplicate(plugin: RNPlugin, dup: LookupDuplicate, log?: SyncLog): Promise<void> {
  const { canonical, duplicate } = dup;
  let pos = (await canonical.getChildrenRem()).length; // append: setParent PREPENDS by default
  for (const child of await movableChildren(duplicate)) {
    await child.setParent(canonical, pos);
    pos += 1;
  }
  const repoint = (rt: RichTextInterface): RichTextInterface =>
    rt.map((el) => {
      if (typeof el === 'string') return el;
      const obj = el as { i?: string; _id?: string };
      if (obj.i === 'q' && obj._id === duplicate._id) return { ...(el as Record<string, unknown>), _id: canonical._id };
      return el;
    }) as RichTextInterface;
  for (const refRem of await duplicate.remsReferencingThis()) {
    // BOTH fields: a powerup property's VALUE lives in the property rem's backText, so rewriting only
    // `text` would leave every source's Author/Category/Location reference pointing at the rem we are
    // about to delete — turning a tidy-up into a library-wide dangling reference.
    if (refRem.text) await refRem.setText(repoint(refRem.text));
    if (refRem.backText) await refRem.setBackText(repoint(refRem.backText));
  }
  await duplicate.remove();
  log?.log('apply', `  folded duplicate "${dup.name}" under ${dup.docName} into the oldest copy.`);
}

/** Why a slot needs rewriting even though its VALUE compares equal (or isn't compared at all). */
export type SlotHealth = 'ok' | 'dangling' | 'empty' | 'short' | 'unknown';

/**
 * STRUCTURAL health of one plugin-owned slot. Deliberately never compares the rendered VALUE: a link
 * rem renders as the page title RemNote fetched, and an image element never round-trips, so a value
 * comparison on `link`/`readwiseUrl`/`cover` stages a row that can never be satisfied. This looks only
 * at whether the slot still holds what it is supposed to hold:
 *
 *  - `dangling` — it references a rem that no longer resolves. RemNote renders that as **"Loading"**
 *    and offers "Restore This Bullet"; the value diffs CANNOT see it, because a dangling reference
 *    resolves to '' and `link` is compared against the intact raw `linkUrl` copy. Verified live on
 *    2026-09-11: 334 documents holding 567 dangling references all reported "already in sync".
 *  - `empty`   — the slot holds nothing although Readwise has a value for it (a wiped property).
 *  - `short`   — it holds FEWER references than it should (e.g. the `Readwise` slot lost one of its two
 *    links). Only reported when `wantCount` is passed, and only above zero refs, so a plain-text
 *    fallback is never mistaken for a truncated one.
 */
async function slotHealth(
  plugin: RNPlugin,
  cache: RefNameCache,
  rem: PluginRem,
  slot: string,
  opts: { wantNonEmpty?: boolean; wantCount?: number; els?: RichTextInterface } = {}
): Promise<SlotHealth> {
  let els = opts.els;
  if (els === undefined) {
    // STRICT read, one retry. `getSlotRichText` swallows a failure and returns undefined, which is
    // indistinguishable from a genuinely unset slot — and concluding 'empty' from a FAILED read would
    // rewrite a perfectly healthy slot (for `readwise` that can even drop a url). Same swallowed-read
    // class the 2026-09-04 audit hardened the identity reads against; here it degrades to 'unknown',
    // which stages nothing.
    for (let attempt = 0; els === undefined && attempt < 2; attempt += 1) {
      try {
        els = (await rem.getPowerupPropertyAsRichText(SOURCE_POWERUP, slot)) ?? [];
      } catch {
        if (attempt === 0) await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (els === undefined) return 'unknown';
  }
  let refs = 0;
  for (const el of els) {
    if (typeof el === 'string') continue;
    const obj = el as { i?: string; _id?: string };
    if (obj.i !== 'q' || !obj._id) continue;
    refs += 1;
    if ((await resolveRefName(plugin, cache, obj._id)) !== '') continue;
    // An empty NAME means the target is GONE — or that it exists carrying blank text. Only the first is
    // repairable: `createLinkRem` returns the EXISTING rem for a known url, so rewriting a link slot
    // whose rem is merely unnamed hands back the very same rem and the row would restage for ever.
    if ((await plugin.rem.findOne(obj._id)) === undefined) return 'dangling';
  }
  const hasContent = els.some((el) => (typeof el === 'string' ? el.trim() !== '' : true));
  if (opts.wantNonEmpty && !hasContent) return 'empty';
  if (opts.wantCount !== undefined && refs > 0 && refs < opts.wantCount) return 'short';
  return 'ok';
}

// ───────────────────────── Ledger ─────────────────────────

/** Parse the synced-highlight-ids ledger. Missing/blank → empty Set (silently — a fresh doc has none);
 *  present-but-unparseable → empty Set PLUS a warning log line (never silently empties a corrupt
 *  ledger). Always WRITE with serializeLedger. */
function parseLedger(raw: string, log?: SyncLog): Set<string> {
  const s = (raw ?? '').trim();
  if (!s) return new Set();
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) return new Set(arr.map((x) => String(x)));
    throw new Error('not an array');
  } catch {
    log?.log('plan', 'WARNING: a source has an unreadable sync ledger — treating as empty; its highlights may be re-copied.');
    return new Set();
  }
}

const serializeLedger = (ids: Set<string>): RichTextInterface => [JSON.stringify([...ids])];

/** Checkpoint the ledger every N added highlights, so a failure late in a long row leaves at most N-1
 *  copied-but-unrecorded highlights (the one thing that can produce duplicates on the next run). */
const LEDGER_CHECKPOINT = 5;

/** Read a slot WITHOUT swallowing failures. An UNSET slot legitimately comes back undefined/null and
 *  must read as '' — only a genuine read error may throw, so the caller can retry or fail loudly.
 *  (Calling `.trim()` straight on the result turned an unset slot into a TypeError, which crashed the
 *  whole preview on any document missing that property.) */
const readSlotStrict = async (rem: PluginRem, slot: string): Promise<string> =>
  ((await rem.getPowerupProperty(SOURCE_POWERUP, slot)) ?? '').trim();

/** Read the ledger, retrying once. Unlike `getProp` this does NOT swallow a failure: a read that
 *  returns '' on error would be parsed as an EMPTY ledger, and writing that back would erase the
 *  document's whole dedup record and re-copy every highlight next run. Callers must let it throw so
 *  the row fails loudly and is retried instead. (An unset slot still reads as '' → an empty Set, which
 *  is correct for a document that has never been written to.) */
async function readLedger(rem: PluginRem, log?: SyncLog): Promise<Set<string>> {
  try {
    return parseLedger(await readSlotStrict(rem, SOURCE_SLOTS.syncedHighlightIds), log);
  } catch (err) {
    log?.log('apply', `  ledger read failed (${errMsg(err)}) — retrying once.`);
    await sleepMs(250);
    return parseLedger(await readSlotStrict(rem, SOURCE_SLOTS.syncedHighlightIds), log);
  }
}

/** Write the ledger, retrying once after a short pause — a lost ledger write is the single failure that
 *  can duplicate highlights on the next run, so it gets a second chance. */
async function writeLedger(rem: PluginRem, ids: Set<string>, log?: SyncLog): Promise<void> {
  try {
    await setProp(rem, SOURCE_SLOTS.syncedHighlightIds, serializeLedger(ids));
  } catch (err) {
    log?.log('apply', `  ledger write failed (${errMsg(err)}) — retrying once.`);
    await sleepMs(250);
    await setProp(rem, SOURCE_SLOTS.syncedHighlightIds, serializeLedger(ids));
  }
}

// ───────────────────────── Context build + existing scan ─────────────────────────

/** Build a SyncContext from the popup's inputs (tag filter, included categories and the Reader map are
 *  all read/fetched by the popup and passed in), read the colour setting, and scan existing sources. */
export async function buildSyncContext(
  plugin: RNPlugin,
  opts: {
    tagList: string[];
    included: Set<Category>;
    readerByExternalId: Map<string, ReaderInfo>;
    readerComplete: boolean;
    log?: SyncLog;
  }
): Promise<SyncContext> {
  const applyColors = (await plugin.settings.getSetting<boolean>(SETTINGS.applyColors)) ?? false;
  const ctx: SyncContext = {
    tagList: opts.tagList,
    included: opts.included,
    applyColors,
    readerByExternalId: opts.readerByExternalId,
    readerComplete: opts.readerComplete,
    lookupCache: new Map(),
    childNameMaps: new Map(),
    refNameCache: new Map(),
    orphanDocNames: [],
    existingSources: [],
    sourceByBookId: new Map(),
    incSetup: undefined,
  };
  await scanExistingSources(plugin, ctx, opts.log);
  return ctx;
}

/** One pass over `Sources/` children (skipping structural rems + non-source docs) building the
 *  identity maps and reading each source's baseTitle + ledger. */
async function scanExistingSources(plugin: RNPlugin, ctx: SyncContext, log?: SyncLog): Promise<void> {
  const sourcesDoc = await findSourcesParent(plugin);
  if (!sourcesDoc) return;
  let n = 0;
  for (const child of await sourcesDoc.getChildrenRem()) {
    if (await isStructuralRem(child)) continue;
    if (!(await child.hasPowerup(SOURCE_POWERUP))) continue; // a non-source doc the user added — leave it
    // STRICT read, with one retry: `getProp` would swallow a transient failure and return '', which is
    // indistinguishable from an unset slot — and a doc wrongly judged identity-less is re-created as a
    // SECOND full copy of the same source. Better to fail the preview loudly and be re-run.
    let userBookIdStr: string;
    let storedBase: string;
    try {
      userBookIdStr = await readSlotStrict(child, SOURCE_SLOTS.userBookId);
      storedBase = await readSlotStrict(child, SOURCE_SLOTS.baseTitle);
    } catch (err) {
      log?.log('plan', `Identity read failed for a source doc (${errMsg(err)}) — retrying once.`);
      await sleepMs(250);
      userBookIdStr = await readSlotStrict(child, SOURCE_SLOTS.userBookId);
      storedBase = await readSlotStrict(child, SOURCE_SLOTS.baseTitle);
    }
    const userBookId = Number(userBookIdStr);
    if (!userBookIdStr || !Number.isFinite(userBookId)) {
      // Genuinely identity-less: a doc left by a create the browser killed between tagging and stamping
      // the id. Skipped (add-only never deletes) — but SURFACED in the plan, because syncing on top of
      // it silently creates a second copy of that source.
      const orphanName = await remName(plugin, child);
      ctx.orphanDocNames.push(orphanName || '(untitled)');
      log?.log('plan', `WARNING: source doc "${orphanName}" carries the powerup but no Readwise book id — ignored (leftover of a failed create?); delete it by hand, or its source will be imported a second time.`);
      continue;
    }
    const externalId = await getProp(child, SOURCE_SLOTS.externalId);
    const name = await remName(plugin, child);
    // The Author property drives every display name now (`Author - Title`), so read it for EVERY doc
    // rather than lazily for colliding ones.
    const authorRt = await getSlotRichText(child, SOURCE_SLOTS.author);
    const author = await slotToComparable(plugin, ctx.refNameCache, authorRt);
    // An Author reference whose target rem is gone resolves to '' — indistinguishable from "no author",
    // which would drop the author from the document's title for good. Flag it instead.
    let authorDangling = false;
    for (const el of authorRt ?? []) {
      if (typeof el === 'string') continue;
      const obj = el as { i?: string; _id?: string };
      if (obj.i === 'q' && obj._id && (await resolveRefName(plugin, ctx.refNameCache, obj._id)) === '') {
        authorDangling = true;
        break;
      }
    }
    const category = await slotToComparable(plugin, ctx.refNameCache, await getSlotRichText(child, SOURCE_SLOTS.category));
    // (baseTitle was read strictly above: a swallowed failure here would fall back to parsing the doc
    // name, which can permanently rewrite a title.)
    const baseTitle = storedBase || rawTitleFromName(name, author);
    // Strict too: a silently-empty ledger here is the dedup record for the whole document.
    const ledger = await readLedger(child, log);
    const es: ExistingSource = { rem: child, userBookId, externalId, baseTitle, author, authorDangling, category, name, ledger };
    ctx.existingSources.push(es);
    n += 1;
    const prev = ctx.sourceByBookId.get(userBookId);
    if (prev)
      log?.log('plan', `WARNING: two source docs share Readwise book id ${userBookId} ("${prev.name}" / "${name}") — only the OLDEST is synced; merge or delete the other by hand.`);
    if (!prev || child.createdAt < prev.rem.createdAt) ctx.sourceByBookId.set(userBookId, es);
  }
  log?.log('plan', `Scanned ${n} existing source doc(s).`);
}

// ───────────────────────── Desired metadata + title disambiguation ─────────────────────────

const categoryLabelOf = (source: ReadwiseSource): string => {
  const c = (source.category ?? '').trim().toLowerCase() as Category;
  return CATEGORY_LABEL[c] ?? (source.category ?? '').trim();
};

/** Reader info for a source (only reader sources have an external_id). */
const readerInfoOf = (source: ReadwiseSource, ctx: SyncContext): ReaderInfo | undefined =>
  source.external_id ? ctx.readerByExternalId.get(source.external_id) : undefined;

/** Display label for a Reader `location` value; an unknown/empty value → "Not in Reader". */
const locationLabelOf = (location: string | null | undefined): string =>
  (location && LOCATION_LABEL[location]) || NOT_IN_READER;

/** Desired Location label. `known:false` = a reader source missing from an INCOMPLETE Reader map (the
 *  sweep failed mid-way): leave an existing location alone / write none on create, rather than assert
 *  "Not in Reader". When the sweep completed, a reader source missing from the map really is gone from
 *  Reader → "Not in Reader". Non-Reader sources (no external_id) are always "Not in Reader". */
function desiredLocation(source: ReadwiseSource, ctx: SyncContext): { label: string; known: boolean } {
  if (!source.external_id) return { label: NOT_IN_READER, known: true };
  const info = ctx.readerByExternalId.get(source.external_id);
  if (info) return { label: locationLabelOf(info.location), known: true };
  return ctx.readerComplete ? { label: NOT_IN_READER, known: true } : { label: '', known: false };
}

/** The source's own URL, else (Reader sources) the Reader doc's source URL. Empty-string-safe. */
const linkOf = (source: ReadwiseSource, ctx: SyncContext): string =>
  (source.source_url ?? '').trim() || (readerInfoOf(source, ctx)?.sourceUrl ?? '').trim();

/** The two Readwise URLs for the source (classic + Reader), in order, blanks dropped. */
const readwiseUrlsOf = (source: ReadwiseSource, ctx: SyncContext): string[] =>
  [source.readwise_url, readerInfoOf(source, ctx)?.url].map((u) => (u ?? '').trim()).filter(Boolean);

/** A name-disambiguation candidate (existing or new). `base` is already `Author - Title`. */
interface NameEntry {
  base: string;
  userBookId: number;
  category: () => Promise<string>;
  assign: (name: string) => void;
}

/** Build the display name at a given escalation depth (0=base, 1=+category, 2=+[id]). The author is
 *  already part of the base, so the old "+author" step is gone. Empty components are skipped (they
 *  don't appear and don't disambiguate — the depth keeps rising, with [id] guaranteeing uniqueness). */
function nameAtDepth(base: string, category: string, userBookId: number, depth: number): string {
  const comps = [category, `[${userBookId}]`].slice(0, depth).filter(Boolean);
  return [base, ...comps].join(DISAMBIG_SEP);
}

/**
 * Compute the symmetric, collision-disambiguated display name for every source (existing + new),
 * grouping by `Author - Title` built from the stored `baseTitle` + Author property (the doc name is
 * never parsed). All members of a colliding group get the next component together:
 * `Author - Title` → `Author - Title — Category` → `Author - Title — Category — [id]`.
 * `skipRemIds` leaves docs out entirely (legacy supplemental docs, which the migration will remove —
 * they share their main doc's title+author and would otherwise force a needless escalation).
 * Returns name maps keyed by existing rem id and by new userBookId.
 */
async function computeDisplayNames(
  plugin: RNPlugin,
  ctx: SyncContext,
  newSources: ReadwiseSource[],
  skipRemIds: Set<string>,
  /** Rem id → the source Readwise returned for it THIS run. Fresher than the stored slots, so a
   *  title/author change in Readwise actually renames the document (using only the stored baseTitle
   *  would compare a doc's name against a name derived from itself, and never stage a rename). */
  fetchedByRem: Map<string, ReadwiseSource>,
  /** Existing docs that are SUPPLEMENT DOCUMENTS — their name carries the ` - Supplement` suffix, which
   *  also keeps them from colliding with the main document they share a title and author with. */
  supplementDocRemIds: Set<string>,
  /** Sources being created AS supplement documents this run — same suffix. */
  newSupplementBookIds: Set<number>,
  log?: SyncLog
): Promise<{ existingName: Map<string, string>; newName: Map<number, string> }> {
  const existingName = new Map<string, string>();
  const newName = new Map<number, string>();

  const entries: NameEntry[] = [];
  for (const es of ctx.existingSources) {
    if (skipRemIds.has(es.rem._id)) continue;
    // Only the canonical (oldest) doc for a book id is named: two docs sharing an id would otherwise
    // escalate to the SAME `… — [id]` name, since the id is the last disambiguator.
    if (ctx.sourceByBookId.get(es.userBookId)?.rem._id !== es.rem._id) continue;
    const fetched = fetchedByRem.get(es.rem._id);
    const suffix = supplementDocRemIds.has(es.rem._id) ? SUPPLEMENT_DOC_SUFFIX : '';
    entries.push({
      base:
        (fetched
          ? displayBase(baseTitleOf(fetched), (fetched.author ?? '').trim())
          : displayBase(es.baseTitle, es.author)) + suffix,
      userBookId: es.userBookId,
      category: fetched
        ? async () => categoryLabelOf(fetched)
        : async () => slotToComparable(plugin, ctx.refNameCache, await getSlotRichText(es.rem, SOURCE_SLOTS.category)),
      assign: (name) => existingName.set(es.rem._id, name),
    });
  }
  for (const s of newSources) {
    entries.push({
      base:
        displayBase(baseTitleOf(s), (s.author ?? '').trim()) +
        (newSupplementBookIds.has(s.user_book_id) ? SUPPLEMENT_DOC_SUFFIX : ''),
      userBookId: s.user_book_id,
      category: async () => categoryLabelOf(s),
      assign: (name) => newName.set(s.user_book_id, name),
    });
  }

  // Group by the full `Author - Title` base; singletons stay clean.
  const byBase = new Map<string, NameEntry[]>();
  for (const e of entries) (byBase.get(nameKey(e.base)) ?? byBase.set(nameKey(e.base), []).get(nameKey(e.base))!).push(e);

  for (const group of byBase.values()) {
    if (group.length === 1) {
      group[0].assign(group[0].base);
      continue;
    }
    // Resolve the category only for the (rare) colliding groups, then escalate symmetrically.
    const infos = await Promise.all(group.map(async (e) => ({ e, category: await e.category() })));
    const depth = new Map<NameEntry, number>(infos.map((i) => [i.e, 1] as const));
    for (let pass = 0; pass < 2; pass++) {
      const byName = new Map<string, typeof infos>();
      for (const info of infos) {
        const nm = nameKey(nameAtDepth(info.e.base, info.category, info.e.userBookId, depth.get(info.e)!));
        (byName.get(nm) ?? byName.set(nm, []).get(nm)!).push(info);
      }
      for (const arr of byName.values()) {
        if (arr.length > 1) for (const info of arr) {
          const d = depth.get(info.e)!;
          if (d < 2) depth.set(info.e, d + 1);
        }
      }
    }
    for (const info of infos) {
      info.e.assign(nameAtDepth(info.e.base, info.category, info.e.userBookId, depth.get(info.e)!));
    }
    log?.log('plan', `Disambiguated ${group.length} sources sharing "${group[0].base}".`);
  }
  return { existingName, newName };
}

// ───────────────────────── Slot writers ─────────────────────────

async function writeAuthor(plugin: RNPlugin, ctx: SyncContext, rem: PluginRem, author: string): Promise<void> {
  const a = author.trim();
  if (!a) return void (await setProp(rem, SOURCE_SLOTS.author, []));
  const ref = await ensureRefRem(plugin, ctx, HIERARCHY.authors, a);
  await setProp(rem, SOURCE_SLOTS.author, await refValue(plugin, ref));
}

async function writeCategory(plugin: RNPlugin, ctx: SyncContext, rem: PluginRem, label: string): Promise<void> {
  const l = label.trim();
  if (!l) return void (await setProp(rem, SOURCE_SLOTS.category, []));
  const ref = await ensureRefRem(plugin, ctx, HIERARCHY.categories, l);
  await setProp(rem, SOURCE_SLOTS.category, await refValue(plugin, ref));
}

async function writeLocation(plugin: RNPlugin, ctx: SyncContext, rem: PluginRem, label: string): Promise<void> {
  const l = label.trim() || NOT_IN_READER;
  const ref = await ensureRefRem(plugin, ctx, HIERARCHY.locations, l);
  await setProp(rem, SOURCE_SLOTS.location, await refValue(plugin, ref));
}

async function writeLink(plugin: RNPlugin, rem: PluginRem, url: string): Promise<void> {
  const u = url.trim();
  // Always record the RAW url alongside the reference: the reference alone cannot be compared back to
  // a url (see SOURCE_SLOTS.linkUrl), which used to stage the same "link" row on every single sync.
  await setProp(rem, SOURCE_SLOTS.linkUrl, u ? [u] : []);
  if (!u) return void (await setProp(rem, SOURCE_SLOTS.link, []));
  const lr = await plugin.rem.createLinkRem(u, false);
  await setProp(rem, SOURCE_SLOTS.link, lr ? await refValue(plugin, lr) : [u]);
}

async function writeReadwiseUrls(plugin: RNPlugin, rem: PluginRem, urls: string[]): Promise<void> {
  if (urls.length === 0) return void (await setProp(rem, SOURCE_SLOTS.readwiseUrl, []));
  const ids: string[] = [];
  for (const u of urls) {
    const lr = await plugin.rem.createLinkRem(u, false);
    if (lr) ids.push(lr._id);
  }
  // Fall back to plain text when ANY url failed to get a link rem, not just when they all did: writing
  // only the ones that worked leaves the slot looking TRUNCATED to the repair pass ('short'), which
  // would restage a row the writer cannot satisfy. `slotHealth`'s `refs > 0` clause then reads this
  // plain-text form as healthy.
  if (ids.length < urls.length) return void (await setProp(rem, SOURCE_SLOTS.readwiseUrl, [urls.join('\n')]));
  let b = plugin.richText.rem(ids[0]);
  for (let i = 1; i < ids.length; i++) b = b.text('\n').rem(ids[i]);
  await setProp(rem, SOURCE_SLOTS.readwiseUrl, await b.value());
}

async function writeCover(plugin: RNPlugin, rem: PluginRem, url: string): Promise<void> {
  const u = url.trim();
  if (!u) return void (await setProp(rem, SOURCE_SLOTS.cover, []));
  try {
    await setProp(rem, SOURCE_SLOTS.cover, await plugin.richText.image(u).value());
  } catch {
    // A url RemNote's image element rejects must never fail the source write — but it must not leave
    // the slot EMPTY either: the structural repair pass reads an empty slot as corrupt and would
    // restage the identical row on every single sync. Storing the raw url as text keeps the state
    // stable (and still tells the user what the cover was meant to be).
    await setProp(rem, SOURCE_SLOTS.cover, [u]).catch(() => undefined);
  }
}

/** Append a plain body bullet (write-once summary / document_note) at `position`. No-op when empty. */
async function appendBodyBullet(plugin: RNPlugin, parent: PluginRem, text: string, position: number): Promise<void> {
  const t = text.trim();
  if (!t) return;
  const b = await plugin.rem.createRem();
  if (!b) return;
  await b.setParent(parent, position); // parent first: under the Readwise root it's removable on rollback
  await b.setText([t]);
}

/** Find (or create, as the LAST child) a source doc's `Supplements` header-1 rem. Idempotent. */
async function ensureSupplementsRem(plugin: RNPlugin, doc: PluginRem, log?: SyncLog): Promise<PluginRem> {
  const children = await doc.getChildrenRem();
  const found = await findSupplementsRem(children);
  if (found) return found;
  const rem = await plugin.rem.createRem();
  if (!rem) throw new Error('createRem returned undefined for the Supplements header');
  await rem.setParent(doc, children.length); // last child — supplements sit below the source's own highlights
  await rem.setText([SUPPLEMENTS_HEADER]);
  // Header 1 — and NOT merely cosmetic: it is how the section is recognised next run, so that a plain
  // bullet reading "Supplements" can never be mistaken for it. Log if the host refuses.
  await rem.setFontSize('H1').catch(() => {
    log?.log('apply', '  WARNING: could not make the Supplements header an H1; the next sync may create a second one.');
  });
  return rem;
}

/** The document's `Supplements` section header, or undefined. ONLY a real header-1 counts: a plain
 *  bullet whose text happens to be "Supplements" — an imported highlight, or one the user typed — must
 *  never be adopted, or the plugin nests its content under a rem the user owns (verified 2026-09-05:
 *  taking the last text match did exactly that). The LAST H1 wins, since ours is always appended last. */
async function findSupplementsRem(children: PluginRem[]): Promise<PluginRem | undefined> {
  for (const c of [...children].reverse()) {
    if (!isSupplementsRem(c)) continue;
    if ((await c.getFontSize().catch(() => undefined)) === 'H1') return c;
  }
  return undefined;
}

/** Where a source doc's OWN next highlight goes: at the end, but ABOVE the `Supplements` header so
 *  that section stays last. Also the child count, which callers use as the append position. */
async function ownHighlightStart(doc: PluginRem): Promise<number> {
  const children = await doc.getChildrenRem();
  const header = await findSupplementsRem(children);
  const i = header ? children.findIndex((c) => c._id === header._id) : -1;
  return i >= 0 ? i : children.length;
}

/** Create one highlight bullet: markdown-parsed text (color-formatted when `applyColor`), with an
 *  optional note child. The rich text is built BEFORE the rem exists (a parse failure leaves nothing
 *  behind), the rem is parented FIRST (under the Readwise root it is removable), and any failure after
 *  that removes the partial bullet again — the highlight isn't ledgered, so the next run re-adds it
 *  cleanly instead of duplicating it. */
async function addHighlight(
  plugin: RNPlugin,
  sourceDoc: PluginRem,
  h: ReadwiseHighlight,
  applyColor: boolean,
  position: number,
  log?: SyncLog
): Promise<void> {
  const text = (h.text ?? '').trim() || '(empty highlight)';
  let rt = await plugin.richText.parseFromMarkdown(text);
  const fmt = applyColor ? colorFormat(h.color) : undefined;
  if (fmt) {
    // Colour is decoration: if the host rejects the format name (it validates more strictly than the
    // SDK's own types — 'Pink' type-checks but throws), import the highlight PLAIN rather than lose it.
    // Without this, one unsupported colour drops the bullet AND keeps it out of the ledger, so it is
    // retried and fails on every future sync.
    try {
      const plain = await plugin.richText.toString(rt);
      rt = await plugin.richText.applyTextFormatToRange(rt, 0, plain.length, fmt as never);
    } catch (err) {
      log?.log('apply', `  highlight ${h.id}: colour "${fmt}" rejected by RemNote (${errMsg(err)}) — imported as plain text.`);
    }
  }
  // Append a 📌 pin — a markdown hyperlink to the highlight's classic Readwise open-link
  // (readwise.io/open/<id>) — preceded by an explicit space element so it's separated from the
  // highlight text (parseFromMarkdown trims a leading space). Parsed separately so the pin never
  // inherits the highlight color; the URL is embedded directly in the link element.
  const sourceUrl = (h.readwise_url ?? '').trim() || (h.url ?? '').trim();
  if (sourceUrl) {
    const pinRt = await plugin.richText.parseFromMarkdown(`[📌](${sourceUrl})`);
    rt = [...rt, ' ', ...pinRt];
  }
  const note = (h.note ?? '').trim();

  const rem = await plugin.rem.createRem();
  if (!rem) throw new Error('createRem returned undefined for a highlight');
  try {
    // Explicit position: setParent PREPENDS by default, which would reverse Readwise's order.
    await rem.setParent(sourceDoc, position);
    await rem.setText(rt);
    if (note) {
      const noteRem = await plugin.rem.createRem();
      if (noteRem) {
        await noteRem.setParent(rem);
        await noteRem.setText([note]);
      }
    }
  } catch (err) {
    // Sanctioned delete #3 of 4 (see the Delete-scope design note): the per-bullet counterpart of
    // createSourceDoc's rollback. Best effort — if `setParent` was what failed, the rem is not yet under
    // the Readwise root and the manifest's Delete scope does not reach it.
    await rem.remove().catch(() => undefined); // removes the note child with it
    throw err;
  }
}

// ───────────────────────── Incremental Everything (optional) ─────────────────────────

async function getIncSetup(plugin: RNPlugin, ctx: SyncContext, log?: SyncLog): Promise<IncSetup | null> {
  if (ctx.incSetup !== undefined) return ctx.incSetup;
  let setup: IncSetup | null = null;
  if (await plugin.settings.getSetting<boolean>(SETTINGS.initIncremental)) {
    const pu = await plugin.powerup.getPowerupByCode(IE.powerup);
    if (!pu) {
      log?.log('apply', 'Incremental Everything not installed — skipped making sources incremental.');
    } else {
      const sourcesRem = await findSourcesParent(plugin);
      const rootRem = await plugin.rem.findByName([HIERARCHY.root], null);
      let incParent: PluginRem | undefined;
      if (sourcesRem && (await sourcesRem.hasPowerup(IE.powerup))) incParent = sourcesRem;
      else if (rootRem && (await rootRem.hasPowerup(IE.powerup))) incParent = rootRem;
      // Priority + rotation inherit from the closest incremental ancestor (Sources/root if tagged),
      // matching IE's getInitialPriority/getInitialRotation; otherwise IE's defaults.
      let priority = String(IE.defaultPriority);
      let rotation: string = IE.defaultRotation;
      if (incParent) {
        const inherited = (await incParent.getPowerupProperty(IE.powerup, IE.prioritySlot)).trim();
        if (inherited) priority = inherited;
        const inhRotation = (await incParent.getPowerupProperty(IE.powerup, IE.rotationSlot)).trim();
        if (inhRotation && inhRotation.toLowerCase() !== 'default') rotation = inhRotation;
      }
      setup = { pu, incParent, priority, rotation };
    }
  }
  ctx.incSetup = setup;
  return setup;
}

async function makeIncremental(plugin: RNPlugin, rem: PluginRem, ctx: SyncContext, log?: SyncLog): Promise<void> {
  try {
    if (await rem.hasPowerup(IE.powerup)) return;
    const setup = await getIncSetup(plugin, ctx, log);
    if (!setup) return;
    // Replicate IE's initIncrementalRem writes exactly (verified against the IE source) so the rem is
    // byte-identical to an IE-native one. nextRepDate = today → due now; originalIncDate + firstAdded
    // = today too; priority + rotation as single-element string arrays; repHist = the madeIncremental
    // marker. (firstAdded/rotation aren't required to PARSE as incremental, but IE writes them and its
    // UI reads them, so we match.)
    await rem.addPowerup(IE.powerup);
    const dailyDoc = await plugin.date.getDailyDoc(new Date());
    const dateRef = dailyDoc ? await plugin.richText.rem(dailyDoc).value() : undefined;
    if (dateRef) {
      await rem.setPowerupProperty(IE.powerup, IE.nextRepDateSlot, dateRef);
      await rem.setPowerupProperty(IE.powerup, IE.originalIncDateSlot, dateRef);
      await rem.setPowerupProperty(IE.powerup, IE.firstAddedSlot, dateRef);
    }
    await rem.setPowerupProperty(IE.powerup, IE.prioritySlot, [setup.priority]);
    await rem.setPowerupProperty(IE.powerup, IE.rotationSlot, [setup.rotation]);
    const parsedPriority = Number(setup.priority);
    const priorityNum = Number.isFinite(parsedPriority) ? parsedPriority : IE.defaultPriority;
    const marker = { date: Date.now(), scheduled: Date.now(), eventType: 'madeIncremental', priority: priorityNum };
    await rem.setPowerupProperty(IE.powerup, IE.repHistSlot, [JSON.stringify([marker])]);
    log?.log('apply', `Made source incremental (priority ${setup.priority}, rotation ${setup.rotation}).`);
  } catch (err) {
    log?.log('apply', `Incremental-init failed (non-fatal): ${errMsg(err)}`);
  }
}

// ───────────────────────── Diff ─────────────────────────

const displayValue = (s: string): string => (s.trim() ? (s.length > 80 ? s.slice(0, 79) + '…' : s) : '(empty)');

/** Compare an existing source's stored slots/name against fresh Readwise metadata. */
async function diffSource(
  plugin: RNPlugin,
  ctx: SyncContext,
  es: ExistingSource,
  source: ReadwiseSource,
  desiredName: string | undefined
): Promise<FieldChange[]> {
  const changes: FieldChange[] = [];

  // NOTE: 'name' is the only field whose `toDisplay` is WRITTEN verbatim by applyUpdate (setText), so
  // it must carry the FULL desired name, not the truncated displayValue used for the other (preview-only) rows.
  if (desiredName && nameKey(es.name) !== nameKey(desiredName))
    changes.push({ field: 'name', fromDisplay: es.name || UNTITLED, toDisplay: desiredName });

  const curAuthor = es.author; // read once in the scan (every display name needs it)
  const wantAuthor = (source.author ?? '').trim();
  if (nameKey(curAuthor) !== nameKey(wantAuthor))
    changes.push({ field: 'author', fromDisplay: displayValue(curAuthor), toDisplay: displayValue(wantAuthor) });

  const catRt = await getSlotRichText(es.rem, SOURCE_SLOTS.category);
  const curCat = await slotToComparable(plugin, ctx.refNameCache, catRt);
  const wantCat = categoryLabelOf(source);
  if (nameKey(curCat) !== nameKey(wantCat))
    changes.push({ field: 'category', fromDisplay: displayValue(curCat), toDisplay: displayValue(wantCat) });

  const loc = desiredLocation(source, ctx);
  let locRt: RichTextInterface | undefined;
  if (loc.known) {
    locRt = await getSlotRichText(es.rem, SOURCE_SLOTS.location);
    const curLoc = await slotToComparable(plugin, ctx.refNameCache, locRt);
    if (nameKey(curLoc) !== nameKey(loc.label))
      changes.push({ field: 'location', fromDisplay: displayValue(curLoc), toDisplay: displayValue(loc.label) });
  }

  // Link = the v2 source_url, else the Reader doc's source URL. When the source has no v2 URL and its
  // Reader doc is unknown this run (incomplete sweep), the link is unknown too → skip the diff rather
  // than stage "<url> → (empty)". Compare against the RAW url we stored when the link was written; the
  // visible slot holds a reference whose name may be a page title, which can never equal the url.
  // Fall back to the resolved name only for documents written before that slot existed — one applied
  // row then populates it and the comparison is exact from then on.
  const linkKnown = !!(source.source_url ?? '').trim() || loc.known;
  const wantLink = linkKnown ? linkOf(source, ctx) : '';
  let linkRt: RichTextInterface | undefined;
  if (linkKnown) {
    const storedUrl = await getProp(es.rem, SOURCE_SLOTS.linkUrl);
    linkRt = await getSlotRichText(es.rem, SOURCE_SLOTS.link);
    const curLink = storedUrl || (await slotToComparable(plugin, ctx.refNameCache, linkRt));
    if (linkKey(curLink) !== linkKey(wantLink))
      changes.push({ field: 'link', fromDisplay: displayValue(curLink), toDisplay: displayValue(wantLink) });
  }

  // ── Self-heal a CORRUPTED slot ───────────────────────────────────────────────────────────────────
  // A slot can be broken while its value still compares EQUAL, so none of the diffs above can see it:
  // a deleted lookup/link rem leaves a dangling reference that resolves to '' (RemNote renders it as
  // "Loading"), and `link` is compared against the intact raw `linkUrl` copy rather than the reference.
  // Without this pass such a document reports "already in sync" for ever and no re-sync can repair it
  // — verified live on 2026-09-11, where 334 documents holding 567 dangling references staged 0 rows.
  // Every check is STRUCTURAL (see `slotHealth`), never a value comparison, which is what lets
  // `readwise` and `cover` be repaired here without reintroducing the phantom diffs that kept them
  // create-only. Each broken slot stages ITS OWN field, so applyUpdate rewrites exactly that slot, and
  // the row is opt-out like any other.
  const staged = new Set(changes.map((c) => c.field));
  const cache = ctx.refNameCache;
  const heal = (field: UpdatableField, health: SlotHealth, to: string): void => {
    // 'unknown' = the slot could not be READ. Staging a rewrite off a failed read is how you destroy a
    // healthy slot, so it is treated as "no opinion" and nothing is staged.
    if (health === 'ok' || health === 'unknown' || staged.has(field)) return;
    staged.add(field);
    const from = health === 'dangling' ? '(dangling ref)' : health === 'short' ? '(incomplete)' : '(missing)';
    changes.push({ field, fromDisplay: from, toDisplay: to });
  };

  // Author: the scan already walked this slot's references, so reuse its verdict rather than re-read.
  // An empty author slot needs no heal — the value diff above stages it whenever Readwise has an
  // author, and when it doesn't there is nothing to write.
  if (es.authorDangling) heal('author', 'dangling', displayValue(wantAuthor));
  heal('category', await slotHealth(plugin, cache, es.rem, SOURCE_SLOTS.category, { wantNonEmpty: !!wantCat, els: catRt }), displayValue(wantCat));
  if (loc.known)
    heal('location', await slotHealth(plugin, cache, es.rem, SOURCE_SLOTS.location, { wantNonEmpty: !!loc.label, els: locRt }), displayValue(loc.label));
  if (linkKnown)
    heal('link', await slotHealth(plugin, cache, es.rem, SOURCE_SLOTS.link, { wantNonEmpty: !!wantLink, els: linkRt }), displayValue(wantLink));

  // `readwise` + `cover` are reachable ONLY through this repair pass — they are never value-diffed.
  // The readwise repair REPLACES the whole slot, so it may run only when this run actually knows the
  // full url set: with an INCOMPLETE Reader sweep and no Reader entry for a Reader source,
  // `readwiseUrlsOf` is missing the Reader url, and "repairing" would silently drop a healthy link.
  // Same reason the link and location diffs are gated on being KNOWN this run.
  const readwiseKnown = !(source.external_id ?? '').trim() || ctx.readerComplete || !!readerInfoOf(source, ctx);
  if (readwiseKnown) {
    const wantUrls = readwiseUrlsOf(source, ctx);
    heal(
      'readwise',
      await slotHealth(plugin, cache, es.rem, SOURCE_SLOTS.readwiseUrl, {
        wantNonEmpty: wantUrls.length > 0,
        wantCount: wantUrls.length,
      }),
      displayValue(wantUrls.join(', '))
    );
  }
  const wantCover = (source.cover_image_url ?? '').trim();
  heal('cover', await slotHealth(plugin, cache, es.rem, SOURCE_SLOTS.cover, { wantNonEmpty: !!wantCover }), displayValue(wantCover));

  return changes;
}

// ───────────────────────── Compute plan ─────────────────────────

export async function computeSyncPlan(
  plugin: RNPlugin,
  sources: ReadwiseSource[],
  ctx: SyncContext,
  log?: SyncLog
): Promise<SyncPlan> {
  log?.section('Compute sync plan (add-only)');
  // Duplicate lookup rems are DETECTED here and folded only if the user ticks the row. Computing a plan
  // is a PREVIEW and must not write — and folding one moves children (possibly the user's own notes),
  // rewrites every rem in the KB that references it, and deletes it.
  const toFoldLookupDuplicates = await findLookupDuplicates(plugin, log);

  // SUPPLEMENT DOCUMENTS: a doc holding a supplemental's highlights because its main source wasn't in
  // RemNote when they were copied (and every doc an older version created for a supplemental — same
  // thing). They are excluded from the main-source candidates below, and once their main source exists
  // the sync stages a merge. See the two declarations below for how one is identified.
  const supplementalBookIds = new Set(sources.filter(isSupplemental).map((s) => s.user_book_id));
  /** EVERY supplement document, however identified — excluded from main-source candidates, suffixed,
   *  and swept for merging. Detected by its stored Category as well as by the fetch, so a supplemental
   *  deleted from Readwise can't turn its holding doc back into a main-source candidate (which would
   *  collide with the real document and churn its name). */
  const allSupplementDocs: ExistingSource[] = ctx.existingSources.filter(
    (es) =>
      supplementalBookIds.has(es.userBookId) ||
      isSupplementDocCategory(es.category) ||
      // Third signal, and the only one that cannot go blank: the name WE gave it. Needed when the
      // supplemental has left the export AND the Category reference no longer resolves. It must match
      // EXACTLY the name we would have generated — otherwise a real book actually titled
      // "Dune - Supplement" is mistaken for a holding document, gets the suffix appended a second time,
      // and is renamed on every single sync (verified 2026-09-05).
      nameIsGeneratedSupplementName(es)
  );
  const supplementDocRemIds = new Set(allSupplementDocs.map((es) => es.rem._id));
  /** book id → the OLDEST holding doc for it (oldest-wins, like `sourceByBookId`): with a cross-device
   *  duplicate, every copy is still excluded above, so one can never become the other's merge target. */
  const supplementDocs = new Map<number, ExistingSource>();
  for (const es of allSupplementDocs) {
    if (!supplementalBookIds.has(es.userBookId)) continue;
    const prev = supplementDocs.get(es.userBookId);
    if (!prev || es.rem.createdAt < prev.rem.createdAt) supplementDocs.set(es.userBookId, es);
  }

  const pendingNew: {
    source: ReadwiseSource;
    eligible: ReadwiseHighlight[];
    supplements: ReadwiseHighlight[];
    /** A supplement document is waiting for this source to exist so it can be folded into it — so the
     *  document must be created even with nothing of its own to put in it, or neither ever converges. */
    needed?: boolean;
  }[] = [];
  const existingTouched: { es: ExistingSource; source: ReadwiseSource; eligible: ReadwiseHighlight[] }[] = [];
  const supplementals: { source: ReadwiseSource; eligible: ReadwiseHighlight[] }[] = [];
  let matchingHighlights = 0;
  let excludedByCategory = 0;

  for (const s of sources) {
    if (s.is_deleted) continue;
    if (!matchesCategoryFilter(s, ctx.included)) {
      excludedByCategory += 1;
      continue;
    }
    // A highlight is eligible if its OWN tags match, OR the SOURCE carries a matching book_tag (then
    // ALL its highlights come along).
    const wholeSource = sourceMatchesTagFilter(s, ctx.tagList);
    const eligible = (s.highlights ?? []).filter(
      (h) => !h.is_deleted && (wholeSource || matchesTagFilter(h, ctx.tagList))
    );
    matchingHighlights += eligible.length;
    // A supplemental is routed to its main source below — or, failing that, to a document of its own.
    if (isSupplemental(s)) {
      if (eligible.length) supplementals.push({ source: s, eligible });
      continue;
    }
    const es = ctx.sourceByBookId.get(s.user_book_id);
    // Note: a source with no eligible highlights is still a candidate — it may earn a document from
    // its supplements alone. Only entries with content are emitted as creates below.
    if (!es) pendingNew.push({ source: s, eligible, supplements: [] });
    else existingTouched.push({ es, source: s, eligible });
  }

  // What Readwise says about each existing doc THIS run — fresher than its stored slots, and what the
  // naming + the supplement join must both use, or a renamed source stops matching.
  const fetchedByRem = new Map<string, ReadwiseSource>(existingTouched.map((t) => [t.es.rem._id, t.source]));
  const mainTitleAuthorOf = (es: ExistingSource): [string, string] => {
    const f = fetchedByRem.get(es.rem._id);
    return f ? [baseTitleOf(f), (f.author ?? '').trim()] : [es.baseTitle, es.author];
  };

  // ── Join each supplemental to its MAIN source: exact title+author, else a UNIQUE title-only match.
  // Candidates are existing docs (excluding supplement docs) plus the sources being created this run.
  type MainTarget = { es: ExistingSource } | { pending: (typeof pendingNew)[number] };
  const byTitleAuthor = new Map<string, MainTarget[]>();
  const byTitle = new Map<string, MainTarget[]>();
  const indexMain = (title: string, author: string, target: MainTarget): void => {
    for (const [m, k] of [
      [byTitleAuthor, titleAuthorKey(title, author)],
      [byTitle, titleOnlyKey(title)],
    ] as [Map<string, MainTarget[]>, string][]) {
      const arr = m.get(k);
      if (arr) arr.push(target);
      else m.set(k, [target]);
    }
  };
  for (const es of ctx.existingSources)
    if (!supplementDocRemIds.has(es.rem._id)) indexMain(...mainTitleAuthorOf(es), { es });
  for (const p of pendingNew) indexMain(baseTitleOf(p.source), (p.source.author ?? '').trim(), { pending: p });

  /** Every highlight id recorded by ANY document, built once on first use. Used only as the safety net
   *  above — never for ordinary dedup, which stays per-document by design. */
  let allLedgerIds: Set<string> | undefined;
  const anyLedgerHas = (id: string): boolean => {
    if (!allLedgerIds) {
      allLedgerIds = new Set<string>();
      for (const es of ctx.existingSources) for (const hid of es.ledger) allLedgerIds.add(hid);
    }
    return allLedgerIds.has(id);
  };

  /** Supplement highlights to append under an EXISTING main doc's `Supplements` header. */
  const supplementsByRemId = new Map<string, { es: ExistingSource; highlights: ReadwiseHighlight[] }>();
  /** New highlights for a supplement DOCUMENT that is still waiting for its main source. */
  const supplementDocAdds = new Map<string, { es: ExistingSource; highlights: ReadwiseHighlight[] }>();
  /** Supplement documents whose main source now EXISTS — fold them in. */
  const toMergeSupplementDocs: SupplementMerge[] = [];
  /** Supplementals with no main source and no document yet — give them one to hold the highlights. */
  const newSupplementDocs: { source: ReadwiseSource; eligible: ReadwiseHighlight[] }[] = [];

  for (const { source, eligible } of supplementals) {
    const title = baseTitleOf(source);
    const author = (source.author ?? '').trim();
    const exact = byTitleAuthor.get(titleAuthorKey(title, author)) ?? [];
    const loose = byTitle.get(titleOnlyKey(title)) ?? [];
    const candidates = exact.length ? exact : loose.length === 1 ? loose : [];
    // Deterministic pick: an existing doc that ALREADY holds some of these supplement ids wins (so a
    // second doc for the same book can never get a duplicate copy), else the OLDEST existing doc — the
    // same oldest-wins rule `sourceByBookId` uses. `Sources/` child order is newest-first and shifts
    // whenever a doc is created, so it must never decide this.
    const existingCands = candidates
      .filter((c): c is { es: ExistingSource } => 'es' in c)
      .sort((a, b) => a.es.rem.createdAt - b.es.rem.createdAt);
    // Stepwise rather than a `??` chain: `existingCands[0]` is typed as always-defined (index access
    // isn't checked), which would collapse the union and make the pending branch look unreachable.
    let target: MainTarget | undefined = existingCands.find((c) =>
      eligible.some((h) => c.es.ledger.has(String(h.id)))
    );
    if (!target && existingCands.length) target = existingCands[0];
    if (!target && candidates.length) target = candidates[0];

    // This supplemental's own document, if one was created on an earlier run (or by an older version).
    const suppDoc = supplementDocs.get(source.user_book_id);

    if (target && 'es' in target) {
      // The main document exists. Fold in any holding document, and append whatever is still missing.
      if (suppDoc) {
        toMergeSupplementDocs.push({
          id: `mg:${suppDoc.rem._id}`,
          supplementName: suppDoc.name,
          supplementRem: suppDoc.rem,
          supplementBookId: suppDoc.userBookId,
          targetName: target.es.name,
          targetRem: target.es.rem,
          ledgerCount: suppDoc.ledger.size,
        });
      }
      // While a holding doc is being folded in THIS run, append nothing to the main doc: let the fold
      // move the real bullets, and append whatever is still missing on the NEXT run. Two reasons — and
      // one non-reason, stated plainly:
      //   • ordering: the fold appends below whatever `applyAddSupplements` already wrote, so appending
      //     first would put the newest highlights ABOVE the folded ones.
      //   • one writer per `Supplements` rem per apply, which is far easier to reason about.
      //   • NOT a duplication fix. A bullet the holding doc holds but never recorded is invisible to
      //     both designs: appending now duplicates it now, deferring duplicates it next run. What
      //     actually keeps that set empty is the strict `readLedger` and the small LEDGER_CHECKPOINT.
      if (suppDoc) continue;
      // Hoisted: `target` is a `let`, so TS drops its narrowing inside a closure.
      const mainDoc = target.es;
      const fresh = eligible.filter((h) => !mainDoc.ledger.has(String(h.id)));
      if (!fresh.length) continue;
      const cur = supplementsByRemId.get(mainDoc.rem._id);
      if (cur) cur.highlights.push(...fresh);
      else supplementsByRemId.set(mainDoc.rem._id, { es: mainDoc, highlights: fresh });
      continue;
    }

    if (target) {
      // The main source is being CREATED this run: attach what the holding doc doesn't already have.
      // No merge is staged — its target rem doesn't exist yet — so the NEXT sync folds the holding
      // document in, once the main document is real. Converges in two runs, with nothing duplicated.
      if (suppDoc) target.pending.needed = true;
      const fresh = suppDoc ? eligible.filter((h) => !suppDoc.ledger.has(String(h.id))) : eligible;
      if (fresh.length) target.pending.supplements.push(...fresh);
      continue;
    }

    // No main source anywhere: hold the highlights in a supplement document of their own.
    if (suppDoc) {
      const fresh = eligible.filter((h) => !suppDoc.ledger.has(String(h.id)));
      if (fresh.length) supplementDocAdds.set(suppDoc.rem._id, { es: suppDoc, highlights: fresh });
    } else {
      // Narrow exception to per-source dedup (see the design note: highlights are otherwise deduped per
      // document ON PURPOSE). A supplemental's join is title+author, so a title edit in Readwise breaks
      // it — and an already-folded supplemental would then be copied wholesale into a NEW holding doc,
      // duplicating highlights that are sitting in the main document already. Only start holding a
      // highlight that no document anywhere has recorded.
      const unseen = eligible.filter((h) => !anyLedgerHas(String(h.id)));
      if (!unseen.length) {
        log?.log(
          'plan',
          `  supplement "${title}": no main source matched (its title may have changed in Readwise), but every highlight is already recorded elsewhere — nothing to do.`
        );
        continue;
      }
      newSupplementDocs.push({ source, eligible: unseen });
      log?.log(
        'plan',
        `  supplement "${title}": no main source yet — will be held in its own "${SUPPLEMENT_DOC_SUFFIX.trim()}" document and merged when the source appears.`
      );
    }
  }

  // A supplement document whose supplemental contributed nothing THIS run — every one of its highlights
  // filtered out by the tag filter, say — still deserves folding in once its main source exists, or it
  // would linger forever. Match it on its OWN stored title + author and stage those merges too.
  const alreadyMerging = new Set(toMergeSupplementDocs.map((m) => m.supplementRem._id));
  // Also by BOOK ID: a cross-device race can leave two holding docs for one supplemental, holding the
  // same bullets. Folding both into the same main doc would move that content in twice, so only the
  // one already staged (the oldest) is folded; the other is left for the user, who is warned by the
  // "two source docs share Readwise book id" line the scan emits.
  const mergingBookIds = new Set(toMergeSupplementDocs.map((m) => m.supplementBookId));
  for (const es of allSupplementDocs) {
    if (alreadyMerging.has(es.rem._id)) continue;
    if (mergingBookIds.has(es.userBookId)) {
      log?.log(
        'plan',
        `  a second holding document for Readwise book id ${es.userBookId} ("${es.name}") is NOT being folded in — it would move the same bullets twice; delete it by hand once the first has merged.`
      );
      continue;
    }
    const exact = byTitleAuthor.get(titleAuthorKey(es.baseTitle, es.author)) ?? [];
    const loose = byTitle.get(titleOnlyKey(es.baseTitle)) ?? [];
    const cands = exact.length ? exact : loose.length === 1 ? loose : [];
    const main = cands
      .filter((c): c is { es: ExistingSource } => 'es' in c)
      .sort((a, b) => a.es.rem.createdAt - b.es.rem.createdAt)[0];
    if (!main) {
      // No existing main — but if exactly one is being CREATED this run, mark it needed so it gets a
      // document even with nothing of its own. Otherwise it is never created, so the sweep never finds
      // it, and this holding document is stranded for good.
      const pendings = cands.filter((c): c is { pending: (typeof pendingNew)[number] } => !('es' in c));
      if (pendings.length === 1) pendings[0].pending.needed = true;
      continue;
    }
    toMergeSupplementDocs.push({
      id: `mg:${es.rem._id}`,
      supplementName: es.name,
      supplementRem: es.rem,
      supplementBookId: es.userBookId,
      targetName: main.es.name,
      targetRem: main.es.rem,
      ledgerCount: es.ledger.size,
    });
    mergingBookIds.add(es.userBookId);
  }

  // Only sources with content (own highlights or supplements) become documents.
  const creating = pendingNew.filter((p) => p.eligible.length > 0 || p.supplements.length > 0 || p.needed);
  // Docs about to be folded in are excluded from naming: they are deleted by the merge, so renaming
  // them first would be pure churn (and they share their main doc's title+author).
  const mergingRemIds = new Set(toMergeSupplementDocs.map((m) => m.supplementRem._id));
  // A doc whose Author reference dangles and which Readwise did NOT return this run has no trustworthy
  // author, so its desired name can't be computed — leave its name alone rather than strip the author.
  const namingSkipRemIds = new Set(mergingRemIds);
  for (const es of ctx.existingSources)
    if (es.authorDangling && !fetchedByRem.has(es.rem._id)) {
      namingSkipRemIds.add(es.rem._id);
      log?.log('plan', `Leaving "${es.name}" un-renamed: its Author reference no longer resolves (restore or re-sync that source to fix the title).`);
    }
  const newSupplementBookIds = new Set(newSupplementDocs.map((n) => n.source.user_book_id));
  const { existingName, newName } = await computeDisplayNames(
    plugin,
    ctx,
    [...creating.map((p) => p.source), ...newSupplementDocs.map((n) => n.source)],
    namingSkipRemIds,
    fetchedByRem,
    supplementDocRemIds,
    newSupplementBookIds,
    log
  );

  const nameForNew = (source: ReadwiseSource, isSupplementDoc: boolean): string =>
    newName.get(source.user_book_id) ??
    displayBase(baseTitleOf(source), (source.author ?? '').trim()) + (isSupplementDoc ? SUPPLEMENT_DOC_SUFFIX : '');

  const toCreateSources: SourceCreateEntry[] = [
    ...creating.map(({ source, eligible, supplements }) => ({
      id: `sc:${source.user_book_id}`,
      userBookId: source.user_book_id,
      name: nameForNew(source, false),
      categoryLabel: categoryLabelOf(source),
      source,
      eligible,
      supplements,
      isSupplementDoc: false,
    })),
    // Supplement documents: the supplemental's highlights are the document's OWN bullets (the whole
    // document is the supplement), so a later merge can move them straight into the main doc.
    ...newSupplementDocs.map(({ source, eligible }) => ({
      id: `sc:${source.user_book_id}`,
      userBookId: source.user_book_id,
      name: nameForNew(source, true),
      categoryLabel: categoryLabelOf(source),
      source,
      eligible,
      supplements: [] as ReadwiseHighlight[],
      isSupplementDoc: true,
    })),
  ];

  const toUpdateSources: SourceUpdateEntry[] = [];
  const toAddHighlights: SourceAddHighlights[] = [];
  const alreadyInSync: KeptEntry[] = [];
  const touchedRemIds = new Set<string>();

  for (const { es, source, eligible } of existingTouched) {
    touchedRemIds.add(es.rem._id);
    const changes = await diffSource(plugin, ctx, es, source, existingName.get(es.rem._id));
    if (changes.length) toUpdateSources.push({ id: `su:${es.rem._id}`, name: es.name, rem: es.rem, source, changes });
    const newHls = eligible.filter((h) => !es.ledger.has(String(h.id)));
    if (newHls.length)
      toAddHighlights.push({ id: `ha:${es.rem._id}`, sourceRemId: es.rem._id, name: es.name, rem: es.rem, highlights: newHls });
    if (!changes.length && !newHls.length && !supplementsByRemId.has(es.rem._id))
      alreadyInSync.push({ id: `k:${es.rem._id}`, name: es.name });
    await yieldToHost(); // the repair pass added slot reads per source; keep the iframe breathing
  }

  // A supplement document still waiting for its main source gains its new highlights as ordinary
  // bullets (it is never in `existingTouched`, so these ids can't clash).
  for (const { es, highlights } of supplementDocAdds.values())
    toAddHighlights.push({ id: `ha:${es.rem._id}`, sourceRemId: es.rem._id, name: es.name, rem: es.rem, highlights });

  const toAddSupplements: SupplementAddEntry[] = [...supplementsByRemId.values()].map(({ es, highlights }) => ({
    id: `hs:${es.rem._id}`,
    name: es.name,
    rem: es.rem,
    highlights,
  }));

  // Existing docs NOT touched above (absent from the fetch, category-excluded, or deleted on the
  // Readwise side) can still need two Readwise-independent updates: a symmetric RENAME (this is also
  // what migrates every old `Title` doc to `Author - Title`) and a Reader LOCATION move. `source` is
  // undefined on these rows; applyUpdate writes `toDisplay` verbatim for both fields. Docs being
  // folded in are skipped — the merge deletes them.
  for (const es of ctx.existingSources) {
    if (touchedRemIds.has(es.rem._id) || mergingRemIds.has(es.rem._id)) continue;
    const changes: FieldChange[] = [];
    const desiredName = existingName.get(es.rem._id);
    if (desiredName && nameKey(es.name) !== nameKey(desiredName))
      changes.push({ field: 'name', fromDisplay: es.name || UNTITLED, toDisplay: desiredName });
    const info = es.externalId ? ctx.readerByExternalId.get(es.externalId) : undefined;
    if (info) {
      const label = locationLabelOf(info.location);
      const curLoc = await slotToComparable(plugin, ctx.refNameCache, await getSlotRichText(es.rem, SOURCE_SLOTS.location));
      if (nameKey(curLoc) !== nameKey(label))
        changes.push({ field: 'location', fromDisplay: displayValue(curLoc), toDisplay: label });
    }
    if (changes.length)
      toUpdateSources.push({ id: `su:${es.rem._id}`, name: es.name, rem: es.rem, source: undefined, changes });
  }

  log?.log(
    'plan',
    `Plan: ${toCreateSources.length} create (${newSupplementDocs.length} supplement doc(s)), ` +
      `${toUpdateSources.length} source update(s), ` +
      `${toAddHighlights.reduce((n, g) => n + g.highlights.length, 0)} highlight(s) to add, ` +
      `${toAddSupplements.reduce((n, g) => n + g.highlights.length, 0)} supplement(s) to add, ` +
      `${toMergeSupplementDocs.length} supplement doc(s) to merge, ${toFoldLookupDuplicates.length} duplicate lookup rem(s), ` +
      `${alreadyInSync.length} in sync.`
  );
  return {
    toCreateSources,
    toUpdateSources,
    toAddHighlights,
    toAddSupplements,
    toMergeSupplementDocs,
    toFoldLookupDuplicates,
    alreadyInSync,
    fetchedSources: sources.length,
    matchingHighlights,
    excludedByCategory,
    orphanDocNames: ctx.orphanDocNames,
  };
}

// ───────────────────────── Apply ─────────────────────────

/** The user's per-row selection from the preview. */
export interface ApplySelection {
  toCreateSources: SourceCreateEntry[];
  toUpdateSources: { entry: SourceUpdateEntry; fields: Set<UpdatableField> }[];
  toAddHighlights: { entry: SourceAddHighlights; highlightIds: Set<number> }[];
  toAddSupplements: { entry: SupplementAddEntry; highlightIds: Set<number> }[];
  toMergeSupplementDocs: SupplementMerge[];
  toFoldLookupDuplicates: LookupDuplicate[];
}

export interface ApplyCallbacks {
  onItemDone?: (id: string, ok: boolean) => void;
}

/** Write the changed slots for an existing source. */
async function applyUpdate(
  plugin: RNPlugin,
  ctx: SyncContext,
  entry: SourceUpdateEntry,
  fields: Set<UpdatableField>,
  syncedAt: number
): Promise<void> {
  const { rem, source } = entry;
  for (const change of entry.changes) {
    if (!fields.has(change.field)) continue;
    switch (change.field) {
      case 'name':
        await rem.setText([change.toDisplay]);
        break;
      case 'author':
        if (source) await writeAuthor(plugin, ctx, rem, (source.author ?? '').trim());
        break;
      case 'category':
        if (source) await writeCategory(plugin, ctx, rem, categoryLabelOf(source));
        break;
      case 'location':
        // location-only entries carry the label in toDisplay (source is undefined).
        await writeLocation(plugin, ctx, rem, source ? desiredLocation(source, ctx).label : change.toDisplay);
        break;
      case 'link':
        if (source) await writeLink(plugin, rem, linkOf(source, ctx));
        break;
      // Reached only by the repair pass in diffSource (never value-diffed): rewrite the slot from
      // scratch, which mints fresh link rems for the urls and re-points the property at them.
      case 'readwise':
        if (source) await writeReadwiseUrls(plugin, rem, readwiseUrlsOf(source, ctx));
        break;
      case 'cover':
        if (source) await writeCover(plugin, rem, (source.cover_image_url ?? '').trim());
        break;
    }
  }
  // Re-seed the RAW title on any update that carries a source (not just a rename): the display name is
  // derived from this slot, so letting it drift makes the name-parsing fallback in the scan compound an
  // old author into the title.
  if (source) await setProp(rem, SOURCE_SLOTS.baseTitle, [baseTitleOf(source)]);
  await setProp(rem, SOURCE_SLOTS.lastSyncedAt, [String(syncedAt)]);
}

/** Create one source doc + its eligible highlights; ledger holds only the highlights that succeeded.
 *  Returns the number of highlights that FAILED (left out of the ledger → re-staged next run).
 *  Order matters: the doc is parented under Sources/ and given its IDENTITY (powerup + userBookId)
 *  before anything else, so a failure part-way leaves a doc the next scan recognises — never a
 *  same-titled duplicate. On any failure the half-built doc is ROLLED BACK (removed; best effort — it
 *  sits under the Readwise root, which the manifest's Delete scope covers) so the create retries
 *  cleanly next run instead of leaving an orphan or double-copying highlights. This rollback of a doc
 *  created seconds earlier in the same failed operation is the one deliberate exception to add-only. */
async function createSourceDoc(
  plugin: RNPlugin,
  ctx: SyncContext,
  entry: SourceCreateEntry,
  parent: PluginRem,
  powerupRem: PluginRem,
  syncedAt: number,
  log?: SyncLog
): Promise<number> {
  const s = entry.source;
  const rem = await plugin.rem.createRem();
  if (!rem) throw new Error('createRem returned undefined for a source');
  const added = new Set<string>();
  try {
    // Parent FIRST: under Sources/ (→ the Readwise root) the doc is deletable, so the rollback below
    // can always clean up — a bare createRem() lives outside the manifest's Delete scope.
    await rem.setParent(parent, 0); // newest-first
    await rem.setText([entry.name]);
    await rem.addTag(powerupRem._id);
    await setProp(rem, SOURCE_SLOTS.userBookId, [String(s.user_book_id)]);
    await setProp(rem, SOURCE_SLOTS.baseTitle, [baseTitleOf(s)]);
    if (s.external_id) await setProp(rem, SOURCE_SLOTS.externalId, [s.external_id]);
    await rem.setIsDocument(true);

    await writeAuthor(plugin, ctx, rem, (s.author ?? '').trim());
    await writeCategory(plugin, ctx, rem, categoryLabelOf(s));
    // An unknown location (Reader sweep incomplete this run) is left EMPTY so the next complete
    // sweep's diff fills it in — it is never asserted as "Not in Reader".
    const loc = desiredLocation(s, ctx);
    if (loc.known) await writeLocation(plugin, ctx, rem, loc.label);
    await writeLink(plugin, rem, linkOf(s, ctx));
    await writeReadwiseUrls(plugin, rem, readwiseUrlsOf(s, ctx));
    await writeCover(plugin, rem, (s.cover_image_url ?? '').trim());

    // Everything below is appended at an EXPLICIT position: setParent prepends by default, which
    // would reverse Readwise's order and put the body below the highlights.
    let pos = (await rem.getChildrenRem()).length;

    // Write-once body: summary then document_note (the fresh doc has no other body children yet).
    // Skipped for a supplement document: those bullets would be reparented into the main document's
    // Supplements section by the merge, masquerading as highlights next to the real summary.
    if (!entry.isSupplementDoc) {
      const summary = (s.summary ?? '').trim();
      if (summary) await appendBodyBullet(plugin, rem, summary, pos++);
      const docNote = (s.document_note ?? '').trim();
      if (docNote) await appendBodyBullet(plugin, rem, docNote, pos++);
    }

    let hlFailed = 0;
    let sinceCheckpoint = 0;
    for (const h of entry.eligible) {
      try {
        await addHighlight(plugin, rem, h, ctx.applyColors, pos, log);
        pos += 1; // only on success — a failed highlight removes itself, so the position is unchanged
        added.add(String(h.id));
        sinceCheckpoint += 1;
      } catch (err) {
        hlFailed += 1;
        log?.log('apply', `  highlight ${h.id} failed (will retry next run): ${errMsg(err)}`);
      }
      // OUTSIDE the per-highlight try: a failed checkpoint is not a failed highlight (the bullet is
      // written and in `added`), and counting it as one tells the user to retry work that succeeded.
      if (sinceCheckpoint >= LEDGER_CHECKPOINT) {
        try {
          await writeLedger(rem, added, log);
          sinceCheckpoint = 0;
        } catch (err) {
          log?.log('apply', `  ledger checkpoint failed (${errMsg(err)}) — retrying at the next one.`);
        }
      }
      await yieldToHost(); // breathe between highlights too — one big book is otherwise a tight burst
    }

    // Supplemental highlights (Readwise's curated popular highlights for this source) go under a
    // `Supplements` header-1 rem at the bottom — never in a document of their own.
    if (entry.supplements.length) {
      const supRem = await ensureSupplementsRem(plugin, rem, log);
      let supPos = (await supRem.getChildrenRem()).length;
      for (const h of entry.supplements) {
        try {
          await addHighlight(plugin, supRem, h, ctx.applyColors, supPos, log);
          supPos += 1;
          added.add(String(h.id));
          sinceCheckpoint += 1;
        } catch (err) {
          hlFailed += 1;
          log?.log('apply', `  supplement ${h.id} failed (will retry next run): ${errMsg(err)}`);
        }
        // OUTSIDE the try, as in the own-highlight loop: a failed checkpoint is not a failed supplement.
        if (sinceCheckpoint >= LEDGER_CHECKPOINT) {
          try {
            await writeLedger(rem, added, log);
            sinceCheckpoint = 0;
          } catch (err) {
            log?.log('apply', `  ledger checkpoint failed (${errMsg(err)}) — retrying at the next one.`);
          }
        }
        await yieldToHost();
      }
    }
    await writeLedger(rem, added, log);
    await setProp(rem, SOURCE_SLOTS.lastSyncedAt, [String(syncedAt)]);
    await makeIncremental(plugin, rem, ctx, log);
    return hlFailed;
  } catch (err) {
    try {
      // remove() DOES cascade inside the manifest's delete scope — verified 2026-09-05 by removing a
      // real source document: its highlight bullet, that bullet's note child and all seven property
      // rems were gone afterwards. (An earlier note here claimed the opposite; that probe had used a
      // TOP-LEVEL rem, which the plugin is not permitted to delete at all, so the parent survived and
      // its intact child was misread as an orphan.) The doc is under Sources/ by this point, so one
      // remove() takes the half-built tree with it.
      await rem.remove();
      log?.log('apply', `  rolled back the half-created doc for "${entry.name}" — the create will retry next run.`);
    } catch (rmErr) {
      // Couldn't remove it. If it already holds copied highlights, record them so the next run adds
      // only what's missing instead of duplicating every highlight.
      if (added.size) await writeLedger(rem, added, log).catch(() => undefined);
      log?.log('apply', `  could NOT roll back the half-created doc for "${entry.name}" (${errMsg(rmErr)}) — it may linger (under Sources/ if it got that far, otherwise as a stray top-level rem); delete it by hand.`);
    }
    throw err;
  }
}

/** Append selected new highlights to an existing source; grow its ledger with only the ones that wrote. */
async function applyAddHighlights(
  plugin: RNPlugin,
  rem: PluginRem,
  highlights: ReadwiseHighlight[],
  syncedAt: number,
  applyColor: boolean,
  log?: SyncLog
): Promise<{ added: number; failed: number }> {
  const ledger = await readLedger(rem, log);
  // Append at the end but ABOVE the `Supplements` header, so that section stays last. Inserting at a
  // fixed index shifts the header right each time, keeping both orders correct.
  let pos = await ownHighlightStart(rem);
  let added = 0;
  let failed = 0;
  let sinceCheckpoint = 0;
  for (const h of highlights) {
    if (ledger.has(String(h.id))) continue;
    try {
      await addHighlight(plugin, rem, h, applyColor, pos, log);
      pos += 1;
      ledger.add(String(h.id));
      added += 1;
      sinceCheckpoint += 1;
    } catch (err) {
      failed += 1;
      log?.log('apply', `  highlight ${h.id} failed (will retry next run): ${errMsg(err)}`);
    }
    // OUTSIDE the try: a failed checkpoint is not a failed highlight.
    if (sinceCheckpoint >= LEDGER_CHECKPOINT) {
      try {
        await writeLedger(rem, ledger, log);
        sinceCheckpoint = 0;
      } catch (err) {
        log?.log('apply', `  ledger checkpoint failed (${errMsg(err)}) — retrying at the next one.`);
      }
    }
    await yieldToHost(); // breathe between highlights too — one big source is otherwise a tight burst
  }
  try {
    await writeLedger(rem, ledger, log);
  } catch (err) {
    // The highlights ARE in RemNote but (up to LEDGER_CHECKPOINT-1 of them) not recorded — say so.
    log?.log('apply', `  WARNING: the ledger for this source could not be written (${errMsg(err)}); up to ${sinceCheckpoint} just-added highlight(s) are unrecorded and would be re-added (duplicated) next run — delete the last ${sinceCheckpoint} bullet(s) first, or re-run and remove the duplicates.`);
    throw err;
  }
  await setProp(rem, SOURCE_SLOTS.lastSyncedAt, [String(syncedAt)]);
  return { added, failed };
}

/** Append supplemental highlights under an EXISTING source doc's `Supplements` header (created on
 *  first use, as the last child). They share the source's ledger — Readwise highlight ids are unique,
 *  so one ledger covers the doc's own highlights and its supplements. */
async function applyAddSupplements(
  plugin: RNPlugin,
  rem: PluginRem,
  highlights: ReadwiseHighlight[],
  syncedAt: number,
  applyColor: boolean,
  log?: SyncLog
): Promise<{ added: number; failed: number }> {
  const ledger = await readLedger(rem, log);
  const supRem = await ensureSupplementsRem(plugin, rem, log);
  let pos = (await supRem.getChildrenRem()).length; // new supplements go at the BOTTOM of the section
  let added = 0;
  let failed = 0;
  let sinceCheckpoint = 0;
  for (const h of highlights) {
    if (ledger.has(String(h.id))) continue;
    try {
      await addHighlight(plugin, supRem, h, applyColor, pos, log);
      pos += 1;
      ledger.add(String(h.id));
      added += 1;
      sinceCheckpoint += 1;
    } catch (err) {
      failed += 1;
      log?.log('apply', `  supplement ${h.id} failed (will retry next run): ${errMsg(err)}`);
    }
    // OUTSIDE the try: a failed checkpoint is not a failed supplement.
    if (sinceCheckpoint >= LEDGER_CHECKPOINT) {
      try {
        await writeLedger(rem, ledger, log);
        sinceCheckpoint = 0;
      } catch (err) {
        log?.log('apply', `  ledger checkpoint failed (${errMsg(err)}) — retrying at the next one.`);
      }
    }
    await yieldToHost();
  }
  try {
    await writeLedger(rem, ledger, log);
  } catch (err) {
    log?.log('apply', `  WARNING: the ledger for this source could not be written (${errMsg(err)}); up to ${sinceCheckpoint} just-added supplement(s) are unrecorded and would be re-added (duplicated) next run — delete the last ${sinceCheckpoint} bullet(s) under Supplements first.`);
    throw err;
  }
  await setProp(rem, SOURCE_SLOTS.lastSyncedAt, [String(syncedAt)]);
  return { added, failed };
}

/**
 * Apply the selection. Order: update sources → add highlights → add supplements → create sources. Aborts up-front (zero
 * changes) if the powerup isn't registered (plugin not reloaded). Per-row `onItemDone` for progress.
 * `failed` counts ROWS that threw; `highlightsFailed` counts individual highlights that failed inside
 * an otherwise-successful row (left out of the ledger, so the next sync re-stages them).
 */
export async function applySyncPlan(
  plugin: RNPlugin,
  selection: ApplySelection,
  ctx: SyncContext,
  callbacks: ApplyCallbacks = {},
  log?: SyncLog
): Promise<{
  created: number;
  updated: number;
  highlightsAdded: number;
  supplementsAdded: number;
  highlightsFailed: number;
  /** Supplement documents folded into their main document (and deleted). */
  mergedDocs: number;
  /** Duplicate lookup rems folded into their canonical twin (and deleted). */
  foldedLookups: number;
  failed: number;
}> {
  const onItemDone = callbacks.onItemDone ?? (() => {});
  const powerupRem = await plugin.powerup.getPowerupByCode(SOURCE_POWERUP);
  if (!powerupRem) {
    const msg =
      'Readwise Source powerup is not registered — reload the plugin (toggle it off/on in Settings → ' +
      'Plugins → Build) and try again. No changes were made.';
    log?.log('apply', `ERROR (precondition): ${msg}`);
    throw new Error(msg);
  }

  const syncedAt = Date.now();
  let created = 0;
  let updated = 0;
  let highlightsAdded = 0;
  let supplementsAdded = 0;
  let highlightsFailed = 0;
  let mergedDocs = 0;
  let merged = 0;
  let foldedLookups = 0;
  let failed = 0;

  log?.section('Apply');

  // Housekeeping FIRST, but only for the rows the user ticked: fold same-name duplicate lookup rems so
  // the writes below reference one canonical rem each. The lookup caches were filled while planning
  // against the pre-fold tree, so drop them — a cached entry could point at a rem this just removed.
  if (selection.toFoldLookupDuplicates.length) {
    for (const dup of selection.toFoldLookupDuplicates) {
      try {
        await foldLookupDuplicate(plugin, dup, log);
        foldedLookups += 1;
        onItemDone(dup.id, true);
      } catch (err) {
        failed += 1;
        log?.log('apply', `FOLD FAILED for duplicate "${dup.name}" under ${dup.docName}: ${errMsg(err)}`);
        onItemDone(dup.id, false);
      }
      await yieldToHost();
    }
    ctx.lookupCache.clear();
    ctx.childNameMaps.clear();
  }


  for (const { entry, fields } of selection.toUpdateSources) {
    try {
      await applyUpdate(plugin, ctx, entry, fields, syncedAt);
      updated += 1;
      onItemDone(entry.id, true);
    } catch (err) {
      failed += 1;
      log?.log('apply', `UPDATE FAILED for ${entry.name}: ${errMsg(err)}`);
      onItemDone(entry.id, false);
    }
    await yieldToHost(); // let the widget iframe paint/GC between items (avoids the OOM frame-crash)
  }

  for (const { entry, highlightIds } of selection.toAddHighlights) {
    try {
      const picked = entry.highlights.filter((h) => highlightIds.has(h.id));
      const { added, failed: hlFailed } = await applyAddHighlights(plugin, entry.rem, picked, syncedAt, ctx.applyColors, log);
      highlightsAdded += added;
      highlightsFailed += hlFailed;
      // An existing source that just gained ≥1 highlight and isn't yet incremental gets enrolled too —
      // same opt-in setting as on create. makeIncremental is idempotent (skips if already tagged) and
      // no-ops when the setting is off / IE isn't installed, and never throws.
      if (added > 0) await makeIncremental(plugin, entry.rem, ctx, log);
      onItemDone(entry.id, true);
    } catch (err) {
      failed += 1;
      log?.log('apply', `ADD-HIGHLIGHTS FAILED for ${entry.name}: ${errMsg(err)}`);
      onItemDone(entry.id, false);
    }
    await yieldToHost(); // let the widget iframe paint/GC between items (avoids the OOM frame-crash)
  }

  for (const { entry, highlightIds } of selection.toAddSupplements) {
    try {
      const picked = entry.highlights.filter((h) => highlightIds.has(h.id));
      const { added, failed: hlFailed } = await applyAddSupplements(plugin, entry.rem, picked, syncedAt, ctx.applyColors, log);
      supplementsAdded += added;
      highlightsFailed += hlFailed;
      // Same enrolment rule as own-highlights: a source that just earned content gets enrolled.
      if (added > 0) await makeIncremental(plugin, entry.rem, ctx, log);
      onItemDone(entry.id, true);
    } catch (err) {
      failed += 1;
      log?.log('apply', `ADD-SUPPLEMENTS FAILED for ${entry.name}: ${errMsg(err)}`);
      onItemDone(entry.id, false);
    }
    await yieldToHost();
  }

  if (selection.toCreateSources.length) {
    const parent = await ensureSourcesParent(plugin);
    for (const entry of selection.toCreateSources) {
      try {
        highlightsFailed += await createSourceDoc(plugin, ctx, entry, parent, powerupRem, syncedAt, log);
        created += 1;
        onItemDone(entry.id, true);
      } catch (err) {
        failed += 1;
        log?.log('apply', `CREATE FAILED for ${entry.name}: ${errMsg(err)}`);
        onItemDone(entry.id, false);
      }
      await yieldToHost(); // let the widget iframe paint/GC between items (avoids the OOM frame-crash)
    }
  }

  // Merges run LAST: a supplement document may be folded into a main document created moments ago in
  // the create phase above.
  for (const move of selection.toMergeSupplementDocs) {
    try {
      merged += await foldSupplementDoc(plugin, move, 'apply', log);
      mergedDocs += 1;
      onItemDone(move.id, true);
    } catch (err) {
      failed += 1;
      log?.log('apply', `MERGE FAILED for "${move.supplementName}": ${errMsg(err)}`);
      onItemDone(move.id, false);
    }
    await yieldToHost();
  }

  log?.log(
    'apply',
    `Done: ${created} created, ${updated} updated, ${highlightsAdded} highlights + ${supplementsAdded} supplement(s) added ` +
      `(${highlightsFailed} failed), ${mergedDocs} supplement doc(s) merged (${merged} bullet(s) moved), ` +
      `${foldedLookups} duplicate lookup rem(s) folded, ${failed} row(s) failed.`
  );
  return { created, updated, highlightsAdded, supplementsAdded, highlightsFailed, mergedDocs, foldedLookups, failed };
}

// ─────────── One-time migration: fold legacy supplemental documents into their main document ───────────
//
// An older version gave every Readwise `supplementals` source its OWN document under `Sources/`.
// Supplements now live under a `Supplements` header-1 rem inside the main source's document, so those
// old documents have to be folded in. The bullets are REPARENTED, never copied — so highlights the
// user has edited, tagged or turned into flashcards keep their identity, history and scheduling.
//
// Titles are NOT migrated here: the normal sync already stages a `name` change for every document
// whose name isn't `Author - Title`, so renaming is previewable and opt-out row by row.
//
// This whole section is temporary — delete it (and the popup's migration panel) once every KB is
// migrated.

/** One supplement document and the main document it will be folded into. Produced by the normal sync
 *  (`toMergeSupplementDocs`) and by the one-time migration panel; applied by `foldSupplementDoc`. */
export interface SupplementMerge {
  id: string; // `mg:<remId>`
  supplementName: string;
  supplementRem: PluginRem;
  /** The Readwise book id it holds — two holding docs sharing one are never folded in the same run. */
  supplementBookId: number;
  targetName: string;
  targetRem: PluginRem;
  /** Non-structural children (highlights + any body bullets) that will move. Omitted by the normal
   *  sync: counting them costs an `isStructuralRem` probe per child, which is far too expensive at plan
   *  time across a whole library. The one-time panel (few docs, no fetch) does count them. */
  bulletCount?: number;
  /** Ledger ids that will be merged into the main document. */
  ledgerCount: number;
}

/** A legacy supplemental document that can't be folded in (left completely untouched). */
export interface MigrationSkip {
  id: string;
  name: string;
  reason: string;
}

export interface MigrationPlan {
  moves: SupplementMerge[];
  skipped: MigrationSkip[];
  /** Source documents scanned, and how many of them are supplemental documents. */
  scanned: number;
  legacy: number;
}

interface MigrationDoc {
  rem: PluginRem;
  userBookId: number;
  name: string;
  baseTitle: string;
  author: string;
  category: string;
  ledger: Set<string>;
}

/** Count the children that would actually move (skipping RemNote's property/slot machinery). */
async function movableChildren(rem: PluginRem): Promise<PluginRem[]> {
  const out: PluginRem[] = [];
  for (const child of await rem.getChildrenRem()) {
    if (await isStructuralRem(child)) continue;
    out.push(child);
  }
  return out;
}

/**
 * Work out which documents under `Sources/` were created for a supplemental (their Category property
 * reads "Supplementals") and which main document each should fold into — matched on title + author,
 * falling back to a unique title-only match. Reads only RemNote: no Readwise API call, so it works
 * offline and can't be affected by a fetch failure. Changes nothing.
 */
export async function planSupplementMigration(plugin: RNPlugin, log?: SyncLog): Promise<MigrationPlan> {
  log?.section('Plan migration (fold supplemental documents)');
  const cache: RefNameCache = new Map();
  const sourcesDoc = await findSourcesParent(plugin);
  if (!sourcesDoc) {
    log?.log('migrate', 'No Readwise/Sources document — nothing to migrate.');
    return { moves: [], skipped: [], scanned: 0, legacy: 0 };
  }

  const legacy: MigrationDoc[] = [];
  const mains: MigrationDoc[] = [];
  for (const child of await sourcesDoc.getChildrenRem()) {
    if (await isStructuralRem(child)) continue;
    if (!(await child.hasPowerup(SOURCE_POWERUP))) continue;
    const name = await remName(plugin, child);
    const author = await slotToComparable(plugin, cache, await getSlotRichText(child, SOURCE_SLOTS.author));
    const category = await slotToComparable(plugin, cache, await getSlotRichText(child, SOURCE_SLOTS.category));
    const storedBase = await getProp(child, SOURCE_SLOTS.baseTitle);
    const baseTitle = storedBase || rawTitleFromName(name, author);
    const ledger = await readLedger(child, log);
    const userBookId = Number(await getProp(child, SOURCE_SLOTS.userBookId));
    const doc: MigrationDoc = {
      rem: child,
      userBookId: Number.isFinite(userBookId) ? userBookId : 0,
      name,
      baseTitle,
      author,
      category,
      ledger,
    };
    if (isSupplementDocCategory(category)) legacy.push(doc);
    else mains.push(doc);
  }

  const byTitleAuthor = new Map<string, MigrationDoc[]>();
  const byTitle = new Map<string, MigrationDoc[]>();
  for (const d of mains) {
    for (const [m, k] of [
      [byTitleAuthor, titleAuthorKey(d.baseTitle, d.author)],
      [byTitle, titleOnlyKey(d.baseTitle)],
    ] as [Map<string, MigrationDoc[]>, string][]) {
      const arr = m.get(k);
      if (arr) arr.push(d);
      else m.set(k, [d]);
    }
  }

  const moves: SupplementMerge[] = [];
  const skipped: MigrationSkip[] = [];
  for (const d of legacy) {
    const exact = byTitleAuthor.get(titleAuthorKey(d.baseTitle, d.author)) ?? [];
    const loose = byTitle.get(titleOnlyKey(d.baseTitle)) ?? [];
    const oldestFirst = (a: MigrationDoc, b: MigrationDoc): number => a.rem.createdAt - b.rem.createdAt;
    const target = [...exact].sort(oldestFirst)[0] ?? (loose.length === 1 ? loose[0] : undefined);
    if (!target || target.rem._id === d.rem._id) {
      skipped.push({
        id: `mg:${d.rem._id}`,
        name: d.name,
        reason: loose.length > 1 ? 'several documents share this title — no unique match' : 'no matching main document',
      });
      continue;
    }
    const bullets = await movableChildren(d.rem);
    moves.push({
      id: `mg:${d.rem._id}`,
      supplementName: d.name,
      supplementRem: d.rem,
      supplementBookId: d.userBookId,
      targetName: target.name,
      targetRem: target.rem,
      bulletCount: bullets.length,
      ledgerCount: d.ledger.size,
    });
  }
  log?.log(
    'migrate',
    `Scanned ${legacy.length + mains.length} source doc(s): ${legacy.length} supplemental, ${moves.length} foldable, ${skipped.length} unmatched.`
  );
  return { moves, skipped, scanned: legacy.length + mains.length, legacy: legacy.length };
}

/**
 * Fold ONE supplement document into its main document: REPARENT every bullet under the main doc's
 * `Supplements` header (created on first use), merge the ledgers, then remove the emptied document.
 * Bullets are MOVED, not copied, so user edits, tags and flashcards keep their rem identity and
 * scheduling. A document that still holds bullets afterwards is LEFT ALONE (never removed). Returns
 * the number of bullets moved; throws if anything fails (the caller counts the row as failed and the
 * document stays put, so the fold is simply retried next run). Shared by the normal sync's
 * `toMergeSupplementDocs` phase and the one-time migration panel.
 */
async function foldSupplementDoc(
  plugin: RNPlugin,
  move: SupplementMerge,
  scope: string,
  log?: SyncLog
): Promise<number> {
  let bullets = 0;
  const supRem = await ensureSupplementsRem(plugin, move.targetRem, log);
  let pos = (await supRem.getChildrenRem()).length; // append below anything already there
  for (const child of await movableChildren(move.supplementRem)) {
    await child.setParent(supRem, pos);
    pos += 1;
    bullets += 1;
    await yieldToHost();
  }

  // Merge ledgers BEFORE removing the document, so a failure can't lose the dedup record. These reads
  // MUST be strict: a swallowed failure would read as an empty ledger, and writing that back would
  // erase the main document's entire dedup record just before the other copy is deleted.
  const targetLedger = await readLedger(move.targetRem, log);
  const suppLedger = await readLedger(move.supplementRem, log);
  for (const id of suppLedger) targetLedger.add(id);
  await writeLedger(move.targetRem, targetLedger, log);

  // Bullets moved but never recorded are the ones the NEXT run can copy again (the deferral this design
  // accepts). Bounded by LEDGER_CHECKPOINT, but say so rather than let it happen silently. A legacy
  // holding doc also carries body bullets, so this can over-report — hence "up to".
  if (bullets > suppLedger.size)
    log?.log(
      scope,
      `  NOTE: "${move.supplementName}" moved ${bullets} bullet(s) but recorded only ${suppLedger.size} — up to ${bullets - suppLedger.size} may be copied again on the next sync; delete any duplicate under "${move.targetName}" → Supplements.`
    );

  const left = await movableChildren(move.supplementRem);
  if (left.length === 0) {
    await move.supplementRem.remove();
    log?.log(scope, `Folded "${move.supplementName}" into "${move.targetName}" and removed the empty document.`);
  } else {
    log?.log(
      scope,
      `Folded "${move.supplementName}" into "${move.targetName}", but ${left.length} bullet(s) remain — the document was NOT removed; check it and delete it by hand.`
    );
  }
  return bullets;
}

/**
 * Fold the selected supplemental documents in: REPARENT every bullet under the main document's
 * `Supplements` header (created on first use), merge the ledgers so a later sync can't re-copy them,
 * then remove the emptied document. A document that still has bullets after the move is LEFT ALONE
 * (never removed) and reported. Per-move `onItemDone` drives the popup's progress.
 */
export async function applySupplementMigration(
  plugin: RNPlugin,
  moves: SupplementMerge[],
  callbacks: ApplyCallbacks = {},
  log?: SyncLog
): Promise<{ folded: number; bullets: number; failed: number }> {
  const onItemDone = callbacks.onItemDone ?? (() => {});
  log?.section('Apply migration (fold supplemental documents)');
  let folded = 0;
  let bullets = 0;
  let failed = 0;

  for (const move of moves) {
    try {
      bullets += await foldSupplementDoc(plugin, move, 'migrate', log);
      folded += 1;
      onItemDone(move.id, true);
    } catch (err) {
      failed += 1;
      log?.log('migrate', `MIGRATION FAILED for "${move.supplementName}": ${errMsg(err)}`);
      onItemDone(move.id, false);
    }
    await yieldToHost();
  }

  log?.log('migrate', `Migration done: ${folded} document(s) folded, ${bullets} bullet(s) moved, ${failed} failed.`);
  return { folded, bullets, failed };
}
