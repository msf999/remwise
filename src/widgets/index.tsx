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
      'RemNote highlight color. When OFF, highlights are imported as plain text.',
    defaultValue: true,
  });

  for (const c of CATEGORIES) {
    await plugin.settings.registerBooleanSetting({
      id: categorySettingId(c),
      title: `Include ${CATEGORY_LABEL[c]}`,
      description: `Include Readwise ${CATEGORY_LABEL[c].toLowerCase()} when syncing.`,
      defaultValue: true,
    });
  }

  await plugin.settings.registerBooleanSetting({
    id: SETTINGS.incremental,
    title: 'Quick sync (only fetch changes since last sync)',
    description:
      'When ON, each sync only fetches Readwise sources changed since the last successful sync — fast, ' +
      'and new tags/edits are caught (tagging bumps the highlight’s updated date). When OFF, every sync ' +
      'fetches your whole library. Keep it OFF while first working through your library (quick sync ' +
      'can’t resurface older items you haven’t synced yet); turn it ON once you’re caught up. ' +
      'Use the Reset last sync button in the Sync Readwise popup anytime to force a full fetch.',
    defaultValue: false,
  });

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

  // The ONLY command now (reset-last-sync moved into the popup as a confirm-gated button). Omnibar
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
}

async function onDeactivate(_: ReactRNPlugin) {}

declareIndexPlugin(onActivate, onDeactivate);
