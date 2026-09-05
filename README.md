<div align="center">

<img src="public/logo.png" alt="Remwise" width="120" height="120" />

# Remwise

**Sync your tagged Readwise highlights into Remnote — curated, one-way, add-only.**

</div>

Remwise is a [Remnote](https://www.remnote.com) plugin that imports your **Readwise** highlights into
Remnote. You tag the highlights you want in Readwise, and Remwise copies just those into a `Readwise/`
hierarchy — each book, article, tweet, or podcast becomes a source **document** carrying its metadata
as properties, with its highlights as bullets beneath it.

> [!IMPORTANT]
> **Add-only — your highlights stay yours.** Once a highlight is in Remnote, Remwise never edits or
> deletes it: you own it (make flashcards, add notes, rearrange it freely). It only ever *appends* new
> matching highlights and keeps each source's own metadata in step. Readwise-side highlight edits and
> deletes do **not** propagate, and nothing in Remnote is ever removed.

> [!WARNING]
> **Vibe-coded — experimental.** Remwise was built largely by prompting an AI assistant, with light
> human review. It's add-only (so it can't delete your highlights), but it's still young — **back up
> your Remnote knowledge base** before relying on it, and expect rough edges.

---

## What it does

### Highlight sync (Readwise → Remnote)
- **Each source → a document** under `Readwise/Sources` (added newest-first), tagged the **`Readwise
  Source`** powerup — one doc per book, article, tweet, or podcast.
- **Titled `Author - Title`**, so every author's works sit together when you sort by name, and the
  author is visible on a flashcard's source in the queue. Sources with no author keep just the title.
- **Supplemental highlights** (Readwise's curated popular highlights for a book) are *not* a separate
  document: they live under a **Supplements** heading inside the book's own document, matched by title
  and author. New ones are added at the bottom of that section. If the book itself isn't in Remnote yet,
  they're kept in a `… - Supplement` document instead of being dropped, and folded into the book
  automatically once it arrives.
- **Tag-filtered import.** Set a comma-separated tag filter and Remwise copies only highlights carrying
  one of those tags — **or**, if a whole *source* carries the tag in Readwise, all of its highlights.
  Leave the filter empty to copy everything.
- **Highlights as bullets.** Each highlight is a plain bullet: the text (with its **Readwise color**
  applied as a Remnote highlight, if you turn that setting on), a trailing **📌 pin** linking back to
  the highlight on Readwise, and a **note child bullet** when the highlight has a note. A source's
  summary / document note is written into the body once, on creation.
- **Rich source metadata** as properties — **Author**, **Category**, **Location**, **Link**,
  **Readwise**, **Cover**. Author / Category / Location are **references** into deduped lookup docs
  (`Readwise/Authors`, `/Categories`, `/Locations`) so you can click through and see everything filed
  under each. Plus an empty **Tags** multi-select that's yours to fill.
- **Reader inbox/archive location** via the Readwise Reader API — each source shows where it lives in
  Reader (Inbox / Later / Shortlist / Archive / Feed), kept up to date even when a source only *moves*
  without gaining highlights.
- **Per-source metadata kept in sync.** If an author / category / location / link or the title changes
  in Readwise, the preview offers an opt-out *Will update source* row.
- **Smart, collision-proof titles.** Same-titled sources are disambiguated symmetrically (`Title` →
  `Title — Author` → `Title — Author — Category` → `… — [id]`), so two books with the same name never
  clash.

### Incremental Everything (optional)
When enabled, every source Remwise creates — and any existing source that earns its first new highlight
— is enrolled in the [Incremental Everything](https://github.com/bjsi/incremental-everything) plugin
(added to its queue, due today). Requires that plugin installed; otherwise silently skipped.

### Preview-then-apply
The **Sync Readwise** popup never changes anything until you say so. **Get from Readwise** fetches your
library and shows the plan grouped into collapsible, selectable categories — *Will create (sources)*
(grouped by category), *Will update source*, *Will add highlights*, and read-only *Already in sync* —
with per-row and select-all checkboxes, a live fetch progress bar, then per-item ✅/❌ and a completion
toast. A collapsible **Log** box (with a copy button) shows the full diagnostic log.

---

## How your library looks in Remnote

Remwise creates one top-level **`Readwise`** document and files everything beneath it:

```
Readwise/
├─ Sources/               — one document per source (added newest-first)
│  ├─ James Clear - Atomic Habits      ← tagged the "Readwise Source" powerup
│  │  ├─ … the book's own highlights …
│  │  └─ Supplements                    ← heading: Readwise's curated popular highlights
│  ├─ Jane Doe - Some Article — Books   ← disambiguated when a title+author pair collides
│  └─ …
├─ Categories/            — lookup docs the Category property references
│  ├─ Books
│  ├─ Articles
│  ├─ Tweets
│  └─ Podcasts
├─ Authors/               — one rem per author
│  ├─ James Clear
│  └─ …
└─ Locations/             — the Reader location each source lives in
   ├─ Inbox
   ├─ Later
   ├─ Shortlist
   ├─ Archive
   ├─ Feed
   └─ Not in Reader       ← sources that aren't Reader documents
```

**Each source document** is tagged the **`Readwise Source`** powerup and carries its metadata as
properties at the top of the document:

| Property | Holds |
| --- | --- |
| **Author** | → reference into `Readwise/Authors` |
| **Category** | → reference into `Readwise/Categories` (Books / Articles / Tweets / Podcasts / Supplementals) |
| **Location** | → reference into `Readwise/Locations` — the Reader location (Inbox / Later / Shortlist / Archive / Feed), or _Not in Reader_. (Left blank if the Reader sweep couldn't finish that run — the popup warns you, and the next sync that reaches the document fills it in.) |
| **Link** | the source's URL, as a clickable link |
| **Readwise** | a link to the source on Readwise |
| **Cover** | the source's cover image |
| **Tags** | _yours to edit_ — an empty multi-select Remwise never touches |

Beneath the properties sit the source's summary / document note (written once, on creation), then its
**highlights** (each a plain bullet: the highlighted text + a 📌 link back to Readwise + an optional
note child), and finally a **Supplements** heading holding Readwise's curated popular highlights for
that source, if it has any. Each source also carries hidden bookkeeping slots — Readwise Book ID, Base Title, Reader Doc
ID, the synced-highlight ledger, and Last Synced — that track sync identity; they aren't shown.

Because **Author / Category / Location are references** into the shared lookup docs, those docs double
as automatic indexes — open *Authors → "James Clear"* and Remnote's references panel lists every source
by him.

> [!TIP]
> The **Tags** property is yours to fill — it works best as a **Multi Select**. If it shows as plain
> text, click the property → **Property Type** → **Multi Select**. (Fresh installs already register it
> that way.)

---

## Setup — connecting your Readwise account

1. Open **[readwise.io/access_token](https://readwise.io/access_token)** (signed in to Readwise) and
   copy your **access token**. A read-only token is fine — Remwise only ever *reads* from Readwise.
2. In Remnote, open the plugin's settings (**Settings → Plugins → Remwise**, or the **Build** tab while
   developing from localhost) and paste it into **Readwise access token**. Optionally set **Tags to
   copy** — a comma-separated list of the tags you want imported.
3. **Type `/` anywhere** and run **Sync Readwise** (or use the quick code `rw`) to open the popup →
   **Get from Readwise** to preview, then **Apply changes** for the rows you tick.

> Remwise opens straight into a preview and **checks your token when the popup opens**, telling you if
> it's missing or invalid — so nothing fails mid-fetch.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| **Readwise access token** | — | Your token from [readwise.io/access_token](https://readwise.io/access_token). A read-only token is fine. **Required.** |
| **Tags to copy (comma-separated)** | _(empty)_ | Copy highlights carrying one of these tags (case-insensitive); if a SOURCE itself carries the tag, ALL of its highlights are copied. Empty = copy every highlight. Tip: start with a single tag (e.g. `science`) to see how it looks. |
| **Apply highlight colors** | Off | On = each highlight's Readwise color (yellow / blue / pink / orange / green / purple) is applied as a Remnote highlight color. Off = highlights import as plain text. |
| **Include Books / Articles / Tweets / Podcasts / Supplementals** | On (each) | Five toggles — include each Readwise category when syncing. Turn all five off and nothing syncs (the popup tells you so). *Supplementals* adds curated popular highlights to the **Supplements** section of the matching source, not a document of its own. |
| **Make source docs Incremental** | Off | Enrol source documents into [Incremental Everything](https://github.com/bjsi/incremental-everything) (due today): every new source, and any existing source that gains a new highlight. Requires that plugin (otherwise silently skipped). Reload Incremental Everything (or Remnote) after a sync for enrolled docs to enter the queue. |

> [!NOTE]
> **Upgrading from an earlier version?** Just sync. Existing documents are renamed to `Author - Title`
> as ordinary *Will update source → name* rows, and any document an older version created for a
> supplemental turns up as a *Will merge supplement documents* row that **moves** its bullets (so your
> edits, tags and flashcards are kept) under the source's Supplements heading and deletes the emptied
> document. Review and apply them like anything else. The popup's fallback panel is only for a
> supplemental you have since deleted in Readwise, which a sync can no longer see.

> [!NOTE]
> Every sync re-checks your **whole** Readwise library (one export call, plus a throttled sweep of your
> Reader documents for their locations). Already-synced items stay _Already in sync_ — nothing is ever
> re-imported or duplicated, so applying a few rows at a time is always safe.
