import "server-only";
import { config } from "../config";
import { AppError } from "../errors";
import { accessToken, resetToken } from "./google-auth";
import { SHEET_COLUMNS, type FunnelRecord, type SheetColumn } from "./types";
import type { SheetsService, UpsertOptions } from "./service";

/**
 * Google Sheets, driven by the header row rather than by column position.
 *
 * The spreadsheet belongs to a human who will reorder columns, insert one in
 * the middle, and rename the tab. So every write reads the header row first
 * and maps column NAME -> index. A column we do not recognise is left alone; a
 * column we hold but the sheet lacks is skipped rather than forced in. That
 * makes the sheet safe to edit by hand, which is the entire reason for using a
 * spreadsheet instead of a database.
 *
 * Writes are serialised. "Find the row, then write it" is two API calls, and
 * two overlapping upserts of the same URL would both find nothing and both
 * append — which is exactly how a single run ended up as two identical rows.
 * The queue is sequential, so a lock costs nothing and closes that window.
 */

const API = "https://sheets.googleapis.com/v4/spreadsheets";
const TIMEOUT_MS = 20_000;
/** funnel_url is the identity of a row; upsert matches on it. */
const KEY_COLUMN: SheetColumn = "funnel_url";

export class GoogleSheetsService implements SheetsService {
  readonly configured = true;
  private header: string[] | null = null;
  private sheetId: number | null = null;
  /** Serialises writes: each upsert waits for the previous one to finish. */
  private chain: Promise<unknown> = Promise.resolve();

  async upsert(record: FunnelRecord, options: UpsertOptions = {}): Promise<FunnelRecord> {
    return this.serialize(() => this.upsertNow(record, options));
  }

  private async upsertNow(record: FunnelRecord, options: UpsertOptions = {}): Promise<FunnelRecord> {
    const header = await this.ensureHeader();
    const keyIndex = header.indexOf(KEY_COLUMN);
    if (keyIndex === -1) {
      throw new AppError("sheets_failed", `the sheet has no "${KEY_COLUMN}" column`);
    }

    const rows = await this.findRows(record[KEY_COLUMN], keyIndex);
    const values = [header.map((column) => record[column as SheetColumn] ?? "")];

    if (rows.length === 0) {
      await this.call(
        `/values/${encodeURIComponent(this.range())}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        { method: "POST", body: { values } },
      );
      return record;
    }

    // MERGE rather than replace. Re-analysing a funnel writes a fresh audit
    // but knows nothing about the contact address the operator approved
    // earlier — a blind overwrite would silently erase that approval. A blank
    // incoming cell therefore keeps whatever the row already had.
    const existing = await this.readRow(rows[0]!);
    const overwrite = new Set(options.overwrite ?? []);
    const mergedValues = [
      header.map((column, index) => {
        const incoming = record[column as SheetColumn] ?? "";
        // A named column is written as-is, blank included — that is the only
        // way to actually clear a cell through a merging write.
        if (overwrite.has(column as SheetColumn)) return incoming;
        return incoming !== "" ? incoming : (existing[index] ?? "");
      }),
    ];

    await this.call(
      `/values/${encodeURIComponent(`${config.sheets.worksheet}!A${rows[0]}`)}?valueInputOption=RAW`,
      { method: "PUT", body: { values: mergedValues } },
    );

    if (rows.length > 1) await this.deleteRows(rows.slice(1));
    return record;
  }

  /**
   * Every new row in a single append.
   *
   * One read of the key column and one write, whatever the batch size — a
   * fifty-URL import has to be durable before the operator can navigate away,
   * and fifty round trips through upsert() would leave them watching a
   * spinner for a minute with a half-written queue if they did not.
   */
  async appendMany(records: FunnelRecord[]): Promise<number> {
    if (records.length === 0) return 0;

    return this.serialize(async () => {
      const header = await this.ensureHeader();
      const keyIndex = header.indexOf(KEY_COLUMN);
      if (keyIndex === -1) {
        throw new AppError("sheets_failed", `the sheet has no "${KEY_COLUMN}" column`);
      }

      const body = await this.call<{ values?: string[][] }>(
        `/values/${encodeURIComponent(this.columnRange(keyIndex))}`,
        { method: "GET" },
      );
      const existing = new Set((body.values ?? []).slice(1).map((row) => (row[0] ?? "").trim()));

      // Skipped, not updated. Re-queuing a funnel that already ran must leave
      // its audit, its contacts and its approved address exactly where they are.
      const fresh: FunnelRecord[] = [];
      for (const record of records) {
        const key = record[KEY_COLUMN];
        if (!key || existing.has(key)) continue;
        existing.add(key);
        fresh.push(record);
      }
      if (fresh.length === 0) return 0;

      await this.call(
        `/values/${encodeURIComponent(this.range())}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        {
          method: "POST",
          body: { values: fresh.map((record) => header.map((column) => record[column as SheetColumn] ?? "")) },
        },
      );
      return fresh.length;
    });
  }

  async list(): Promise<FunnelRecord[]> {
    const header = await this.ensureHeader();
    const body = await this.call<{ values?: string[][] }>(`/values/${encodeURIComponent(this.range())}`, {
      method: "GET",
    });

    const rows = body.values ?? [];
    return rows.slice(1).map((row) => {
      const record = {} as FunnelRecord;
      for (const column of SHEET_COLUMNS) {
        const index = header.indexOf(column);
        record[column] = index === -1 ? "" : (row[index] ?? "");
      }
      return record;
    });
  }

  /**
   * Deletes the row for one funnel, for real.
   *
   * The row is removed from the spreadsheet rather than blanked or flagged:
   * a "deleted" run that still occupies a row would come back on the next
   * read, which is exactly the complaint that prompted this.
   */
  async remove(url: string): Promise<boolean> {
    return this.serialize(async () => {
      const header = await this.ensureHeader();
      const keyIndex = header.indexOf(KEY_COLUMN);
      if (keyIndex === -1) return false;

      // Every matching row, so a URL duplicated before the lock existed does
      // not leave a survivor behind.
      const rows = await this.findRows(url, keyIndex);
      if (rows.length === 0) return false;

      await this.deleteRows(rows);
      return true;
    });
  }

  /** Collapses any pre-existing duplicate funnel_url rows. Returns how many went. */
  async dedupe(): Promise<number> {
    return this.serialize(async () => {
      const header = await this.ensureHeader();
      const keyIndex = header.indexOf(KEY_COLUMN);
      if (keyIndex === -1) return 0;

      const body = await this.call<{ values?: string[][] }>(
        `/values/${encodeURIComponent(this.columnRange(keyIndex))}`,
        { method: "GET" },
      );

      const values = body.values ?? [];

      // Keep the LAST occurrence of each URL: it carries the newest updated_at.
      const keep = new Map<string, number>();
      for (let index = 1; index < values.length; index += 1) {
        const key = (values[index]?.[0] ?? "").trim();
        if (key) keep.set(key, index + 1);
      }

      const remove: number[] = [];
      for (let index = 1; index < values.length; index += 1) {
        const key = (values[index]?.[0] ?? "").trim();
        if (key && keep.get(key) !== index + 1) remove.push(index + 1);
      }

      if (remove.length > 0) await this.deleteRows(remove);
      return remove.length;
    });
  }

  /* ------------------------------ internals ------------------------------ */

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    // Chain on the previous operation, but never let its failure cancel ours.
    const next = this.chain.catch(() => undefined).then(work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private range(): string {
    return `${config.sheets.worksheet}!A:ZZ`;
  }

  private columnRange(index: number): string {
    const letter = columnLetter(index);
    return `${config.sheets.worksheet}!${letter}:${letter}`;
  }

  /**
   * Reads the header row, writing the canonical one only into a sheet that is
   * completely empty. An existing header is never overwritten — someone's
   * column layout is not ours to rearrange.
   */
  private async ensureHeader(): Promise<string[]> {
    if (this.header) return this.header;

    const body = await this.call<{ values?: string[][] }>(
      `/values/${encodeURIComponent(`${config.sheets.worksheet}!1:1`)}`,
      { method: "GET" },
    );

    const existing = (body.values?.[0] ?? []).map((cell) => cell.trim()).filter(Boolean);
    if (existing.length > 0) {
      // A sheet written by an older version is missing columns added since.
      // Append them on the end — never reorder, never remove — so a column the
      // app now writes has somewhere to go instead of being silently dropped,
      // and anything the operator added by hand keeps its position.
      const missing = SHEET_COLUMNS.filter((column) => !existing.includes(column));
      const header = missing.length > 0 ? [...existing, ...missing] : existing;

      if (missing.length > 0) {
        await this.call(
          `/values/${encodeURIComponent(`${config.sheets.worksheet}!A1`)}?valueInputOption=RAW`,
          { method: "PUT", body: { values: [header] } },
        );
      }

      this.header = header;
      return header;
    }

    await this.call(
      `/values/${encodeURIComponent(`${config.sheets.worksheet}!A1`)}?valueInputOption=RAW`,
      { method: "PUT", body: { values: [[...SHEET_COLUMNS]] } },
    );
    this.header = [...SHEET_COLUMNS];
    return this.header;
  }

  /** One row's current cells, so a partial update does not blank the rest. */
  private async readRow(rowNumber: number): Promise<string[]> {
    const body = await this.call<{ values?: string[][] }>(
      `/values/${encodeURIComponent(`${config.sheets.worksheet}!A${rowNumber}:ZZ${rowNumber}`)}`,
      { method: "GET" },
    );
    return body.values?.[0] ?? [];
  }

  /** Every 1-based sheet row whose key column equals `url`. */
  private async findRows(url: string, keyIndex: number): Promise<number[]> {
    if (!url) return [];
    const body = await this.call<{ values?: string[][] }>(
      `/values/${encodeURIComponent(this.columnRange(keyIndex))}`,
      { method: "GET" },
    );

    const found: number[] = [];
    const values = body.values ?? [];
    for (let index = 1; index < values.length; index += 1) {
      if ((values[index]?.[0] ?? "").trim() === url) found.push(index + 1);
    }
    return found;
  }

  /** deleteDimension needs the tab's numeric id, not its name. */
  private async resolveSheetId(): Promise<number> {
    if (this.sheetId !== null) return this.sheetId;

    const body = await this.call<{
      sheets?: { properties?: { sheetId?: number; title?: string } }[];
    }>("?fields=sheets.properties.sheetId,sheets.properties.title", { method: "GET" });

    const match = body.sheets?.find((sheet) => sheet.properties?.title === config.sheets.worksheet);
    if (match?.properties?.sheetId === undefined) {
      throw new AppError("sheets_failed", `no worksheet named "${config.sheets.worksheet}"`);
    }
    this.sheetId = match.properties.sheetId;
    return this.sheetId;
  }

  private async deleteRows(rowNumbers: number[]): Promise<void> {
    if (rowNumbers.length === 0) return;
    const sheetId = await this.resolveSheetId();

    // Descending, so deleting one does not shift the index of the next.
    const requests = [...rowNumbers]
      .sort((left, right) => right - left)
      .map((row) => ({
        deleteDimension: {
          range: { sheetId, dimension: "ROWS", startIndex: row - 1, endIndex: row },
        },
      }));

    await this.call(":batchUpdate", { method: "POST", body: { requests } });
  }

  private async call<T = unknown>(
    path: string,
    options: { method: string; body?: unknown; retried?: boolean },
  ): Promise<T> {
    const token = await accessToken();
    let response: Response;

    try {
      response = await fetch(`${API}/${config.sheets.spreadsheetId}${path}`, {
        method: options.method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(options.body ? { "content-type": "application/json" } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "was unreachable";
      throw new AppError("sheets_failed", `Google Sheets ${reason}`);
    }

    if (response.status === 401 && !options.retried) {
      // A token can be invalidated before it expires. One clean retry.
      resetToken();
      return this.call<T>(path, { ...options, retried: true });
    }

    const body = (await response.json().catch(() => null)) as
      | (T & { error?: { message?: string; status?: string } })
      | null;

    if (!response.ok) {
      const message = body?.error?.message ?? `HTTP ${response.status}`;
      // 403 here almost always means one thing, and saying it saves an hour.
      const hint =
        response.status === 403
          ? " — share the spreadsheet with the service account's client_email as an Editor"
          : "";
      throw new AppError("sheets_failed", `${message}${hint}`);
    }

    return (body ?? ({} as T)) as T;
  }
}

/** 0-based index to an A1 column letter: 0 -> A, 25 -> Z, 26 -> AA. */
export function columnLetter(index: number): string {
  let value = index;
  let letters = "";
  do {
    letters = String.fromCharCode(65 + (value % 26)) + letters;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return letters;
}
