/** Shared identifiers used across registration and runtime so they never drift. */

/** Plugin setting ids. Every sync is a FULL fetch — the former opt-in "Quick sync" delta mode
 *  (`readwise-incremental` + a stored last-sync date) was removed on 2026-09-02; see CLAUDE.md. */
export const SETTINGS = {
  apiKey: 'readwise-api-token',
  /** Comma-separated highlight tags to copy; empty = copy all. */
  tagFilter: 'readwise-tag-filter',
  /** When ON, apply each highlight's Readwise color as a RemNote highlight color. Default OFF. */
  applyColors: 'readwise-apply-colors',
  /**
   * When ON, enrol a source doc in Incremental Everything: every newly-created source, AND any
   * existing source not yet incremental that gains a new highlight on a later sync.
   */
  initIncremental: 'init-incremental-on-create',
} as const;

/** The five Readwise source categories. Each gets its own "include" boolean setting (default ON). */
export const CATEGORIES = ['books', 'articles', 'tweets', 'podcasts', 'supplementals'] as const;
export type Category = (typeof CATEGORIES)[number];

/** Human label for a category (also the text of its rem under `Readwise/Categories`). */
export const CATEGORY_LABEL: Record<Category, string> = {
  books: 'Books',
  articles: 'Articles',
  tweets: 'Tweets',
  podcasts: 'Podcasts',
  supplementals: 'Supplementals',
};

/** Per-category "include in sync" boolean-setting id. */
export const categorySettingId = (c: Category): string => `readwise-cat-${c}`;

/**
 * Incremental Everything (IE) integration. IE marks a rem "incremental" via its `incremental` powerup
 * + slots; the SDK has no cross-plugin command API, so we replicate IE's `initIncrementalRem` tagging
 * directly (see `makeIncremental` in sync.ts). These codes mirror IE's own consts (verified against
 * the IE source) — keep in sync if IE renames them. We write the SAME slots IE writes so an
 * enrolled rem is byte-identical to an IE-native one (nextRepDate/originalIncDate/firstAdded = today's
 * daily-doc ref; priority + rotation as a one-string array; repHist = a `madeIncremental` marker).
 * NOTE: IE only DETECTS a newly-tagged rem when it rebuilds its in-session cache, which happens on IE
 * plugin/app load — so after a sync that enrols docs, the IE plugin (or RemNote) must reload for them
 * to enter the queue (IE's live cache updates are internal and unreachable from another plugin).
 */
export const IE = {
  powerup: 'incremental',
  prioritySlot: 'priority',
  nextRepDateSlot: 'nextRepDate',
  repHistSlot: 'repHist',
  originalIncDateSlot: 'originalIncDate',
  firstAddedSlot: 'firstAdded',
  rotationSlot: 'rotation',
  /** Default priority IE assigns (0–100); used when no parent folder is tagged incremental. */
  defaultPriority: 10,
  /** IE's default rotation value (the rotation slot holds this unless inherited from a parent). */
  defaultRotation: 'Default',
} as const;

/**
 * Document-title format. A source doc is named `Author - Title` so every author's works sort together
 * (and the author is visible on the flashcard's source in the queue); a source with no author is just
 * `Title`. Collisions escalate with the EM-DASH separator — `Author - Title — Category` →
 * `Author - Title — [id]` — so a disambiguation suffix never looks like part of the author-title pair.
 */
export const AUTHOR_TITLE_SEP = ' - ';
export const DISAMBIG_SEP = ' — ';

/**
 * Readwise's `supplementals` category (its curated popular highlights for a book). These are NOT given
 * their own source document: their highlights live under a `Supplements` header inside the MAIN
 * source's document (matched by title + author). Docs created for a supplemental by an older version
 * are folded in by the one-time migration in the Sync popup.
 */
export const SUPPLEMENTAL_CATEGORY = 'supplementals';
/** Name of the header-1 rem holding a source's supplemental highlights. */
export const SUPPLEMENTS_HEADER = 'Supplements';
/**
 * Suffix for a SUPPLEMENT DOCUMENT — the holding pen for a supplemental whose main source isn't in
 * RemNote yet. It keeps the highlights rather than dropping them; once the main source shows up, the
 * sync stages a "Will merge" row that moves the bullets into its `Supplements` section and deletes the
 * emptied document. Docs an older version created for every supplemental are the same thing and merge
 * the same way.
 */
export const SUPPLEMENT_DOC_SUFFIX = ' - Supplement';

/** Powerup that marks a Rem as a synced Readwise source and holds its metadata + dedup ledger. */
export const SOURCE_POWERUP = 'readwise-source';

/** Property (slot) codes on the Readwise Source powerup. */
export const SOURCE_SLOTS = {
  // Visible, plugin-owned metadata (display order).
  author: 'author',
  category: 'category',
  location: 'location',
  link: 'link',
  readwiseUrl: 'readwiseUrl',
  cover: 'cover',
  // User-owned: created empty, never written/read/diffed by the plugin.
  tags: 'tags',
  // Hidden, plugin-owned.
  /** The RAW url last written to the visible `link` slot. The visible slot holds a REFERENCE to a link
   *  rem whose NAME can be a page title rather than the url (RemNote derives one), and such a rem is
   *  not even tagged with the built-in Link powerup — so its url is unreadable and comparing the
   *  resolved name against the url stages a "link" row that can never be satisfied. Diffing against
   *  this stored copy instead is exact. Verified live 2026-09-05 on a title-named archive.org link. */
  linkUrl: 'linkUrl',
  userBookId: 'userBookId',
  baseTitle: 'baseTitle',
  externalId: 'externalId',
  syncedHighlightIds: 'syncedHighlightIds',
  lastSyncedAt: 'lastSyncedAt',
} as const;

/**
 * Source fields the re-sync may refresh (diffed by `diffSource`, written by `applyUpdate`). `name` is
 * the document TITLE (a `displayTitle`, reconciled via `setText` — not a slot); the rest are slots.
 * `tags` is user-owned and never touched.
 *
 * `readwise` (the `readwiseUrl` slot) and `cover` are here ONLY so a CORRUPTED slot can be repaired —
 * they are still never value-diffed, because a link rem renders as a page title and an image element
 * never round-trips, so comparing either stages a row that can never be satisfied (the Zot2Rem lesson).
 * `diffSource` reaches them exclusively through the STRUCTURAL `slotHealth` check. See the self-heal
 * block there and the 2026-09-11 changelog entry.
 */
export const SOURCE_UPDATABLE = ['name', 'author', 'category', 'location', 'link', 'readwise', 'cover'] as const;
export type UpdatableField = (typeof SOURCE_UPDATABLE)[number];

/**
 * Document hierarchy under the `Readwise` root. `sources` holds the synced source docs; the rest are
 * lookup documents whose entries are plain rems that source properties reference (and dedup).
 */
export const HIERARCHY = {
  root: 'Readwise',
  sources: 'Sources',
  categories: 'Categories',
  authors: 'Authors',
  locations: 'Locations',
} as const;

/** Reader (v3) `location` value → display label. Non-Reader sources get `NOT_IN_READER`. */
export const LOCATION_LABEL: Record<string, string> = {
  new: 'Inbox',
  later: 'Later',
  shortlist: 'Shortlist',
  archive: 'Archive',
  feed: 'Feed',
};
export const NOT_IN_READER = 'Not in Reader';

/**
 * Readwise highlight `color` → RemNote highlight-color format token (a `RichTextFormatName`).
 *
 * ⚠️ `pink → Red`, NOT `Pink`. `RemColor.Pink` exists in the SDK's TypeScript enum and `'Pink'` type-
 * checks fine, but the host REJECTS it at runtime: `richText.applyTextFormatToRange` answers
 * "Invalid Method Arguments … format parameter: Invalid input". Verified live 2026-09-05 by applying
 * every name — Yellow/Blue/Orange/Green/Purple/Red all work, Pink alone throws. An earlier session
 * "corrected" the original plan's `pink → Red` to `pink → Pink` on the strength of the enum alone and
 * never ran it, which silently dropped every pink highlight (the throw skipped the whole bullet).
 * Do NOT change this back without applying 'Pink' against a live host first.
 */
export const COLOR_MAP: Record<string, string> = {
  yellow: 'Yellow',
  blue: 'Blue',
  pink: 'Red',
  orange: 'Orange',
  green: 'Green',
  purple: 'Purple',
};

/** Widget file name (matches src/widgets/readwise_sync.tsx). */
export const SYNC_WIDGET = 'readwise_sync';
