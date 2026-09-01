import { evidenceText, type NormalizedAudit, type NormalizedIssue } from "../audit/normalize";

/**
 * A cell-sized copy of the audit.
 *
 * Sheets caps a cell at 50,000 characters and a full audit can exceed that, so
 * this keeps what the history view actually renders — the page's own words,
 * the findings, and what became of the funnel's next step — and drops the raw
 * capture, which nothing reads back.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE: whatever comes out of here must
 * parse. The previous version ended with `json.slice(0, CELL_LIMIT)`, which
 * cuts the document mid-string; parseAudit then threw, returned null, and the
 * row silently lost its entire stored audit — the one case where the size
 * guard fires is the one case where all the data disappears. Truncating a JSON
 * document is never a size strategy. Dropping whole elements from it is.
 *
 * Lives outside service.ts, which is `server-only`, so the shedding ladder can
 * be tested directly rather than reasoned about.
 */
export const CELL_LIMIT = 45_000;

/** One finding, as the sheet stores it. */
interface CompactFinding {
  id: string;
  stage: string;
  claimType: string;
  title: string;
  severity: string;
  category: string;
  description: string;
  recommendation: string;
  impact: string | null;
  /** How worth raising this is in a first cold email, 0-100. */
  commercialWeight: number;
  /**
   * The first citation only.
   *
   * The full citation list belongs to verification, which has already run by
   * the time anything reaches this file. What survives into history is the one
   * pointer a human needs to see why the finding was made — capped, because a
   * single quote must not be able to consume the whole cell.
   */
  citation: string | null;
  evidence: string[];
}

const QUOTE_LIMIT = 160;

function compactFinding(issue: NormalizedIssue, withEvidence: boolean): CompactFinding {
  return {
    id: issue.id,
    stage: issue.stage,
    claimType: issue.claimType,
    title: issue.title,
    severity: issue.severity,
    category: issue.category,
    description: issue.description,
    recommendation: issue.recommendation,
    impact: issue.impact,
    commercialWeight: issue.commercialWeight,
    citation: (issue.citations ?? [])[0]?.slice(0, QUOTE_LIMIT) ?? null,
    evidence: withEvidence ? (issue.evidence ?? []).slice(0, 4).map(evidenceText) : [],
  };
}

export function compactAudit(audit: NormalizedAudit): string {
  const header = {
    finalUrl: audit.finalUrl,
    domain: audit.domain,
    brand: audit.brand,
    pageTitle: audit.pageTitle,
    funnelType: audit.funnelType,
    pageType: audit.pageType,
    conversionGoal: audit.conversionGoal,
    headline: audit.headline,
    subheadline: audit.subheadline,
    primaryCta: audit.primaryCta,
    analyzedAt: audit.analyzedAt,
    jobId: audit.jobId,
    observability: audit.observability,
  };

  const issues = audit.issues ?? [];

  // The ladder, cheapest loss first. Each rung is a COMPLETE document.
  const full = { ...header, issues: issues.map((issue) => compactFinding(issue, true)) };
  const fullJson = JSON.stringify(full);
  if (fullJson.length <= CELL_LIMIT) return fullJson;

  // 1. Shed the quoted evidence. Titles, severities and the citation pointer
  //    are what the list view needs, and they are the last thing to go.
  const lean = issues.map((issue) => compactFinding(issue, false));
  const leanJson = JSON.stringify({ ...header, issues: lean });
  if (leanJson.length <= CELL_LIMIT) return leanJson;

  // 2. Drop WHOLE findings from the tail — they are ordered by severity, so
  //    the ones that go are the ones that mattered least. Never a substring:
  //    the cell has to parse, and half a finding is not a finding.
  for (let kept = lean.length - 1; kept > 0; kept -= 1) {
    const json = JSON.stringify({
      ...header,
      issues: lean.slice(0, kept),
      findings_omitted: lean.length - kept,
    });
    if (json.length <= CELL_LIMIT) return json;
  }

  // 3. The header alone, with an honest count of what did not fit.
  const bare = JSON.stringify({ ...header, issues: [], findings_omitted: lean.length });
  if (bare.length <= CELL_LIMIT) return bare;

  // 4. A header so large it does not fit by itself. Vanishingly unlikely, but
  //    "always valid JSON" is only a guarantee if it holds here too.
  const minimal = JSON.stringify({
    finalUrl: header.finalUrl,
    domain: header.domain,
    jobId: header.jobId,
    analyzedAt: header.analyzedAt,
    issues: [],
    findings_omitted: lean.length,
  });
  return minimal.length <= CELL_LIMIT ? minimal : JSON.stringify({ issues: [], findings_omitted: lean.length });
}
