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
  urgency?: { detected?: boolean; evidence_quality?: string };
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
