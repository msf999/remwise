/** Add-only sync: copy tagged Readwise highlights into `Readwise / Sources` and keep source metadata
 *  fresh. Highlights are plain bullets (dedup via a per-source ledger); sources have a powerup with
 *  metadata + a hidden ledger. Adapted from the Zot2Rem sync engine. */
import type { PluginRem, RNPlugin, RichTextInterface } from '@remnote/plugin-sdk';
import {
  CATEGORY_LABEL,
  type Category,
  HIERARCHY,
  IE,
  LOCATION_LABEL,
  NOT_IN_READER,
  SETTINGS,
  SOURCE_POWERUP,
  SOURCE_SLOTS,
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
  alreadyInSync: KeptEntry[];
  fetchedSources: number;
  matchingHighlights: number;
}

// ───────────────────────── Context ─────────────────────────

/** An existing source doc under `Readwise/Sources`, with its identity + ledger read once. */
interface ExistingSource {
  rem: PluginRem;
  userBookId: number;
  externalId: string;
  baseTitle: string;
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
  /** `doc <name>` → lookup doc rem; `ref <doc> <value>` → plain reference rem. */
  lookupCache: Map<string, PluginRem>;
  /** Parent rem id → (trimmed child name → OLDEST child rem). One scan per parent per run. */
  childNameMaps: Map<string, Map<string, PluginRem>>;
  /** Rem id → resolved name, so the diff never re-resolves the same reference. */
  refNameCache: Map<string, string>;
  existingSources: ExistingSource[];
  sourceByBookId: Map<number, ExistingSource>;
  externalIdToSource: Map<string, ExistingSource>;
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
    return (await rem.getPowerupProperty(SOURCE_POWERUP, slot)).trim();
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

async function resolveRefName(plugin: RNPlugin, ctx: SyncContext, id: string): Promise<string> {
  const cached = ctx.refNameCache.get(id);
  if (cached !== undefined) return cached;
  const r = await plugin.rem.findOne(id);
  const name = r ? await remName(plugin, r) : '';
  ctx.refNameCache.set(id, name);
  return name;
}

/** Flatten a slot's RichText to a comparable string: references → their names, text as-is. */
async function slotToComparable(
  plugin: RNPlugin,
  ctx: SyncContext,
  rt: RichTextInterface | undefined
): Promise<string> {
  if (!rt) return '';
  let out = '';
  for (const el of rt) {
    if (typeof el === 'string') out += el;
    else if (el && (el as { i?: string }).i === 'q')
      out += await resolveRefName(plugin, ctx, (el as { _id: string })._id);
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
 * Fold same-name duplicate lookup rems (Categories/Authors/Locations) into the oldest copy, moving
 * children + re-pointing inbound references, then removing the duplicate. Cross-device sync races
 * create these. Runs first so the plan sees a clean tree. (Not rem.merge — that leaves refs dangling.)
 */
async function mergeDuplicateLookupRems(plugin: RNPlugin, ctx: SyncContext, log?: SyncLog): Promise<number> {
  const root = await plugin.rem.findByName([HIERARCHY.root], null);
  if (!root) return 0;
  let merged = 0;

  const foldInto = async (canonical: PluginRem, dup: PluginRem): Promise<void> => {
    for (const child of await dup.getChildrenRem()) {
      if (await isStructuralRem(child)) continue;
      await child.setParent(canonical);
    }
    for (const refRem of await dup.remsReferencingThis()) {
      const txt = refRem.text;
      if (!txt) continue;
      const newTxt = txt.map((el) => {
        if (typeof el === 'string') return el;
        const obj = el as { i?: string; _id?: string };
        if (obj.i === 'q' && obj._id === dup._id) return { ...(el as Record<string, unknown>), _id: canonical._id };
        return el;
      });
      await refRem.setText(newTxt as RichTextInterface);
    }
    await dup.remove();
  };

  const mergeUnder = async (parent: PluginRem, label: string): Promise<void> => {
    const groups = new Map<string, PluginRem[]>();
    for (const child of await parent.getChildrenRem()) {
      if (await isStructuralRem(child)) continue;
      const name = (await remName(plugin, child)).trim();
      if (!name) continue;
      (groups.get(name) ?? groups.set(name, []).get(name)!).push(child);
    }
    for (const [name, rems] of groups) {
      if (rems.length < 2) continue;
      rems.sort((a, b) => a.createdAt - b.createdAt);
      for (let i = 1; i < rems.length; i++) {
        try {
          await foldInto(rems[0], rems[i]);
          merged += 1;
          log?.log('plan', `  merged duplicate "${name}" under ${label} (kept oldest).`);
        } catch (err) {
          log?.log('plan', `  MERGE FAILED for "${name}" under ${label}: ${errMsg(err)}`);
        }
      }
    }
  };

  for (const docName of [HIERARCHY.categories, HIERARCHY.authors, HIERARCHY.locations]) {
    const doc = await plugin.rem.findByName([docName], root._id);
    if (doc) await mergeUnder(doc, docName);
  }
  if (merged > 0) log?.log('plan', `Merged ${merged} duplicate lookup rem(s).`);
  return merged;
}

/** True if any reference in the given slots no longer resolves to a named rem (a "dangling" ref). */
async function hasDanglingRef(plugin: RNPlugin, ctx: SyncContext, rem: PluginRem, slots: string[]): Promise<boolean> {
  for (const slot of slots) {
    const rt = await getSlotRichText(rem, slot);
    if (!rt) continue;
    for (const el of rt) {
      if (typeof el === 'string') continue;
      const obj = el as { i?: string; _id?: string };
      if (obj.i === 'q' && obj._id && (await resolveRefName(plugin, ctx, obj._id)) === '') return true;
    }
  }
  return false;
}

// ───────────────────────── Ledger ─────────────────────────

/** Parse the synced-highlight-ids ledger. Missing OR unparseable → empty Set + a log line (never
 *  silently empties a populated-but-corrupt ledger without warning). Always WRITE with serializeLedger. */
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

// ───────────────────────── Context build + existing scan ─────────────────────────

/** Build a SyncContext: read settings, fetch the Reader map (passed in), and scan existing sources. */
export async function buildSyncContext(
  plugin: RNPlugin,
  opts: { tagList: string[]; included: Set<Category>; readerByExternalId: Map<string, ReaderInfo>; log?: SyncLog }
): Promise<SyncContext> {
  const applyColors = (await plugin.settings.getSetting<boolean>(SETTINGS.applyColors)) ?? true;
  const ctx: SyncContext = {
    tagList: opts.tagList,
    included: opts.included,
    applyColors,
    readerByExternalId: opts.readerByExternalId,
    lookupCache: new Map(),
    childNameMaps: new Map(),
    refNameCache: new Map(),
    existingSources: [],
    sourceByBookId: new Map(),
    externalIdToSource: new Map(),
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
    const userBookIdStr = await getProp(child, SOURCE_SLOTS.userBookId);
    const userBookId = Number(userBookIdStr);
    if (!userBookIdStr || !Number.isFinite(userBookId)) continue; // no identity → skip (add-only never deletes)
    const externalId = await getProp(child, SOURCE_SLOTS.externalId);
    const name = await remName(plugin, child);
    const baseTitle = (await getProp(child, SOURCE_SLOTS.baseTitle)) || name;
    const ledger = parseLedger(await getProp(child, SOURCE_SLOTS.syncedHighlightIds), log);
    const es: ExistingSource = { rem: child, userBookId, externalId, baseTitle, name, ledger };
    ctx.existingSources.push(es);
    n += 1;
    const prev = ctx.sourceByBookId.get(userBookId);
    if (!prev || child.createdAt < prev.rem.createdAt) ctx.sourceByBookId.set(userBookId, es);
    if (externalId && !ctx.externalIdToSource.has(externalId)) ctx.externalIdToSource.set(externalId, es);
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

/** Desired Location label. `known:false` = a reader source whose reader doc wasn't fetched this run
 *  (leave the existing location alone rather than reset it to "Not in Reader"). */
function desiredLocation(source: ReadwiseSource, ctx: SyncContext): { label: string; known: boolean } {
  if (!source.external_id) return { label: NOT_IN_READER, known: true };
  const info = ctx.readerByExternalId.get(source.external_id);
  if (!info) return { label: '', known: false };
  return { label: info.location ? LOCATION_LABEL[info.location] ?? NOT_IN_READER : NOT_IN_READER, known: true };
}

const linkOf = (source: ReadwiseSource, ctx: SyncContext): string =>
  (source.source_url ?? readerInfoOf(source, ctx)?.sourceUrl ?? '').trim();

/** The two Readwise URLs for the source (classic + Reader), in order, blanks dropped. */
const readwiseUrlsOf = (source: ReadwiseSource, ctx: SyncContext): string[] =>
  [source.readwise_url, readerInfoOf(source, ctx)?.url].map((u) => (u ?? '').trim()).filter(Boolean);

/** A name-disambiguation candidate (existing or new), with lazily-resolved author/category. */
interface NameEntry {
  baseTitle: string;
  userBookId: number;
  author: () => Promise<string>;
  category: () => Promise<string>;
  assign: (name: string) => void;
}

/** Build the display name at a given escalation depth (0=base, 1=+author, 2=+category, 3=+[id]).
 *  Empty components are skipped (so they don't appear, but also don't disambiguate — the depth keeps
 *  rising until the name is unique, with [id] guaranteeing it). */
function nameAtDepth(baseTitle: string, author: string, category: string, userBookId: number, depth: number): string {
  const comps = [author, category, `[${userBookId}]`].slice(0, depth).filter(Boolean);
  return [baseTitle, ...comps].join(' — ');
}

/**
 * Compute the symmetric, collision-disambiguated display name for every source (existing + new),
 * grouping by stored `baseTitle` ONLY (the doc name is never parsed). All members of a colliding group
 * get the next component together: `Title` → `Title — Author` → `Title — Author — Category` →
 * `Title — Author — Category — [id]`. Returns name maps keyed by existing rem id and by new userBookId.
 */
async function computeDisplayNames(
  plugin: RNPlugin,
  ctx: SyncContext,
  newSources: ReadwiseSource[],
  log?: SyncLog
): Promise<{ existingName: Map<string, string>; newName: Map<number, string> }> {
  const existingName = new Map<string, string>();
  const newName = new Map<number, string>();

  const entries: NameEntry[] = [];
  for (const es of ctx.existingSources) {
    entries.push({
      baseTitle: es.baseTitle,
      userBookId: es.userBookId,
      author: async () => slotToComparable(plugin, ctx, await getSlotRichText(es.rem, SOURCE_SLOTS.author)),
      category: async () => slotToComparable(plugin, ctx, await getSlotRichText(es.rem, SOURCE_SLOTS.category)),
      assign: (name) => existingName.set(es.rem._id, name),
    });
  }
  for (const s of newSources) {
    entries.push({
      baseTitle: (s.title ?? '').trim() || '(untitled)',
      userBookId: s.user_book_id,
      author: async () => (s.author ?? '').trim(),
      category: async () => categoryLabelOf(s),
      assign: (name) => newName.set(s.user_book_id, name),
    });
  }

  // Group by baseTitle; singletons stay clean.
  const byBase = new Map<string, NameEntry[]>();
  for (const e of entries) (byBase.get(nameKey(e.baseTitle)) ?? byBase.set(nameKey(e.baseTitle), []).get(nameKey(e.baseTitle))!).push(e);

  for (const group of byBase.values()) {
    if (group.length === 1) {
      group[0].assign(group[0].baseTitle);
      continue;
    }
    // Resolve author/category only for the (rare) colliding groups, then escalate symmetrically.
    const infos = await Promise.all(
      group.map(async (e) => ({ e, author: await e.author(), category: await e.category() }))
    );
    const depth = new Map<NameEntry, number>(infos.map((i) => [i.e, 1] as const));
    for (let pass = 0; pass < 2; pass++) {
      const byName = new Map<string, typeof infos>();
      for (const info of infos) {
        const nm = nameKey(nameAtDepth(info.e.baseTitle, info.author, info.category, info.e.userBookId, depth.get(info.e)!));
        (byName.get(nm) ?? byName.set(nm, []).get(nm)!).push(info);
      }
      for (const arr of byName.values()) {
        if (arr.length > 1) for (const info of arr) {
          const d = depth.get(info.e)!;
          if (d < 3) depth.set(info.e, d + 1);
        }
      }
    }
    for (const info of infos) {
      info.e.assign(nameAtDepth(info.e.baseTitle, info.author, info.category, info.e.userBookId, depth.get(info.e)!));
    }
    log?.log('plan', `Disambiguated ${group.length} sources sharing title "${group[0].baseTitle}".`);
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
  if (ids.length === 0) return void (await setProp(rem, SOURCE_SLOTS.readwiseUrl, [urls.join('\n')]));
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
    /* a bad cover URL must never fail the source write */
  }
}

/** Append a plain body bullet (write-once summary / document_note). No-op when empty. */
async function appendBodyBullet(plugin: RNPlugin, parent: PluginRem, text: string): Promise<void> {
  const t = text.trim();
  if (!t) return;
  const b = await plugin.rem.createRem();
  if (!b) return;
  await b.setText([t]);
  await b.setParent(parent);
}

/** Create one highlight bullet: markdown-parsed text (color-formatted when `applyColor`), with an
 *  optional note child. */
async function addHighlight(
  plugin: RNPlugin,
  sourceDoc: PluginRem,
  h: ReadwiseHighlight,
  applyColor: boolean
): Promise<void> {
  const rem = await plugin.rem.createRem();
  if (!rem) throw new Error('createRem returned undefined for a highlight');
  const text = (h.text ?? '').trim() || '(empty highlight)';
  let rt = await plugin.richText.parseFromMarkdown(text);
  const fmt = applyColor ? colorFormat(h.color) : undefined;
  if (fmt) {
    const plain = await plugin.richText.toString(rt);
    rt = await plugin.richText.applyTextFormatToRange(rt, 0, plain.length, fmt as never);
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
  await rem.setText(rt);
  await rem.setParent(sourceDoc); // append (preserve Readwise order)
  const note = (h.note ?? '').trim();
  if (note) {
    const noteRem = await plugin.rem.createRem();
    if (noteRem) {
      await noteRem.setText([note]);
      await noteRem.setParent(rem);
    }
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
    const priorityNum = Number(setup.priority) || IE.defaultPriority;
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
    changes.push({ field: 'name', fromDisplay: es.name || '(untitled)', toDisplay: desiredName });

  const curAuthor = await slotToComparable(plugin, ctx, await getSlotRichText(es.rem, SOURCE_SLOTS.author));
  const wantAuthor = (source.author ?? '').trim();
  if (nameKey(curAuthor) !== nameKey(wantAuthor))
    changes.push({ field: 'author', fromDisplay: displayValue(curAuthor), toDisplay: displayValue(wantAuthor) });

  const curCat = await slotToComparable(plugin, ctx, await getSlotRichText(es.rem, SOURCE_SLOTS.category));
  const wantCat = categoryLabelOf(source);
  if (nameKey(curCat) !== nameKey(wantCat))
    changes.push({ field: 'category', fromDisplay: displayValue(curCat), toDisplay: displayValue(wantCat) });

  const loc = desiredLocation(source, ctx);
  if (loc.known) {
    const curLoc = await slotToComparable(plugin, ctx, await getSlotRichText(es.rem, SOURCE_SLOTS.location));
    if (nameKey(curLoc) !== nameKey(loc.label))
      changes.push({ field: 'location', fromDisplay: displayValue(curLoc), toDisplay: displayValue(loc.label) });
  }

  const curLink = await slotToComparable(plugin, ctx, await getSlotRichText(es.rem, SOURCE_SLOTS.link));
  const wantLink = linkOf(source, ctx);
  if (linkKey(curLink) !== linkKey(wantLink))
    changes.push({ field: 'link', fromDisplay: displayValue(curLink), toDisplay: displayValue(wantLink) });

  // Self-heal docs with a dangling Author/Category/Location reference even if the values "match".
  if (changes.length === 0 && (await hasDanglingRef(plugin, ctx, es.rem, [SOURCE_SLOTS.author, SOURCE_SLOTS.category, SOURCE_SLOTS.location]))) {
    changes.push({ field: 'category', fromDisplay: '(dangling ref)', toDisplay: displayValue(wantCat) });
  }
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
  await mergeDuplicateLookupRems(plugin, ctx, log);

  const newSources: { source: ReadwiseSource; eligible: ReadwiseHighlight[] }[] = [];
  const existingTouched: { es: ExistingSource; source: ReadwiseSource; eligible: ReadwiseHighlight[] }[] = [];
  let matchingHighlights = 0;

  for (const s of sources) {
    if (s.is_deleted) continue;
    if (!matchesCategoryFilter(s, ctx.included)) continue;
    // A highlight is eligible if its OWN tags match, OR the SOURCE carries a matching book_tag (then
    // ALL its highlights come along).
    const wholeSource = sourceMatchesTagFilter(s, ctx.tagList);
    const eligible = (s.highlights ?? []).filter(
      (h) => !h.is_deleted && (wholeSource || matchesTagFilter(h, ctx.tagList))
    );
    matchingHighlights += eligible.length;
    const es = ctx.sourceByBookId.get(s.user_book_id);
    if (!es) {
      if (eligible.length > 0) newSources.push({ source: s, eligible });
    } else {
      existingTouched.push({ es, source: s, eligible });
    }
  }

  const { existingName, newName } = await computeDisplayNames(plugin, ctx, newSources.map((n) => n.source), log);

  const toCreateSources: SourceCreateEntry[] = newSources.map(({ source, eligible }) => ({
    id: `sc:${source.user_book_id}`,
    userBookId: source.user_book_id,
    name: newName.get(source.user_book_id) ?? (source.title ?? '(untitled)').trim(),
    categoryLabel: categoryLabelOf(source),
    source,
    eligible,
  }));

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
    if (!changes.length && !newHls.length) alreadyInSync.push({ id: `k:${es.rem._id}`, name: es.name });
  }

  // Location-only updates: existing sources NOT in the v2 fetch whose Reader location changed.
  for (const es of ctx.existingSources) {
    if (touchedRemIds.has(es.rem._id)) continue;
    if (!es.externalId) continue;
    const info = ctx.readerByExternalId.get(es.externalId);
    if (!info) continue;
    const label = info.location ? LOCATION_LABEL[info.location] ?? NOT_IN_READER : NOT_IN_READER;
    const curLoc = await slotToComparable(plugin, ctx, await getSlotRichText(es.rem, SOURCE_SLOTS.location));
    if (nameKey(curLoc) !== nameKey(label)) {
      toUpdateSources.push({
        id: `su:${es.rem._id}`,
        name: es.name,
        rem: es.rem,
        source: undefined,
        changes: [{ field: 'location', fromDisplay: displayValue(curLoc), toDisplay: label }],
      });
    }
  }

  log?.log(
    'plan',
    `Plan: ${toCreateSources.length} create, ${toUpdateSources.length} source update(s), ` +
      `${toAddHighlights.reduce((n, g) => n + g.highlights.length, 0)} highlight(s) to add, ${alreadyInSync.length} in sync.`
  );
  return { toCreateSources, toUpdateSources, toAddHighlights, alreadyInSync, fetchedSources: sources.length, matchingHighlights };
}

// ───────────────────────── Apply ─────────────────────────

/** The user's per-row selection from the preview. */
export interface ApplySelection {
  toCreateSources: SourceCreateEntry[];
  toUpdateSources: { entry: SourceUpdateEntry; fields: Set<UpdatableField> }[];
  toAddHighlights: { entry: SourceAddHighlights; highlightIds: Set<number> }[];
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
        if (source) await setProp(rem, SOURCE_SLOTS.baseTitle, [(source.title ?? '').trim()]);
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
    }
  }
  await setProp(rem, SOURCE_SLOTS.lastSyncedAt, [String(syncedAt)]);
}

/** Create one source doc + its eligible highlights; ledger holds only the highlights that succeeded. */
async function createSourceDoc(
  plugin: RNPlugin,
  ctx: SyncContext,
  entry: SourceCreateEntry,
  parent: PluginRem,
  powerupRem: PluginRem,
  syncedAt: number,
  log?: SyncLog
): Promise<void> {
  const s = entry.source;
  const rem = await plugin.rem.createRem();
  if (!rem) throw new Error('createRem returned undefined for a source');
  await rem.setText([entry.name]);
  await rem.setParent(parent, 0); // newest-first
  await rem.setIsDocument(true);
  await rem.addTag(powerupRem._id);
  await setProp(rem, SOURCE_SLOTS.userBookId, [String(s.user_book_id)]);
  await setProp(rem, SOURCE_SLOTS.baseTitle, [(s.title ?? '').trim()]);
  if (s.external_id) await setProp(rem, SOURCE_SLOTS.externalId, [s.external_id]);

  await writeAuthor(plugin, ctx, rem, (s.author ?? '').trim());
  await writeCategory(plugin, ctx, rem, categoryLabelOf(s));
  const loc = desiredLocation(s, ctx);
  await writeLocation(plugin, ctx, rem, loc.known ? loc.label : NOT_IN_READER);
  await writeLink(plugin, rem, linkOf(s, ctx));
  await writeReadwiseUrls(plugin, rem, readwiseUrlsOf(s, ctx));
  await writeCover(plugin, rem, (s.cover_image_url ?? '').trim());

  // Write-once body: summary then document_note (the fresh doc has no other body children yet).
  await appendBodyBullet(plugin, rem, (s.summary ?? '').trim());
  await appendBodyBullet(plugin, rem, (s.document_note ?? '').trim());

  const added = new Set<string>();
  for (const h of entry.eligible) {
    try {
      await addHighlight(plugin, rem, h, ctx.applyColors);
      added.add(String(h.id));
    } catch (err) {
      log?.log('apply', `  highlight ${h.id} failed (will retry next run): ${errMsg(err)}`);
    }
  }
  await setProp(rem, SOURCE_SLOTS.syncedHighlightIds, serializeLedger(added));
  await setProp(rem, SOURCE_SLOTS.lastSyncedAt, [String(syncedAt)]);
  await makeIncremental(plugin, rem, ctx, log);
}

/** Append selected new highlights to an existing source; grow its ledger with only the ones that wrote. */
async function applyAddHighlights(
  plugin: RNPlugin,
  rem: PluginRem,
  highlights: ReadwiseHighlight[],
  syncedAt: number,
  applyColor: boolean,
  log?: SyncLog
): Promise<number> {
  const ledger = parseLedger(await getProp(rem, SOURCE_SLOTS.syncedHighlightIds), log);
  let n = 0;
  for (const h of highlights) {
    if (ledger.has(String(h.id))) continue;
    try {
      await addHighlight(plugin, rem, h, applyColor);
      ledger.add(String(h.id));
      n += 1;
    } catch (err) {
      log?.log('apply', `  highlight ${h.id} failed (will retry next run): ${errMsg(err)}`);
    }
  }
  await setProp(rem, SOURCE_SLOTS.syncedHighlightIds, serializeLedger(ledger));
  await setProp(rem, SOURCE_SLOTS.lastSyncedAt, [String(syncedAt)]);
  return n;
}

/**
 * Apply the selection. Order: update sources → add highlights → create sources. Aborts up-front (zero
 * changes) if the powerup isn't registered (plugin not reloaded). Per-row `onItemDone` for progress.
 */
export async function applySyncPlan(
  plugin: RNPlugin,
  selection: ApplySelection,
  ctx: SyncContext,
  callbacks: ApplyCallbacks = {},
  log?: SyncLog
): Promise<{ created: number; updated: number; highlightsAdded: number; failed: number }> {
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
  let failed = 0;

  log?.section('Apply');

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
      const added = await applyAddHighlights(plugin, entry.rem, picked, syncedAt, ctx.applyColors, log);
      highlightsAdded += added;
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

  if (selection.toCreateSources.length) {
    const parent = await ensureSourcesParent(plugin);
    for (const entry of selection.toCreateSources) {
      try {
        await createSourceDoc(plugin, ctx, entry, parent, powerupRem, syncedAt, log);
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

  log?.log('apply', `Done: ${created} created, ${updated} updated, ${highlightsAdded} highlights added, ${failed} failed.`);
  return { created, updated, highlightsAdded, failed };
}
