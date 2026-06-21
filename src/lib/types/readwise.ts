/** A tag on a Readwise source or highlight. */
export interface ReadwiseTag {
  id: number;
  name: string;
}

/** One Readwise highlight (a child of a source in the v2 export). */
export interface ReadwiseHighlight {
  id: number;
  text: string;
  note?: string | null;
  location?: number | null;
  location_type?: string | null;
  color?: string | null;
  highlighted_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  url?: string | null;
  readwise_url?: string | null;
  book_id?: number;
  tags?: ReadwiseTag[];
  is_favorite?: boolean;
  is_deleted?: boolean;
}

/** A Readwise source (book / article / tweet / podcast / supplemental) from the v2 export. */
export interface ReadwiseSource {
  user_book_id: number;
  title?: string;
  author?: string | null;
  readable_title?: string;
  source?: string | null;
  cover_image_url?: string | null;
  unique_url?: string | null;
  book_tags?: ReadwiseTag[];
  category?: string | null;
  readwise_url?: string | null;
  source_url?: string | null;
  asin?: string | null;
  document_note?: string | null;
  summary?: string | null;
  /** Reference to the source doc in its origin system; present only when `source === 'reader'`
   *  — it equals the Reader (v3) document id, the bridge to the Reader API for location/url. */
  external_id?: string | null;
  is_deleted?: boolean;
  highlights: ReadwiseHighlight[];
}

/** One page of the v2 export endpoint. */
export interface ReadwiseExportPage {
  count: number;
  nextPageCursor?: string | null;
  results: ReadwiseSource[];
}

/** A Reader (v3) document — we read only the fields we need for location + URLs. */
export interface ReaderDoc {
  id: string;
  url?: string | null;
  source_url?: string | null;
  /** One of: new | later | shortlist | archive | feed. */
  location?: string | null;
  category?: string | null;
}

/** One page of the Reader (v3) `/list/` endpoint. */
export interface ReaderListPage {
  count: number;
  nextPageCursor?: string | null;
  results: ReaderDoc[];
}

/** What we keep from a Reader doc, keyed by Reader doc id, joined to v2 books by `external_id`. */
export interface ReaderInfo {
  location?: string | null;
  url?: string | null;
  sourceUrl?: string | null;
}
