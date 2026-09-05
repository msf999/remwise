import {
  declareIndexPlugin,
  PropertyLocation,
  PropertyType,
  type ReactRNPlugin,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import '../style.css';
import '../index.css';
import {
  CATEGORIES,
  CATEGORY_LABEL,
  categorySettingId,
  SETTINGS,
  SOURCE_POWERUP,
  SOURCE_SLOTS,
  SYNC_WIDGET,
} from '../lib/consts';
// Namespace imports used ONLY by the dev-server-gated test hook at the end of onActivate.
import * as consts from '../lib/consts';
import * as api from '../lib/readwiseApi';
import * as sync from '../lib/sync';

async function onActivate(plugin: ReactRNPlugin) {
  // ── Settings ──────────────────────────────────────────────────────────────
  await plugin.settings.registerStringSetting({
    id: SETTINGS.apiKey,
    title: 'Readwise access token',
    description:
      'Get it from https://readwise.io/access_token. A read-only token is fine (Remwise only reads). ' +
      'Remwise checks it for you when you open the Sync Readwise popup.',
  });

  await plugin.settings.registerStringSetting({
    id: SETTINGS.tagFilter,
    title: 'Tags to copy (comma-separated)',
    description:
      'Copy highlights carrying one of these tags (case-insensitive). If a SOURCE itself has the tag ' +
      '(a book/article tag in Readwise), ALL of its highlights are copied. Leave empty to copy every ' +
      'highlight. Tip: on your first sync, try a single tag (e.g. "science") to see how it looks.',
    defaultValue: '',
  });

  await plugin.settings.registerBooleanSetting({
    id: SETTINGS.applyColors,
    title: 'Apply highlight colors',
    description:
      "When ON, each highlight's Readwise color (yellow/blue/pink/orange/green/purple) is applied as a " +
      'RemNote highlight color. When OFF (the default), highlights are imported as plain text.',
    defaultValue: false,
  });

  for (const c of CATEGORIES) {
    await plugin.settings.registerBooleanSetting({
      id: categorySettingId(c),
      title: `Include ${CATEGORY_LABEL[c]}`,
      description:
        `Include Readwise ${CATEGORY_LABEL[c].toLowerCase()} when syncing. ` +
        '(Turn all five category toggles off and nothing syncs.)',
      defaultValue: true,
    });
  }

  await plugin.settings.registerBooleanSetting({
    id: SETTINGS.initIncremental,
    title: 'Make source docs Incremental (Incremental Everything)',
    description:
      'When ON, Remwise enrols source documents into the Incremental Everything plugin (due today): ' +
      'every NEW source it creates, and any existing source that is not yet incremental when it gains ' +
      'a new highlight. Requires that plugin installed; otherwise silently skipped. NOTE: Incremental ' +
      'Everything only notices newly-enrolled docs after it rebuilds its cache — reload the Incremental ' +
      'Everything plugin (or RemNote) after a sync for them to enter the queue.',
    defaultValue: false,
  });

  // ── Powerup: marks a Rem as a synced Readwise source + holds its metadata and dedup ledger ──
  // Re-registration does NOT change an EXISTING property's type/location (fresh installs only); on an
  // existing KB align each one once via its property-definition config menu in RemNote.
  await plugin.app.registerPowerup({
    name: 'Readwise Source',
    code: SOURCE_POWERUP,
    description: 'Marks a Rem as a source imported from Readwise and holds its metadata.',
    options: {
      properties: [
        { code: SOURCE_SLOTS.author, name: 'Author', onlyProgrammaticModifying: true,
          propertyType: PropertyType.TEXT, propertyLocation: PropertyLocation.ONLY_DOCUMENT },
        { code: SOURCE_SLOTS.category, name: 'Category', onlyProgrammaticModifying: true,
          propertyType: PropertyType.TEXT, propertyLocation: PropertyLocation.ONLY_DOCUMENT },
        { code: SOURCE_SLOTS.location, name: 'Location', onlyProgrammaticModifying: true,
          propertyType: PropertyType.TEXT, propertyLocation: PropertyLocation.ONLY_DOCUMENT },
        { code: SOURCE_SLOTS.link, name: 'Link', onlyProgrammaticModifying: true,
          propertyType: PropertyType.URL, propertyLocation: PropertyLocation.ONLY_DOCUMENT },
        { code: SOURCE_SLOTS.readwiseUrl, name: 'Readwise', onlyProgrammaticModifying: true,
          propertyType: PropertyType.TEXT, propertyLocation: PropertyLocation.ONLY_DOCUMENT },
        { code: SOURCE_SLOTS.cover, name: 'Cover', onlyProgrammaticModifying: true,
          propertyType: PropertyType.TEXT, propertyLocation: PropertyLocation.ONLY_DOCUMENT },
        // User-owned: created empty, never written by the plugin.
        { code: SOURCE_SLOTS.tags, name: 'Tags',
          propertyType: PropertyType.MULTI_SELECT, propertyLocation: PropertyLocation.ONLY_DOCUMENT },
        // Hidden identity / bookkeeping.
        { code: SOURCE_SLOTS.linkUrl, name: 'Link URL', onlyProgrammaticModifying: true, hidden: true },
        { code: SOURCE_SLOTS.userBookId, name: 'Readwise Book ID', onlyProgrammaticModifying: true, hidden: true },
        { code: SOURCE_SLOTS.baseTitle, name: 'Base Title', onlyProgrammaticModifying: true, hidden: true },
        { code: SOURCE_SLOTS.externalId, name: 'Reader Doc ID', onlyProgrammaticModifying: true, hidden: true },
        { code: SOURCE_SLOTS.syncedHighlightIds, name: 'Synced Highlight IDs', onlyProgrammaticModifying: true, hidden: true },
        { code: SOURCE_SLOTS.lastSyncedAt, name: 'Last Synced', onlyProgrammaticModifying: true, hidden: true },
      ],
    },
  });

  // ── Sync popup + commands ──────────────────────────────────────────────────
  await plugin.app.registerWidget(SYNC_WIDGET, WidgetLocation.Popup, {
    dimensions: { height: 800, width: 1000 },
  });

  // The ONLY command. Omnibar
  // position is NOT controllable from the SDK (Command has no priority/order field) and is NOT
  // alphabetical — RemNote ranks commands by recency/frequency of use. quickCode 'rw' opens it directly.
  await plugin.app.registerCommand({
    id: 'sync-readwise',
    name: 'Sync Readwise',
    quickCode: 'rw',
    action: async () => {
      await plugin.widget.openPopup(SYNC_WIDGET);
    },
  });

  // ── Automated-test hook — DEV ONLY ────────────────────────────────────────
  // Exposes the plugin handle and the engine on this widget's window so the test harness
  // (scripts/suite.js + scripts/popup-ui.js, driven over the Chrome DevTools Protocol by scripts/cdp.js) can run the REAL
  // engine against the REAL knowledge base using SYNTHETIC Readwise data — the only way to cover
  // edge cases the live API will never hand us on demand. Gated on the bundle being served from the
  // local dev server, so a packaged build never activates it. NOTE: the engine is imported
  // STATICALLY above (a dynamic import broke the widget bundle), so the code IS present in the
  // packaged index.js — inert, but present. It only calls the same public functions the popup calls,
  // so it cannot change how the plugin behaves.
  try {
    if (typeof location !== 'undefined' && location.hostname === 'localhost') {
      (globalThis as unknown as Record<string, unknown>).__remwise = { plugin, sync, api, consts };
    }
  } catch {
    /* a test hook must never break activation */
  }
}

async function onDeactivate(_: ReactRNPlugin) {}

declareIndexPlugin(onActivate, onDeactivate);
