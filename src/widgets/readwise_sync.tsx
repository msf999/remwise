import { renderWidget, usePlugin } from '@remnote/plugin-sdk';
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import { SETTINGS, STORAGE, type UpdatableField } from '../lib/consts';
import { SyncLog } from '../lib/log';
import {
  fetchExport,
  fetchReaderDocs,
  getIncludedCategories,
  isToastedError,
  parseTagFilter,
  verifyToken,
} from '../lib/readwiseApi';
import {
  applySyncPlan,
  type ApplySelection,
  buildSyncContext,
  computeSyncPlan,
  type SourceCreateEntry,
  type SyncContext,
  type SyncPlan,
} from '../lib/sync';
import type { ReaderInfo } from '../lib/types/readwise';

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

export const ReadwiseSync = () => {
  const plugin = usePlugin();

  const [status, setStatus] = useState('Ready. Click "Get from Readwise" to preview what will sync.');
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(false);
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(['already', 'log']));
  const [hasLog, setHasLog] = useState(false);
  const [incremental, setIncremental] = useState(false);
  const [lastSync, setLastSync] = useState('');
  const [resetConfirm, setResetConfirm] = useState(false);
  const [tags, setTags] = useState<string[]>([]);

  const ctxRef = useRef<SyncContext | null>(null);
  const logRef = useRef<SyncLog | null>(null);
  const runStartRef = useRef<string>('');
  const previewStartedRef = useRef(false);

  // On open: show the current mode + last-sync, AND validate the token so a missing/invalid one is
  // caught right here (with a friendly pointer to settings) instead of mid-fetch as an HTTP 401.
  // Guarded by `cancelled` (unmount) + `previewStartedRef` (the user clicking "Get from Readwise"
  // mid-check) so the async verify result never clobbers a fetch that's already underway.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const inc = !!(await plugin.settings.getSetting<boolean>(SETTINGS.incremental));
      const last = (await plugin.storage.getSynced<string>(STORAGE.lastSyncDate)) || '';
      const tagList = parseTagFilter(await plugin.settings.getSetting<string>(SETTINGS.tagFilter));
      const token = (await plugin.settings.getSetting<string>(SETTINGS.apiKey))?.trim();
      if (cancelled || previewStartedRef.current) return;
      setIncremental(inc);
      setLastSync(last);
      setTags(tagList);
      if (!token) {
        setStatus('No Readwise token set — add one in the plugin settings (readwise.io/access_token) to sync.');
        return;
      }
      setStatus('Checking your Readwise token…');
      const ok = await verifyToken(token);
      if (cancelled || previewStartedRef.current) return;
      setStatus(
        ok
          ? 'Ready. Click "Get from Readwise" to preview what will sync.'
          : 'Readwise token looks invalid — check it in the plugin settings (readwise.io/access_token).'
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
    setBusy(true);
    setApplied(false);
    setPlan(null);
    setDone(new Set());
    setFailed(new Set());
    setProgress(null);
    const log = new SyncLog();
    logRef.current = log;
    try {
      const incremental = !!(await plugin.settings.getSetting<boolean>(SETTINGS.incremental));
      const lastSync = (await plugin.storage.getSynced<string>(STORAGE.lastSyncDate)) || '';
      const updatedAfter = incremental && lastSync ? lastSync : undefined;
      const tagList = parseTagFilter(await plugin.settings.getSetting<string>(SETTINGS.tagFilter));
      const included = await getIncludedCategories(plugin);
      runStartRef.current = new Date().toISOString();

      setStatus(updatedAfter ? `Fetching changes since ${lastSync}…` : 'Fetching your full Readwise library…');
      const { sources } = await fetchExport(plugin, {
        updatedAfter,
        onProgress: (s, h, total) => {
          setProgress({ completed: s, total: Math.max(total || s, s) });
          setStatus(`Fetched ${s} sources, ${h} highlights…`);
        },
        log,
      });

      setProgress(null);
      setStatus('Fetching Readwise Reader locations… (≈20 requests/min)');
      const readerByExternalId: Map<string, ReaderInfo> = await fetchReaderDocs(plugin, {
        updatedAfter,
        onProgress: (n) => setStatus(`Fetching Readwise Reader locations… ${n} docs (≈20 requests/min)`),
        log,
      });

      setStatus('Comparing against RemNote…');
      const ctx = await buildSyncContext(plugin, { tagList, included, readerByExternalId, log });
      ctxRef.current = ctx;
      const p = await computeSyncPlan(plugin, sources, ctx, log);
      setPlan(p);

      // Default selection: everything actionable is ticked.
      const sel = new Set<string>();
      for (const e of p.toCreateSources) sel.add(e.id);
      for (const e of p.toUpdateSources) for (const c of e.changes) sel.add(`${e.id}:${c.field}`);
      for (const e of p.toAddHighlights) for (const h of e.highlights) sel.add(`${e.id}:${h.id}`);
      setSelected(sel);

      const hlToAdd = p.toAddHighlights.reduce((n, g) => n + g.highlights.length, 0);
      setStatus(
        p.toCreateSources.length + p.toUpdateSources.length + hlToAdd === 0
          ? p.fetchedSources === 0
            ? 'No sources found matching your tag filter — try clearing the filter to see everything.'
            : 'Everything is already in sync.'
          : `Found ${p.fetchedSources} sources (${p.matchingHighlights} matching highlights) — ` +
              `${p.toCreateSources.length} to create, ${p.toUpdateSources.length} source update(s), ${hlToAdd} highlight(s) to add.`
      );
    } catch (err) {
      log.log('error', err instanceof Error ? err.message : String(err));
      if (!isToastedError(err)) await plugin.app.toast(`Readwise sync failed: ${err instanceof Error ? err.message : String(err)}`);
      setStatus(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setHasLog(!!logRef.current);
      setProgress(null);
      setBusy(false);
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
    };

    const total = selection.toCreateSources.length + selection.toUpdateSources.length + selection.toAddHighlights.length;
    if (total === 0) {
      await plugin.app.toast('Nothing selected to apply.');
      return;
    }

    setBusy(true);
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
      // Stamp the last-sync date (run-start) on a fully-successful apply — used by incremental mode.
      if (result.failed === 0 && runStartRef.current) {
        await plugin.storage.setSynced(STORAGE.lastSyncDate, runStartRef.current);
        setLastSync(runStartRef.current);
      }
      setApplied(true);
      const msg =
        `Readwise sync applied — ${result.created} source(s) created, ${result.updated} updated, ` +
        `${result.highlightsAdded} highlight(s) added` +
        (result.failed ? `, ${result.failed} failed. Re-run to retry the failed items.` : '.');
      setStatus(msg);
      await plugin.app.toast(msg);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      log.log('error', m);
      setStatus(`Apply failed: ${m}`);
      await plugin.app.toast(`Readwise sync failed: ${m}`);
    } finally {
      setHasLog(true);
      setBusy(false);
    }
  };

  // Clear the stored last-sync date → the next sync fetches everything (full). Two-step confirm in the
  // UI (`resetConfirm`) guards against an accidental click. Replaces the old "Readwise: Reset last sync"
  // command.
  const handleResetLastSync = async () => {
    await plugin.storage.setSynced(STORAGE.lastSyncDate, '');
    setLastSync('');
    setResetConfirm(false);
    await plugin.app.toast(
      'Last-sync date cleared. Your next sync re-checks your whole Readwise library — already-synced ' +
        'items stay “Already in sync”; nothing is re-imported or duplicated.'
    );
  };

  // ── Render helpers ──────────────────────────────────────────────────────────
  const rowStyle: CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '3px 0' };
  const smallBtn: CSSProperties = {
    padding: '2px 8px',
    borderRadius: 5,
    border: '1px solid #d1d5db',
    background: 'transparent',
    color: 'inherit',
    fontSize: 12,
    cursor: 'pointer',
  };
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
  const mark = (id: string) => (done.has(id) ? ' ✅' : failed.has(id) ? ' ❌' : '');

  const Section = (props: {
    keyName: string;
    title: string;
    count: number;
    leafIds: string[];
    selectable?: boolean;
    children: ReactNode;
  }) => {
    const isOpen = !collapsed.has(props.keyName);
    const selectableLeaves = props.leafIds;
    const allOn = selectableLeaves.length > 0 && selectableLeaves.every((id) => selected.has(id));
    const someOn = selectableLeaves.some((id) => selected.has(id));
    if (props.count === 0) return null;
    return (
      <div style={sectionStyle}>
        <div style={headerStyle} onClick={() => toggleCollapse(props.keyName)}>
          <span style={{ width: 14 }}>{isOpen ? '▾' : '▸'}</span>
          {props.selectable !== false && (
            <span onClick={(e) => e.stopPropagation()}>
              <Check checked={allOn} indeterminate={someOn} disabled={busy || applied} onChange={() => setMany(selectableLeaves, !allOn)} />
            </span>
          )}
          <span>
            {props.title} ({props.count})
          </span>
        </div>
        {isOpen && <div style={bodyStyle}>{props.children}</div>}
      </div>
    );
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

  const pct = progress && progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;
  // While an apply is in flight, hide the (potentially 1000+ row) results list. Re-rendering that whole
  // tree on every applied item — on top of the apply's own thousands of SDK calls — can exhaust the
  // plugin-widget iframe's renderer memory, and the browser kills the frame (the grey "sad tab" crash on
  // big syncs). During apply we render only a compact progress panel; the full list returns with ✅/❌
  // once `applied` flips true. (Preview keeps `plan` null, so this is false then.)
  const applying = !!plan && busy && !applied;

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
          title="Close"
          style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid #d1d5db', cursor: 'pointer' }}
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

        {/* Mode + last-sync, with a confirm-gated Reset last sync button (replaces the old command). */}
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#6b7280' }}>
          <span>
            {incremental ? 'Quick' : 'Full'} sync{lastSync ? ` · last synced ${lastSync}` : ' · no stored last-sync date'}
          </span>
          <div style={{ flex: 1 }} />
          {!resetConfirm ? (
            <button
              onClick={() => setResetConfirm(true)}
              disabled={busy || !lastSync}
              title={lastSync ? 'Clear the stored last-sync date so the next sync re-checks your whole Readwise library (already-synced items aren’t re-imported)' : 'No stored last-sync date to reset'}
              style={{ ...smallBtn, opacity: busy || !lastSync ? 0.5 : 1, cursor: busy || !lastSync ? 'default' : 'pointer' }}
            >
              Reset last sync
            </button>
          ) : (
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: '#b45309' }}>
                Next sync re-checks your whole library (already-synced items aren’t re-imported). Reset?
              </span>
              <button
                onClick={handleResetLastSync}
                disabled={busy}
                style={{ ...smallBtn, borderColor: '#dc2626', color: '#dc2626' }}
              >
                Reset
              </button>
              <button onClick={() => setResetConfirm(false)} disabled={busy} style={smallBtn}>
                Cancel
              </button>
            </span>
          )}
        </div>

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
            <Section keyName="create" title="Will create (sources)" count={plan.toCreateSources.length} leafIds={createLeafIds}>
              {createGroups.map(([cat, entries]) => (
                // Indent each category group under "Will create"; rows (paddingLeft 44) sit a full step
                // DEEPER than the category header (its checkbox is ~22px in), so they read as nested
                // under the category, not level with it.
                <div key={cat} style={{ marginLeft: 16 }}>
                  <Section
                    keyName={`create:${cat}`}
                    title={cat}
                    count={entries.length}
                    leafIds={entries.map((e) => e.id)}
                  >
                    {entries.map((e) => (
                      <div key={e.id} style={{ ...rowStyle, paddingLeft: 44 }}>
                        <Check checked={selected.has(e.id)} disabled={busy || applied} onChange={() => toggle(e.id)} />
                        <span>
                          {e.name}
                          <span style={{ color: '#6b7280' }}>
                            {' '}· {e.eligible.length} highlight{e.eligible.length === 1 ? '' : 's'}
                          </span>
                          {mark(e.id)}
                        </span>
                      </div>
                    ))}
                  </Section>
                </div>
              ))}
            </Section>

            <Section keyName="update" title="Will update source" count={plan.toUpdateSources.length} leafIds={updateLeafIds}>
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

            <Section keyName="add" title="Will add highlights" count={plan.toAddHighlights.length} leafIds={addLeafIds}>
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

            <Section keyName="already" title="Already in sync" count={plan.alreadyInSync.length} leafIds={[]} selectable={false}>
              {plan.alreadyInSync.map((e) => (
                <div key={e.id} style={{ ...rowStyle, color: '#6b7280' }}>
                  <span style={{ width: 22 }} />
                  <span>{e.name}</span>
                </div>
              ))}
            </Section>
          </>
        )}

        {hasLog && (
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
