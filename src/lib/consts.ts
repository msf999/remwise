/** Shared identifiers used across registration and runtime so they never drift. */

/** Plugin setting ids. */
export const SETTINGS = {
  apiKey: 'readwise-api-token',
  /** Comma-separated highlight tags to copy; empty = copy all. */
  tagFilter: 'readwise-tag-filter',
  /** When ON, apply each highlight's Readwise color as a RemNote highlight color. */
  applyColors: 'readwise-apply-colors',
  /**
   * When ON, fetch only sources changed since the stored last-sync date (fast). When OFF, fetch the
   * whole library every time (use this while first working through your library — incremental can't
   * resurface old items you haven't synced yet). Default OFF.
   */
  incremental: 'readwise-incremental',
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
  userBookId: 'userBookId',
  baseTitle: 'baseTitle',
  externalId: 'externalId',
  syncedHighlightIds: 'syncedHighlightIds',
  lastSyncedAt: 'lastSyncedAt',
} as const;

/**
 * Source fields the re-sync may refresh. `name` is the document TITLE (a `displayTitle`, reconciled
 * via `setText` — not a slot). All others are slots. `tags` is excluded (user-owned).
 */
export const SOURCE_UPDATABLE = [
  'name',
  'author',
  'category',
  'location',
  'cover',
  'link',
  'readwiseUrl',
] as const;
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
 * Readwise highlight `color` → RemNote highlight-color format token (a `RichTextFormatName`, which
 * accepts the RemColor names). RemNote has a real `Pink`, so every Readwise color maps 1:1. An
 * unknown/empty color → no formatting (plain text).
 */
export const COLOR_MAP: Record<string, string> = {
  yellow: 'Yellow',
  blue: 'Blue',
  pink: 'Pink',
  orange: 'Orange',
  green: 'Green',
  purple: 'Purple',
};

/**
 * Synced-storage keys (cross-device, plugin-writable — unlike settings, which the SDK can't write).
 * `lastSyncDate` is the ISO run-start time of the last successful Apply; used as `updatedAfter` only
 * when the `incremental` setting is ON. The "Reset last sync" command clears it (forces a full fetch).
 */
export const STORAGE = {
  lastSyncDate: 'readwise-last-sync-date',
} as const;

/** Widget file name (matches src/widgets/readwise_sync.tsx). */
export const SYNC_WIDGET = 'readwise_sync';
