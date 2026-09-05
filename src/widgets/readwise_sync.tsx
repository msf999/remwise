import { renderWidget, usePlugin } from '@remnote/plugin-sdk';
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import { SETTINGS, type UpdatableField } from '../lib/consts';
import { SyncLog } from '../lib/log';
import {
  fetchExport,
  fetchReaderDocs,
  getIncludedCategories,
  isAbortError,
  isToastedError,
  parseTagFilter,
  verifyToken,
} from '../lib/readwiseApi';
import {
  applySupplementMigration,
  applySyncPlan,
  type ApplySelection,
  buildSyncContext,
  computeSyncPlan,
  type MigrationPlan,
  planSupplementMigration,
  type SourceCreateEntry,
  type SyncContext,
  type SyncPlan,
} from '../lib/sync';

/** Copy text to the clipboard, falling back to a hidden textarea (the clipboard API can be blocked
 *  inside iframes). */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

const clip = (s: string, n = 90): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
};

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const Check = (props: { checked: boolean; indeterminate?: boolean; disabled?: boolean; onChange: () => void }) => {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!props.indeterminate && !props.checked;
  }, [props.indeterminate, props.checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      style={{ cursor: 'pointer', flexShrink: 0 }}
      checked={props.checked}
      disabled={props.disabled}
      onChange={props.onChange}
    />
  );
};

// ── Module-level styles + Section ──────────────────────────────────────────────
// `Section` MUST live outside `ReadwiseSync`: a component defined inside another component's body gets
// a brand-new identity on every render, so React unmounts and remounts its entire subtree — here the
// whole (possibly 1000+-row) preview list — on every checkbox click or status update. At module level
// it is a stable type, so React reconciles the existing DOM in place (a re-render, not a remount).
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '3px 0' };
const sectionStyle: CSSProperties = { border: '1px solid #e5e7eb', borderRadius: 8, marginBottom: 10 };
const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 12px',
  cursor: 'pointer',
  fontWeight: 600,
};
const bodyStyle: CSSProperties = { padding: '4px 12px 10px 12px' };
const smallBtn: CSSProperties = {
  padding: '2px 8px',
  borderRadius: 5,
  border: '1px solid #d1d5db',
  background: 'transparent',
  color: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
};

/** Select-all state for a section header; omitted for a read-only section. */
interface SelectAll {
  allOn: boolean;
  someOn: boolean;
  disabled: boolean;
  onToggleAll: () => void;
}

const Section = (props: {
  title: string;
  count: number;
  isOpen: boolean;
  onToggle: () => void;
  select?: SelectAll;
  children: ReactNode;
}) => {
  if (props.count === 0) return null;
  return (
    <div style={sectionStyle}>
      <div style={headerStyle} onClick={props.onToggle}>
        <span style={{ width: 14 }}>{props.isOpen ? '▾' : '▸'}</span>
        {props.select && (
          <span onClick={(e) => e.stopPropagation()}>
            <Check
              checked={props.select.allOn}
              indeterminate={props.select.someOn}
              disabled={props.select.disabled}
              onChange={props.select.onToggleAll}
            />
          </span>
        )}
        <span>
          {props.title} ({props.count})
        </span>
      </div>
      {props.isOpen && <div style={bodyStyle}>{props.children}</div>}
    </div>
  );
};

export const ReadwiseSync = () => {
  const plugin = usePlugin();

  const [status, setStatus] = useState('Ready. Click "Get from Readwise" to preview what will sync.');
  /** A non-fatal problem worth keeping on screen (e.g. the Reader location sweep stopped early). */
  const [warning, setWarning] = useState('');
  const [busy, setBusy] = useState(false);
  /** True only while applySyncPlan is running — drives the compact panel that hides the big list. */
  const [syncApplying, setSyncApplying] = useState(false);
  /** True while the fallback migration is reparenting and deleting. */
  const [migApplying, setMigApplying] = useState(false);
  const [applied, setApplied] = useState(false);
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(['already', 'log']));
  const [hasLog, setHasLog] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  // One-time migration (fold old supplemental documents). Temporary — remove with the panel below.
  const [migPlan, setMigPlan] = useState<MigrationPlan | null>(null);
  const [migSelected, setMigSelected] = useState<Set<string>>(new Set());
  const [migStatus, setMigStatus] = useState('');
  const [migConfirm, setMigConfirm] = useState(false);
  const [migApplied, setMigApplied] = useState(false);
  // The panel and the sync both mint `mg:<remId>` ids, so the panel keeps its OWN marks — sharing
  // `done`/`failed` made a sync merge paint ✅/❌ on a migration row that never ran.
  const [migDone, setMigDone] = useState<Set<string>>(new Set());
  const [migFailed, setMigFailed] = useState<Set<string>>(new Set());

  const ctxRef = useRef<SyncContext | null>(null);
  const logRef = useRef<SyncLog | null>(null);
  const previewStartedRef = useRef(false);
  // Cancels an in-flight fetch when the popup closes: fetchExport + the minute-long throttled Reader
  // sweep would otherwise keep running, setting state on an unmounted widget and toasting into the void.
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  // On open: show the active tag filter AND validate the token so a missing/invalid one is caught right
  // here (with a friendly pointer to settings) instead of mid-fetch as an HTTP 401. The tag line is set
  // regardless; only the STATUS text is gated on `previewStartedRef` (the user clicking "Get from
  // Readwise" mid-check) so the async verify result never clobbers a fetch that's already underway.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const tagList = parseTagFilter(await plugin.settings.getSetting<string>(SETTINGS.tagFilter));
      const token = (await plugin.settings.getSetting<string>(SETTINGS.apiKey))?.trim();
      if (cancelled) return;
      setTags(tagList);
      if (previewStartedRef.current) return;
      if (!token) {
        setStatus('No Readwise token set — add one in the plugin settings (readwise.io/access_token) to sync.');
        return;
      }
      setStatus('Checking your Readwise token…');
      const check = await verifyToken(token);
      if (cancelled || previewStartedRef.current) return;
      setStatus(
        check === 'ok'
          ? 'Ready. Click "Get from Readwise" to preview what will sync.'
          : check === 'invalid'
            ? 'Readwise rejected your token — check it in the plugin settings (readwise.io/access_token).'
            : 'Couldn’t reach Readwise to check your token (offline, or Readwise is busy) — you can still try "Get from Readwise".'
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [plugin]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const setMany = (ids: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) (on ? next.add(id) : next.delete(id));
      return next;
    });

  const toggleCollapse = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  // ── Preview ────────────────────────────────────────────────────────────────
  const handlePreview = async () => {
    previewStartedRef.current = true;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    setApplied(false);
    setPlan(null);
    setDone(new Set());
    setFailed(new Set());
    setProgress(null);
    setWarning('');
    const log = new SyncLog();
    logRef.current = log;
    try {
      const tagList = parseTagFilter(await plugin.settings.getSetting<string>(SETTINGS.tagFilter));
      const included = await getIncludedCategories(plugin);
      setTags(tagList);
      if (included.size === 0) {
        setStatus('All five "Include …" category settings are off — nothing to sync. Turn at least one on in the plugin settings.');
        log.log('plan', 'No category included — nothing fetched.');
        return;
      }

      setStatus('Fetching your full Readwise library…');
      const { sources } = await fetchExport(plugin, {
        signal: ac.signal,
        onProgress: (s, h, total) => {
          if (!mountedRef.current) return;
          setProgress({ completed: s, total: Math.max(total || s, s) });
          setStatus(`Fetched ${s} sources, ${h} highlights…`);
        },
        log,
      });

      setProgress(null);
      setStatus('Fetching Readwise Reader locations… (≈20 requests/min)');
      const reader = await fetchReaderDocs(plugin, {
        signal: ac.signal,
        onProgress: (n) => {
          if (mountedRef.current) setStatus(`Fetching Readwise Reader locations… ${n} docs (≈20 requests/min)`);
        },
        log,
      });
      // Collected, not set one-by-one: a second setWarning would silently replace the first.
      const warnings: string[] = [];
      if (!reader.complete)
        warnings.push(
          `Reader location sweep stopped early (${reader.error ?? 'unknown error'}) after mapping ${reader.docs.size} docs — ` +
            'unmapped sources keep their current location and link. A source created NOW gets its location and link ' +
            'filled in by a later complete run, but NOT its Reader URL — consider refreshing before applying creates.'
        );

      setStatus('Comparing against RemNote…');
      const ctx = await buildSyncContext(plugin, {
        tagList,
        included,
        readerByExternalId: reader.docs,
        readerComplete: reader.complete,
        log,
      });
      ctxRef.current = ctx;
      const p = await computeSyncPlan(plugin, sources, ctx, log);
      if (ac.signal.aborted) return;
      setPlan(p);
      if (p.orphanDocNames.length)
        warnings.push(
          `${p.orphanDocNames.length} document(s) under Readwise/Sources carry the plugin's tag but no Readwise id ` +
            `(${p.orphanDocNames.slice(0, 3).join(', ')}${p.orphanDocNames.length > 3 ? ', …' : ''}) — leftovers of an ` +
            'interrupted create. Delete them by hand, or their sources will be imported a second time.'
        );
      if (warnings.length) setWarning(warnings.join(' '));

      // Default selection: everything actionable is ticked.
      const sel = new Set<string>();
      for (const e of p.toCreateSources) sel.add(e.id);
      for (const e of p.toUpdateSources) for (const c of e.changes) sel.add(`${e.id}:${c.field}`);
      for (const e of p.toAddHighlights) for (const h of e.highlights) sel.add(`${e.id}:${h.id}`);
      for (const e of p.toAddSupplements) for (const h of e.highlights) sel.add(`${e.id}:${h.id}`);
      for (const m of p.toMergeSupplementDocs) sel.add(m.id);
      for (const d of p.toFoldLookupDuplicates) sel.add(d.id);
      setSelected(sel);

      const hlToAdd = p.toAddHighlights.reduce((n, g) => n + g.highlights.length, 0);
      const supToAdd = p.toAddSupplements.reduce((n, g) => n + g.highlights.length, 0);
      const actionable =
        p.toCreateSources.length +
        p.toUpdateSources.length +
        hlToAdd +
        supToAdd +
        p.toMergeSupplementDocs.length +
        p.toFoldLookupDuplicates.length;
      // The empty-plan message keys off WHY it's empty: nothing fetched / nothing matched the tag filter
      // within the included categories (naming both filters, since `matchingHighlights` only counts
      // category-included sources) / everything already copied — not just the raw fetch count.
      const excluded = p.excludedByCategory
        ? ` (${p.excludedByCategory} source${p.excludedByCategory === 1 ? ' was' : 's were'} skipped by your "Include …" category settings)`
        : '';
      setStatus(
        actionable > 0
          ? `Found ${p.fetchedSources} sources (${p.matchingHighlights} matching highlights) — ` +
              `${p.toCreateSources.length} to create, ${p.toUpdateSources.length} source update(s), ${hlToAdd} highlight(s)` +
              `${supToAdd ? ` and ${supToAdd} supplement(s)` : ''} to add` +
              `${p.toMergeSupplementDocs.length ? `, ${p.toMergeSupplementDocs.length} supplement document(s) to fold in` : ''}.`
          : p.fetchedSources === 0
            ? 'Readwise returned no sources for this account.'
            : p.matchingHighlights === 0
              ? tagList.length
                ? `No highlight in the included categories carries the tag${tagList.length > 1 ? 's' : ''} ${tagList.join(', ')}${excluded} — try another tag, clear the filter to copy everything, or check the category settings.`
                : `Readwise returned ${p.fetchedSources} sources, but none has highlights in the included categories${excluded}.`
              : 'Everything is already in sync.'
      );
    } catch (err) {
      if (isAbortError(err) || ac.signal.aborted) {
        log.log('fetch', 'Cancelled (popup closed).');
        return;
      }
      log.log('error', errText(err));
      if (!isToastedError(err)) await plugin.app.toast(`Readwise sync failed: ${errText(err)}`);
      setStatus(`Failed: ${errText(err)}`);
    } finally {
      if (mountedRef.current && abortRef.current === ac) {
        setHasLog(true);
        setProgress(null);
        setBusy(false);
      }
    }
  };

  // ── Apply ────────────────────────────────────────────────────────────────
  const handleApply = async () => {
    const p = plan;
    const ctx = ctxRef.current;
    if (!p || !ctx) return;
    const log = logRef.current ?? new SyncLog();

    const selection: ApplySelection = {
      toCreateSources: p.toCreateSources.filter((e) => selected.has(e.id)),
      toUpdateSources: p.toUpdateSources
        .map((entry) => ({
          entry,
          fields: new Set<UpdatableField>(entry.changes.filter((c) => selected.has(`${entry.id}:${c.field}`)).map((c) => c.field)),
        }))
        .filter((x) => x.fields.size > 0),
      toAddHighlights: p.toAddHighlights
        .map((entry) => ({
          entry,
          highlightIds: new Set<number>(entry.highlights.filter((h) => selected.has(`${entry.id}:${h.id}`)).map((h) => h.id)),
        }))
        .filter((x) => x.highlightIds.size > 0),
      toAddSupplements: p.toAddSupplements
        .map((entry) => ({
          entry,
          highlightIds: new Set<number>(entry.highlights.filter((h) => selected.has(`${entry.id}:${h.id}`)).map((h) => h.id)),
        }))
        .filter((x) => x.highlightIds.size > 0),
      toMergeSupplementDocs: p.toMergeSupplementDocs.filter((m) => selected.has(m.id)),
      toFoldLookupDuplicates: p.toFoldLookupDuplicates.filter((d) => selected.has(d.id)),
    };

    const total =
      selection.toCreateSources.length +
      selection.toUpdateSources.length +
      selection.toAddHighlights.length +
      selection.toAddSupplements.length +
      selection.toMergeSupplementDocs.length +
      selection.toFoldLookupDuplicates.length;
    if (total === 0) {
      await plugin.app.toast('Nothing selected to apply.');
      return;
    }

    setBusy(true);
    setSyncApplying(true);
    setDone(new Set()); // a re-run after a thrown apply starts from a clean slate
    setFailed(new Set());
    setProgress({ completed: 0, total });
    setStatus('Applying…');
    try {
      const result = await applySyncPlan(
        plugin,
        selection,
        ctx,
        {
          onItemDone: (id, ok) => {
            setProgress((pr) => (pr ? { completed: pr.completed + 1, total: pr.total } : pr));
            (ok ? setDone : setFailed)((prev) => new Set(prev).add(id));
          },
        },
        log
      );
      setApplied(true);
      // The sync's own merge phase folds and deletes the documents the panel lists, so its plan is dead.
      setMigPlan(null);
      setMigSelected(new Set());
      setMigConfirm(false);
      // `problems` is for FAILURES only — anything listed there ends with "retry them".
      const problems: string[] = [];
      if (result.highlightsFailed) problems.push(`${result.highlightsFailed} highlight(s) failed`);
      if (result.failed) problems.push(`${result.failed} item(s) failed`);
      const msg =
        `Readwise sync applied — ${result.created} source(s) created, ${result.updated} updated, ` +
        `${result.highlightsAdded} highlight(s)` +
        (result.supplementsAdded ? ` and ${result.supplementsAdded} supplement(s)` : '') +
        ' added' +
        (result.mergedDocs ? `, ${result.mergedDocs} supplement document(s) folded in` : '') +
        (result.foldedLookups ? `, ${result.foldedLookups} duplicate lookup rem(s) folded` : '') +
        (problems.length ? `; ${problems.join(', ')}. Click Refresh to re-check and retry them.` : '.');
      setStatus(msg);
      await plugin.app.toast(msg);
    } catch (err) {
      const m = errText(err);
      log.log('error', m);
      setStatus(`Apply failed: ${m}`);
      await plugin.app.toast(`Readwise sync failed: ${m}`);
    } finally {
      setHasLog(true);
      setSyncApplying(false);
      setBusy(false);
    }
  };

  // ── One-time migration (temporary — remove with the panel at the bottom) ───────────────────────
  const migToggle = (id: string) =>
    setMigSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const handleMigPreview = async () => {
    setBusy(true);
    setMigConfirm(false);
    setMigStatus('Scanning your Readwise source documents…');
    const log = logRef.current ?? new SyncLog();
    logRef.current = log;
    try {
      const mp = await planSupplementMigration(plugin, log);
      setMigPlan(mp);
      setMigApplied(false); // only once a FRESH plan exists — a failed scan must not re-arm the button
      setMigSelected(new Set(mp.moves.map((m) => m.id)));
      setMigStatus(
        mp.legacy === 0
          ? `Nothing to migrate — none of the ${mp.scanned} source document(s) is a supplemental.`
          : `${mp.moves.length} supplemental document(s) can be folded in` +
              (mp.skipped.length ? `; ${mp.skipped.length} have no matching source and will be left alone.` : '.')
      );
    } catch (err) {
      const m = errText(err);
      log.log('error', m);
      // Drop the old plan: its rems may already be migrated (and removed), so it must not stay actionable.
      setMigPlan(null);
      setMigSelected(new Set());
      setMigStatus(`Migration preview failed: ${m}`);
      await plugin.app.toast(`Migration preview failed: ${m}`);
    } finally {
      setHasLog(true);
      setBusy(false);
    }
  };

  const handleMigApply = async () => {
    const mp = migPlan;
    if (!mp) return;
    const moves = mp.moves.filter((m) => migSelected.has(m.id));
    if (!moves.length) {
      await plugin.app.toast('Nothing selected to migrate.');
      return;
    }
    setBusy(true);
    setMigApplying(true);
    setMigConfirm(false);
    setMigDone(new Set());
    setMigFailed(new Set());
    setProgress({ completed: 0, total: moves.length });
    setMigStatus('Migrating…');
    const log = logRef.current ?? new SyncLog();
    logRef.current = log;
    try {
      const r = await applySupplementMigration(
        plugin,
        moves,
        {
          onItemDone: (id, ok) => {
            setProgress((pr) => (pr ? { completed: pr.completed + 1, total: pr.total } : pr));
            (ok ? setMigDone : setMigFailed)((prev) => new Set(prev).add(id));
          },
        },
        log
      );
      if (!mountedRef.current) return;
      setMigApplied(true);
      // The migration deleted documents the loaded sync plan may still reference, so that plan is dead.
      setPlan(null);
      setSelected(new Set());
      ctxRef.current = null;
      setStatus('Migration finished — click "Get from Readwise" for a fresh plan.');
      const msg =
        `Migration done — ${r.folded} document(s) folded in, ${r.bullets} bullet(s) moved` +
        (r.failed ? `, ${r.failed} failed (see the log).` : '.');
      setMigStatus(msg);
      await plugin.app.toast(msg);
    } catch (err) {
      const m = errText(err);
      log.log('error', m);
      setMigStatus(`Migration failed: ${m}`);
      await plugin.app.toast(`Migration failed: ${m}`);
    } finally {
      if (mountedRef.current) {
        setProgress(null);
        setHasLog(true);
        setMigApplying(false);
        setBusy(false);
      }
    }
  };

  // ── Render helpers ──────────────────────────────────────────────────────────
  const mark = (id: string) => (done.has(id) ? ' ✅' : failed.has(id) ? ' ❌' : '');

  /** Open/close + select-all props for a selectable `Section`, derived from the current state. */
  const sectionProps = (key: string, leafIds: string[]) => {
    const allOn = leafIds.length > 0 && leafIds.every((id) => selected.has(id));
    return {
      isOpen: !collapsed.has(key),
      onToggle: () => toggleCollapse(key),
      select: {
        allOn,
        someOn: leafIds.some((id) => selected.has(id)),
        disabled: busy || applied,
        onToggleAll: () => setMany(leafIds, !allOn),
      },
    };
  };

  const createLeafIds = plan ? plan.toCreateSources.map((e) => e.id) : [];
  // Group the "Will create" rows one level by category (sorted by category name); each category
  // becomes a collapsible sub-group with its own select-all + count.
  const createGroups: [string, SourceCreateEntry[]][] = [];
  if (plan) {
    const byCat = new Map<string, SourceCreateEntry[]>();
    for (const e of plan.toCreateSources) {
      const k = e.categoryLabel || 'Uncategorized';
      const arr = byCat.get(k);
      if (arr) arr.push(e);
      else byCat.set(k, [e]);
    }
    createGroups.push(...Array.from(byCat).sort((a, b) => a[0].localeCompare(b[0])));
  }
  const updateLeafIds = plan ? plan.toUpdateSources.flatMap((e) => e.changes.map((c) => `${e.id}:${c.field}`)) : [];
  const addLeafIds = plan ? plan.toAddHighlights.flatMap((e) => e.highlights.map((h) => `${e.id}:${h.id}`)) : [];
  const supLeafIds = plan ? plan.toAddSupplements.flatMap((e) => e.highlights.map((h) => `${e.id}:${h.id}`)) : [];
  const mergeLeafIds = plan ? plan.toMergeSupplementDocs.map((m) => m.id) : [];
  const dupLeafIds = plan ? plan.toFoldLookupDuplicates.map((d) => d.id) : [];

  const pct = progress && progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;
  // While an apply is in flight, hide the (potentially 1000+ row) results list AND the Log box.
  // Re-rendering that whole tree on every applied item — on top of the apply's own thousands of SDK
  // calls — can exhaust the plugin-widget iframe's renderer memory, and the browser kills the frame (the
  // grey "sad tab" crash on big syncs). During apply we render only a compact progress panel; the full
  // list returns with ✅/❌ once `applied` flips true. Keyed on the sync apply ALONE: the migration
  // below also sets `busy`, and it must not be mistaken for (or hidden by) a sync apply.
  const applying = syncApplying;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--rn-clr-background-primary, #fff)',
        color: 'var(--rn-clr-content-primary, #111)',
        fontSize: 14,
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid #e5e7eb' }}>
        <span style={{ fontWeight: 700, fontSize: 16 }}>Readwise Sync</span>
        <div style={{ flex: 1 }} />
        <button
          onClick={handlePreview}
          disabled={busy}
          style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #d1d5db', cursor: busy ? 'default' : 'pointer' }}
        >
          {plan ? 'Refresh' : 'Get from Readwise'}
        </button>
        <button
          onClick={handleApply}
          disabled={busy || applied || !plan}
          style={{
            padding: '6px 14px',
            borderRadius: 6,
            border: 'none',
            background: busy || applied || !plan ? '#9ca3af' : '#2563eb',
            color: '#fff',
            cursor: busy || applied || !plan ? 'default' : 'pointer',
          }}
        >
          Apply changes
        </button>
        <button
          onClick={() => plugin.widget.closePopup()}
          disabled={syncApplying || migApplying}
          title={
            syncApplying || migApplying
              ? 'Wait — closing now would leave the knowledge base half-written'
              : 'Close'
          }
          style={{
            padding: '4px 10px',
            borderRadius: 6,
            border: '1px solid #d1d5db',
            cursor: syncApplying || migApplying ? 'default' : 'pointer',
            opacity: syncApplying || migApplying ? 0.5 : 1,
          }}
        >
          ✕
        </button>
      </div>

      {/* Status + progress */}
      <div style={{ padding: '10px 16px' }}>
        <div style={{ marginBottom: progress ? 6 : 0 }}>{status}</div>
        {progress && (
          <div>
            <div style={{ height: 8, background: '#e5e7eb', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${pct}%`, background: '#2563eb' }} />
            </div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
              {progress.completed}/{progress.total}
            </div>
          </div>
        )}

        {warning && <div style={{ marginTop: 6, fontSize: 12, color: '#b45309' }}>⚠ {warning}</div>}

        {/* Tag filter: which tags are being matched, or that everything will be copied. */}
        <div style={{ marginTop: 6, fontSize: 12, color: '#6b7280' }}>
          {tags.length ? (
            <>
              Matching tags:{' '}
              <span style={{ color: '#374151', fontWeight: 600 }}>{tags.join(', ')}</span> — plus every
              highlight from a source that carries one of these tags.
            </>
          ) : (
            <>
              No tag filter set —{' '}
              <span style={{ color: '#374151', fontWeight: 600 }}>copying every highlight</span>. Set a tag
              filter in the plugin settings to narrow it.
            </>
          )}
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflow: 'auto', padding: '0 16px 16px 16px' }}>
        {plan && applying && (
          <div style={{ padding: '12px 4px', color: '#374151' }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Applying changes…</div>
            <div style={{ fontSize: 13, color: '#6b7280' }}>
              {done.size} done{failed.size ? ` · ${failed.size} failed` : ''}. The detailed list is hidden while
              applying to keep the popup light (a big sync can otherwise exhaust the popup’s memory and the
              browser closes it) — it reappears with ✅/❌ when finished.
            </div>
          </div>
        )}
        {plan && !applying && (
          <>
            <Section title="Will create (sources)" count={plan.toCreateSources.length} {...sectionProps('create', createLeafIds)}>
              {createGroups.map(([cat, entries]) => (
                // Indent each category group under "Will create"; rows (paddingLeft 44) sit a full step
                // DEEPER than the category header (its checkbox is ~22px in), so they read as nested
                // under the category, not level with it.
                <div key={cat} style={{ marginLeft: 16 }}>
                  <Section
                    title={cat}
                    count={entries.length}
                    {...sectionProps(`create:${cat}`, entries.map((e) => e.id))}
                  >
                    {entries.map((e) => (
                      <div key={e.id} style={{ ...rowStyle, paddingLeft: 44 }}>
                        <Check checked={selected.has(e.id)} disabled={busy || applied} onChange={() => toggle(e.id)} />
                        <span>
                          {e.name}
                          <span style={{ color: '#6b7280' }}>
                            {' '}· {e.eligible.length} highlight{e.eligible.length === 1 ? '' : 's'}
                            {e.supplements.length
                              ? ` · ${e.supplements.length} supplement${e.supplements.length === 1 ? '' : 's'}`
                              : ''}
                            {e.isSupplementDoc ? ' · no source document yet — held here until one appears' : ''}
                          </span>
                          {mark(e.id)}
                        </span>
                      </div>
                    ))}
                  </Section>
                </div>
              ))}
            </Section>

            <Section title="Will update source" count={plan.toUpdateSources.length} {...sectionProps('update', updateLeafIds)}>
              {plan.toUpdateSources.map((e) => (
                <div key={e.id} style={{ marginBottom: 6 }}>
                  <div style={{ fontWeight: 600 }}>
                    {e.name}
                    {mark(e.id)}
                  </div>
                  {e.changes.map((c) => (
                    <div key={`${e.id}:${c.field}`} style={{ ...rowStyle, paddingLeft: 16 }}>
                      <Check checked={selected.has(`${e.id}:${c.field}`)} disabled={busy || applied} onChange={() => toggle(`${e.id}:${c.field}`)} />
                      <span>
                        <b>{c.field}</b>: <span style={{ color: '#6b7280' }}>{c.fromDisplay}</span> → {c.toDisplay}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </Section>

            <Section title="Will add highlights" count={plan.toAddHighlights.length} {...sectionProps('add', addLeafIds)}>
              {plan.toAddHighlights.map((e) => (
                <div key={e.id} style={{ marginBottom: 6 }}>
                  <div style={{ fontWeight: 600 }}>
                    {e.name} <span style={{ color: '#6b7280' }}>(+{e.highlights.length})</span>
                    {mark(e.id)}
                  </div>
                  {e.highlights.map((h) => (
                    <div key={`${e.id}:${h.id}`} style={{ ...rowStyle, paddingLeft: 16 }}>
                      <Check checked={selected.has(`${e.id}:${h.id}`)} disabled={busy || applied} onChange={() => toggle(`${e.id}:${h.id}`)} />
                      <span>{clip(h.text)}</span>
                    </div>
                  ))}
                </div>
              ))}
            </Section>

            <Section title="Will add supplements" count={plan.toAddSupplements.length} {...sectionProps('sup', supLeafIds)}>
              {plan.toAddSupplements.map((e) => (
                <div key={e.id} style={{ marginBottom: 6 }}>
                  <div style={{ fontWeight: 600 }}>
                    {e.name} <span style={{ color: '#6b7280' }}>(+{e.highlights.length} under “Supplements”)</span>
                    {mark(e.id)}
                  </div>
                  {e.highlights.map((h) => (
                    <div key={`${e.id}:${h.id}`} style={{ ...rowStyle, paddingLeft: 16 }}>
                      <Check checked={selected.has(`${e.id}:${h.id}`)} disabled={busy || applied} onChange={() => toggle(`${e.id}:${h.id}`)} />
                      <span>{clip(h.text)}</span>
                    </div>
                  ))}
                </div>
              ))}
            </Section>

            <Section
              title="Will merge supplement documents into their source"
              count={plan.toMergeSupplementDocs.length}
              {...sectionProps('merge', mergeLeafIds)}
            >
              {plan.toMergeSupplementDocs.map((m) => (
                <div key={m.id} style={{ ...rowStyle, paddingLeft: 16 }}>
                  <Check checked={selected.has(m.id)} disabled={busy || applied} onChange={() => toggle(m.id)} />
                  <span>
                    {m.supplementName} <span style={{ color: '#6b7280' }}>→ {m.targetName}</span>
                    <span style={{ color: '#6b7280' }}>
                      {' '}· its bullets move under “Supplements”
                      {m.bulletCount === undefined
                        ? m.ledgerCount
                          ? ` (${m.ledgerCount} highlight${m.ledgerCount === 1 ? '' : 's'} recorded)`
                          : ''
                        : ` (${m.bulletCount} bullet${m.bulletCount === 1 ? '' : 's'})`}
                      , then the document is deleted once empty
                    </span>
                    {mark(m.id)}
                  </span>
                </div>
              ))}
            </Section>

            <Section
              title="Will fold duplicate Author / Category / Location rems"
              count={plan.toFoldLookupDuplicates.length}
              {...sectionProps('dup', dupLeafIds)}
            >
              {plan.toFoldLookupDuplicates.map((d) => (
                <div key={d.id} style={{ ...rowStyle, paddingLeft: 16 }}>
                  <Check checked={selected.has(d.id)} disabled={busy || applied} onChange={() => toggle(d.id)} />
                  <span>
                    <b>{d.name}</b> <span style={{ color: '#6b7280' }}>in {d.docName}</span>
                    <span style={{ color: '#6b7280' }}>
                      {' '}· a duplicate copy is merged into the oldest one
                      {d.childCount ? `, moving ${d.childCount} child rem${d.childCount === 1 ? '' : 's'}` : ''}
                      {d.referenceCount
                        ? ` and re-pointing ${d.referenceCount} reference${d.referenceCount === 1 ? '' : 's'}`
                        : ''}
                      , then the duplicate is deleted
                    </span>
                    {mark(d.id)}
                  </span>
                </div>
              ))}
            </Section>

            <Section
              title="Already in sync"
              count={plan.alreadyInSync.length}
              isOpen={!collapsed.has('already')}
              onToggle={() => toggleCollapse('already')}
            >
              {plan.alreadyInSync.map((e) => (
                <div key={e.id} style={{ ...rowStyle, color: '#6b7280' }}>
                  <span style={{ width: 22 }} />
                  <span>{e.name}</span>
                </div>
              ))}
            </Section>
          </>
        )}

        {/* ── One-time migration panel. TEMPORARY: delete this block (and the handlers + the migration
            functions in sync.ts) once every knowledge base has been migrated. ── */}
        {!applying && (
          <div style={{ ...sectionStyle, borderColor: '#fcd34d' }}>
            <div style={headerStyle} onClick={() => toggleCollapse('migrate')}>
              <span style={{ width: 14 }}>{collapsed.has('migrate') ? '▸' : '▾'}</span>
              <span>Fallback — fold leftover “Supplemental” documents in</span>
            </div>
            {!collapsed.has('migrate') && (
              <div style={bodyStyle}>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8, lineHeight: 1.5 }}>
                  <b>You usually don’t need this.</b> The normal sync stages a <b>Will merge supplement documents</b> row
                  on its own for every supplement document it can match — including ones whose Readwise source has since
                  been deleted, which it recognises by their Category property and their name. Titles arrive as ordinary{' '}
                  <b>name</b> rows. This panel is a fallback for when you want to fold documents in <b>without fetching
                  from Readwise at all</b> (offline, or a bad token). It does the same thing: moves their bullets under the{' '}
                  <b>Supplements</b> heading of the matching source document, merges the sync records, then deletes the
                  emptied document. Highlights are <b>moved, not copied</b>, so edits, tags and flashcards are kept.
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <button onClick={handleMigPreview} disabled={busy} style={{ ...smallBtn, padding: '4px 10px' }}>
                    {migPlan ? 'Re-scan' : 'Preview migration'}
                  </button>
                  {migPlan && migPlan.moves.length > 0 && !migApplied && (
                    !migConfirm ? (
                      <button
                        onClick={() => setMigConfirm(true)}
                        disabled={busy || migSelected.size === 0}
                        style={{ ...smallBtn, padding: '4px 10px', borderColor: '#b45309', color: '#b45309' }}
                      >
                        Migrate {migSelected.size} document{migSelected.size === 1 ? '' : 's'}
                      </button>
                    ) : (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ color: '#b45309', fontSize: 12 }}>
                          Move the bullets of {migSelected.size} document{migSelected.size === 1 ? '' : 's'} and delete the
                          emptied document{migSelected.size === 1 ? '' : 's'}?
                        </span>
                        <button
                          onClick={handleMigApply}
                          disabled={busy}
                          style={{ ...smallBtn, borderColor: '#dc2626', color: '#dc2626' }}
                        >
                          Migrate
                        </button>
                        <button onClick={() => setMigConfirm(false)} disabled={busy} style={smallBtn}>
                          Cancel
                        </button>
                      </span>
                    )
                  )}
                  {migStatus && <span style={{ fontSize: 12, color: '#374151' }}>{migStatus}</span>}
                </div>

                {migPlan?.moves.map((m) => (
                  <div key={m.id} style={{ ...rowStyle, paddingLeft: 4 }}>
                    <Check
                      checked={migSelected.has(m.id)}
                      disabled={busy || migApplied}
                      onChange={() => migToggle(m.id)}
                    />
                    <span>
                      {m.supplementName} <span style={{ color: '#6b7280' }}>→ {m.targetName}</span>
                      <span style={{ color: '#6b7280' }}>
                        {' '}· {m.bulletCount} bullet{m.bulletCount === 1 ? '' : 's'}
                      </span>
                      {migDone.has(m.id) ? ' ✅' : migFailed.has(m.id) ? ' ❌' : ''}
                    </span>
                  </div>
                ))}
                {migPlan?.skipped.map((k) => (
                  <div key={k.id} style={{ ...rowStyle, paddingLeft: 4, color: '#6b7280' }}>
                    <span style={{ width: 22 }} />
                    <span>
                      {k.name} · left alone ({k.reason})
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* The Log box is also hidden while applying: its text is re-joined from every line on each
            render, which would otherwise happen once per applied item. */}
        {hasLog && !applying && (
          <div style={sectionStyle}>
            <div style={headerStyle} onClick={() => toggleCollapse('log')}>
              <span style={{ width: 14 }}>{collapsed.has('log') ? '▸' : '▾'}</span>
              <span>Log</span>
              <div style={{ flex: 1 }} />
              <button
                onClick={async (ev) => {
                  ev.stopPropagation();
                  const ok = await copyToClipboard(logRef.current?.toText() ?? '');
                  await plugin.app.toast(ok ? 'Log copied to clipboard.' : 'Could not copy the log.');
                }}
                style={{ padding: '2px 8px', borderRadius: 6, border: '1px solid #d1d5db', cursor: 'pointer' }}
              >
                Copy
              </button>
            </div>
            {!collapsed.has('log') && (
              <pre
                style={{
                  margin: 0,
                  padding: '8px 12px',
                  maxHeight: 240,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  fontSize: 12,
                  background: '#f9fafb',
                }}
              >
                {logRef.current?.toText() ?? ''}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

renderWidget(ReadwiseSync);
