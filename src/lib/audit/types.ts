/**
 * A DEFENSIVE mirror of the Funnel Audit API response.
 *
 * The API's own `src/analysis/landing_types.ts` is the source of truth and is
 * strictly typed there. Here every field is optional on purpose: this app must
 * survive a schema that grows, a section that is absent for a given page, and
 * a value that comes back null or unknown. Nothing in the dashboard may assume
 * a field exists.
 */

export type IssueSeverity = "critical" | "high" | "medium" | "low" | "informational";

export type Determination<T> =
  | { status: "detected"; value: T; confidence?: number; evidence?: string[] }
  | { status: "unknown"; reason?: string };

export interface RawObservedIssue {
  id?: string;
  severity?: IssueSeverity | string;
  category?: string;
  title?: string;
  description?: string;
  evidence?: string[];
  recommendation?: string;
  impact?: string;
  confidence?: number;
  severity_rationale?: string;
}

export interface PageStrip {
  index: number;
  offset_y: number;
  height: number;
  width: number;
  media_type: string;
  data: string;
}

export interface RawScreenshot {
  captured?: boolean;
  page_height?: number;
  truncated?: boolean;
  strips?: PageStrip[];
  note?: string | null;
}

export interface RawAnalysis {
  /** Strips of the rendered page. Present only because we asked for them. */
  screenshot?: RawScreenshot | null;
  schema_version?: string;
  analyzed_at?: string;
  duration_ms?: number;

  funnel?: {
    requested_url?: string;
    final_url?: string;
    domain?: string;
    root_domain?: string;
    redirected?: boolean;
    funnel_type?: Determination<string>;
    page_type_classification?: { page_type?: string; confidence?: number; evidence?: string[] };
    brand_name?: Determination<string>;
    primary_conversion_goal?: Determination<string>;
    business_identity?: {
      domain?: string;
      root_domain?: string;
      brand_name?: string | null;
      organization_names?: string[];
      contact_emails?: string[];
      contact_phones?: string[];
      social_profiles?: { platform?: string; url?: string }[];
      copyright_holders?: string[];
    };
  };

  page?: {
    url?: string;
    final_url?: string;
    http_status?: number | null;
    title?: string | null;
    meta_description?: string | null;
    language?: string | null;
    visible_text?: { characters?: number; words?: number; truncated?: boolean; text?: string };
    dimensions?: { fold_height?: number; viewport_height?: number };
  };

  hero?: {
    headline?: string | null;
    subheadline?: string | null;
    supporting_copy?: string[];
    primary_cta?: { text?: string; href?: string | null; above_fold?: boolean } | null;
    cta_above_fold?: boolean;
    offer?: string | null;
    trust_elements?: { kind?: string; text?: string }[];
    media?: { kind?: string; provider?: string | null };
    value_proposition?: Determination<{ clarity?: string; statement?: string | null }>;
  };

  copy?: {
    word_count?: number;
    key_messages?: string[];
    above_fold_copy?: string[];
    benefit_statements?: { text?: string }[];
    faq?: { question?: string; answer?: string | null }[];
  };

  videos?: { provider?: string; above_fold?: boolean; visible?: boolean }[];
  vsl?: { determination?: Determination<{ video_index?: number; provider?: string }> };

  ctas?: {
    text?: string;
    type?: string;
    above_fold?: boolean;
    visible?: boolean;
    is_primary?: boolean;
    is_form_submit?: boolean;
    form_index?: number | null;
    destination?: { kind?: string; url?: string | null; provider?: string | null; resolves?: string };
  }[];

  forms?: {
    provider?: string;
    integration?: string;
    field_count?: number;
    required_field_count?: number;
    cta_text?: string | null;
    location?: { above_fold?: boolean; visible?: boolean };
    fields?: { label?: string | null; purpose?: string; required?: boolean }[];
  }[];

  testimonials?: { text?: string; name?: string | null; role?: string | null; company?: string | null }[];

  social_proof?: {
    testimonial_count?: number;
    client_logos?: unknown[];
    ratings?: unknown[];
    numeric_claims?: { text?: string }[];
    media_mentions?: unknown[];
  };

  offer?: {
    product?: Determination<string>;
    audience?: Determination<string>;
    mechanism?: Determination<string>;
    benefits?: string[];
    deliverables?: string[];
    price_points?: string[];
    guarantee_present?: boolean;
    clarity?: Determination<{ clarity?: string; missing?: string[] }>;
    cta_relationship?: { primary_cta_text?: string | null; stated_outcome?: string | null };
  };

  pricing?: { detected?: boolean; items?: { text?: string }[] };
  guarantees?: { detected?: boolean; items?: { text?: string; kind?: string }[] };
  urgency?: {
    detected?: boolean;
    /** A crawler verdict. Deriving it again from the three lists below is what
     * keeps `urgencyQuality` alive once the API stops emitting this. */
    evidence_quality?: string;
    countdown_timers?: { text?: string; value?: string | null; selector?: string | null; visible?: boolean }[];
    deadlines?: { text?: string; date_text?: string | null }[];
    scarcity_claims?: { text?: string; kind?: string }[];
  };
  navigation?: { has_navigation?: boolean; nav_item_count?: number };
  links?: { broken?: { url?: string; status?: number | null }[]; social?: { platform?: string; url?: string }[] };

  tracking?: {
    detected?: { vendor?: string; category?: string }[];
    has_analytics?: boolean;
    has_advertising_pixel?: boolean;
    has_tag_manager?: boolean;
    statements?: string[];
  };

  seo?: {
    title?: { text?: string | null; present?: boolean };
    meta_description?: { present?: boolean };
    h1?: { visible_count?: number; visible_texts?: string[] };
    robots?: { indexable?: boolean | null };
  };

  technical?: {
    https?: boolean;
    console_errors?: { text?: string; party?: string }[];
    failed_requests?: { url?: string; party?: string }[];
    broken_images?: unknown[];
    mobile?: { tested?: boolean; horizontal_overflow?: boolean | null };
  };

  summary?: {
    ctas?: { total?: number; above_fold?: number; primary_text?: string | null };
    forms?: { total?: number; providers?: string[] };
    videos?: { dom_count?: number; visible_count?: number; above_fold_count?: number };
    proof?: { testimonials?: number; logos?: number; ratings?: number };
    issues?: { total?: number; by_severity?: Partial<Record<IssueSeverity, number>> };
  };

  observed_issues?: RawObservedIssue[];

  /**
   * The unjudged reading of the page: what was observed, before anything
   * decided what it meant. Optional because an API build that predates it must
   * still parse here.
   */
  raw_evidence?: RawEvidence;

  // Anything the API adds later lands here rather than breaking the parse.
  [key: string]: unknown;
}

export interface AuditSuccessEnvelope {
  status?: string;
  job_id?: string;
  url?: string;
  analysis?: RawAnalysis;
}

export interface AuditFailureEnvelope {
  status?: string;
  job_id?: string;
  url?: string;
  error?: { code?: string; message?: string };
}

/* ------------------------------ raw evidence ------------------------------
 *
 * A mirror of the API's `raw_evidence` section — the unjudged reading of the
 * page that every other section above is an interpretation OF.
 *
 * Everything here is optional, and `raw_evidence` itself is optional on
 * RawAnalysis, for one concrete reason: the two services deploy independently.
 * A dashboard that shipped an hour before the API build carrying this section
 * must still parse the old response, and an API that grows a field must not
 * break the parse either.
 */

/** Which collector profile the API was asked to run. */
export type CaptureProfile = "full" | "light";

/**
 * A collection that may have been cut short, shipped with the reason.
 *
 * The counts travel with the items so a reader cannot take the list without
 * also being handed the reason it might be short.
 */
export interface RawCapped<T> {
  items?: T[];
  total?: number;
  truncated?: boolean;
  cap?: number;
}

/**
 * One row of the completeness ledger.
 *
 * This is the mechanism that replaces a hand-tuned confidence number: an
 * "there is no X on this page" claim is only permitted over a field whose row
 * says `complete: true`. Some fields are never complete by construction —
 * inline script bodies, videos, window globals — and saying so is the point.
 */
export interface RawCompletenessEntry {
  field?: string;
  captured?: number;
  total?: number;
  complete?: boolean;
  cap?: number | null;
}

export type RawFoldPosition = "above_fold" | "below_fold" | "unknown";

export interface RawHtmlEvidence {
  captured?: boolean;
  sha256?: string | null;
  bytes?: number;
  truncated?: boolean;
  head?: string;
  body_skeleton?: string | null;
  note?: string | null;
}

export interface RawMetaEntry {
  name?: string | null;
  property?: string | null;
  http_equiv?: string | null;
  content?: string | null;
}

export interface RawLinkRelEntry {
  rel?: string | null;
  href?: string | null;
  type?: string | null;
}

export interface RawEvidenceHeading {
  level?: number;
  text?: string;
  visible?: boolean;
  position?: RawFoldPosition;
  y?: number;
}

export interface RawEvidenceText {
  text?: string;
  visible?: boolean;
  position?: RawFoldPosition;
  y?: number;
}

export interface RawEvidenceLink {
  text?: string;
  href?: string | null;
  /** The href's host as the browser resolved it. Never interpreted. */
  host?: string | null;
  visible?: boolean;
  position?: RawFoldPosition;
  in_nav?: boolean;
  in_footer?: boolean;
  x?: number | null;
  y?: number;
}

export interface RawEvidenceButton {
  text?: string;
  tag?: string;
  type?: string | null;
  href?: string | null;
  visible?: boolean;
  position?: RawFoldPosition;
  x?: number | null;
  y?: number;
  selector?: string | null;
}

export interface RawEvidenceImage {
  src?: string | null;
  alt?: string | null;
  title?: string | null;
  srcset?: string | null;
  sizes?: string | null;
  loading?: string | null;
  id?: string | null;
  class_name?: string | null;
  width?: number;
  height?: number;
  natural_width?: number | null;
  natural_height?: number | null;
  visible?: boolean;
  position?: RawFoldPosition;
  meets_size_threshold?: boolean;
}

export interface RawEvidenceScript {
  src?: string | null;
  host?: string | null;
  /** Capped by construction — its ledger row is never complete. */
  inline_snippet?: string | null;
}

export interface RawEvidenceEmbed {
  tag?: string;
  src?: string | null;
  host?: string | null;
  title?: string | null;
  name?: string | null;
  id?: string | null;
  class_name?: string | null;
  allow?: string | null;
  sandbox?: string | null;
  loading?: string | null;
  visible?: boolean;
  position?: RawFoldPosition;
  width?: number;
  height?: number;
  y?: number;
  inspectable?: boolean;
}

export interface RawEvidenceFormField {
  tag?: string;
  type?: string;
  name?: string | null;
  id?: string | null;
  placeholder?: string | null;
  label?: string | null;
  required?: boolean;
  autocomplete?: string | null;
  options?: string[];
  checked?: boolean | null;
  /** Whether the field arrived prefilled. The value itself is never read. */
  value_present?: boolean;
  selector?: string | null;
}

export interface RawEvidenceHiddenInput {
  name?: string | null;
  id?: string | null;
  value_present?: boolean;
}

export interface RawEvidenceDocumentHiddenInput extends RawEvidenceHiddenInput {
  form_selector?: string | null;
}

/** One form exactly as the page declared it — search boxes and logins included. */
export interface RawEvidenceForm {
  index?: number;
  selector?: string | null;
  name?: string | null;
  id?: string | null;
  action?: string | null;
  action_host?: string | null;
  method?: string;
  visible?: boolean;
  position?: RawFoldPosition;
  y?: number;
  in_modal?: boolean;
  heading_near?: string | null;
  submit_text?: string | null;
  field_count?: number;
  fields?: RawEvidenceFormField[];
  hidden_inputs?: RawEvidenceHiddenInput[];
  embedded_iframes?: { tag?: string; src?: string | null; host?: string | null; title?: string | null }[];
}

export interface RawEvidence {
  html?: RawHtmlEvidence;
  title?: string;
  url?: {
    requested?: string;
    final?: string;
    redirect_chain?: { url?: string; status?: number | null }[];
    http_status?: number | null;
    content_type?: string | null;
  };
  /** Every <meta> the page declared, not the whitelist the analysis reads. */
  meta?: RawCapped<RawMetaEntry>;
  charset?: string | null;
  links_rel?: RawCapped<RawLinkRelEntry>;
  visible_text?: { text?: string; characters?: number; truncated?: boolean };
  headings?: RawEvidenceHeading[];
  paragraphs?: RawCapped<RawEvidenceText>;
  links?: RawCapped<RawEvidenceLink>;
  buttons?: RawCapped<RawEvidenceButton>;
  images?: RawCapped<RawEvidenceImage>;
  hidden_inputs?: RawCapped<RawEvidenceDocumentHiddenInput>;
  scripts?: RawCapped<RawEvidenceScript>;
  iframes_embeds?: RawCapped<RawEvidenceEmbed>;
  /** Unfiltered, with fields, labels, options and hidden inputs attached. */
  forms?: RawEvidenceForm[];
  json_ld?: unknown[];
  /** Vendor names found on window. A name, never a conclusion, never complete. */
  window_globals_present?: string[];
  console_errors?: { text?: string; source?: string | null }[];
  page_errors?: string[];
  failed_requests?: { url?: string; status?: number | null; reason?: string; occurrences?: number }[];
  request_count?: number;
  viewport?: { width?: number; height?: number; scroll_width?: number; scroll_height?: number };
  body_overflow_x?: boolean;
  /**
   * What every collector kept against what the page held. A field marked
   * incomplete here cannot support an "there is no X on this page" claim.
   */
  completeness?: RawCompletenessEntry[];
}
