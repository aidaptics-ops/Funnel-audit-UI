import { randomUUID } from "node:crypto";
import type { ClientEmail } from "./types";

/**
 * Turns pasted text, a .txt file or a .csv into individual email samples.
 *
 * The goal is to be forgiving: an operator pasting a dozen emails should not
 * have to think about format. Anything that looks like a separate message
 * becomes a separate sample; anything ambiguous stays as one sample rather
 * than being chopped into fragments.
 */

/** Lines people actually use to separate pasted emails. */
const SEPARATOR = /^\s*(?:-{3,}|={3,}|\*{3,}|#{3,}|_{3,})\s*$/m;

/** A "Subject:" line at the top of a sample. */
const SUBJECT_LINE = /^\s*subject\s*:\s*(.+)$/im;

export interface IngestOptions {
  source: string;
  tag?: string | null;
}

export function parsePastedEmails(text: string, options: IngestOptions): ClientEmail[] {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return [];

  const chunks = SEPARATOR.test(trimmed)
    ? trimmed.split(SEPARATOR)
    : splitOnBlankRuns(trimmed);

  return chunks.map((chunk) => toEmail(chunk, options)).filter((email): email is ClientEmail => email !== null);
}

/**
 * CSV with a header. Picks the most email-looking column rather than assuming
 * a position, so column order can change without breaking the import.
 */
export function parseCsvEmails(text: string, options: IngestOptions): ClientEmail[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];

  const header = rows[0]!.map((cell) => cell.trim().toLowerCase());
  const bodyIndex = pickColumn(header, ["body", "email", "email_body", "message", "content", "text"]);
  const subjectIndex = pickColumn(header, ["subject", "subject_line", "title"]);

  // No recognisable header: treat every cell of every row as a sample.
  if (bodyIndex === -1) {
    return rows
      .flat()
      .map((cell) => toEmail(cell, options))
      .filter((email): email is ClientEmail => email !== null);
  }

  return rows
    .slice(1)
    .map((row) => {
      const email = toEmail(row[bodyIndex] ?? "", options);
      if (!email) return null;
      const subject = subjectIndex >= 0 ? (row[subjectIndex] ?? "").trim() : "";
      return subject ? { ...email, subject } : email;
    })
    .filter((email): email is ClientEmail => email !== null);
}

export function parseUpload(filename: string, text: string, tag?: string | null): ClientEmail[] {
  const isCsv = /\.csv$/i.test(filename) || looksLikeCsv(text);
  return isCsv
    ? parseCsvEmails(text, { source: "csv", tag })
    : parsePastedEmails(text, { source: "txt", tag });
}

/* -------------------------------- internals ------------------------------ */

function toEmail(chunk: string, options: IngestOptions): ClientEmail | null {
  const body = (chunk ?? "").trim();
  // Anything shorter than this is a fragment, not a writing sample.
  if (body.length < 40) return null;

  const subjectMatch = body.match(SUBJECT_LINE);
  const subject = subjectMatch?.[1]?.trim() ?? null;
  const withoutSubject = subjectMatch ? body.replace(SUBJECT_LINE, "").trim() : body;

  return {
    id: randomUUID(),
    subject,
    body: withoutSubject,
    source: options.source,
    addedAt: new Date().toISOString(),
    tag: options.tag ?? null,
  };
}

/**
 * Two or more blank lines usually separate pasted emails; a single blank line
 * is just a paragraph break inside one.
 */
function splitOnBlankRuns(text: string): string[] {
  const parts = text.split(/\n\s*\n\s*\n+/);
  return parts.length > 1 ? parts : [text];
}

function pickColumn(header: string[], candidates: string[]): number {
  for (const candidate of candidates) {
    const index = header.indexOf(candidate);
    if (index !== -1) return index;
  }
  return -1;
}

function looksLikeCsv(text: string): boolean {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  return firstLine.includes(",") && firstLine.split(",").length >= 2 && firstLine.length < 300;
}

/** Minimal RFC-4180 reader: quoted fields, escaped quotes, embedded newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((entry) => entry.some((cell) => cell.trim() !== ""));
}
