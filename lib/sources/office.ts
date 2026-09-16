import JSZip from "jszip";

// PowerPoint and Excel files are zip archives of XML. The parts read here (slide text, cell values,
// shared strings, number formats) have a simple, stable structure, so plain pattern matching is enough.

export interface SheetTable {
  name: string;
  rows: string[][];
}

/** Text of each slide in a .pptx, in presentation order. Hidden slides are marked. */
export async function pptxSlides(bytes: Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes);
  const read = async (path: string) => (await zip.file(path)?.async("string")) ?? "";
  const [presentation, rels] = await Promise.all([read("ppt/presentation.xml"), read("ppt/_rels/presentation.xml.rels")]);
  const targets = relationshipTargets(rels);

  const order = [...presentation.matchAll(/<p:sldId\b[^>]*>/g)]
    .map((m) => targets.get(attr(m[0], "r:id")))
    .filter((target): target is string => Boolean(target))
    .map((target) => `ppt/${target.replace(/^\/?ppt\//, "")}`);

  return Promise.all(
    order.map(async (path) => {
      const xml = await read(path);
      const text = xml
        .split(/<\/a:p>/)
        .map((paragraph) => [...paragraph.matchAll(/<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g)].map((m) => decodeXml(m[1])).join(""))
        .map((line) => line.trim())
        .filter(Boolean)
        .join("\n");
      return /<p:sld\b[^>]*\bshow="0"/.test(xml) ? `(hidden slide)\n${text}` : text;
    }),
  );
}

/** Every sheet of an .xlsx as rows of display values. Dates come out as dates, not serial numbers. */
export async function xlsxSheets(bytes: Uint8Array): Promise<SheetTable[]> {
  const zip = await JSZip.loadAsync(bytes);
  const read = async (path: string) => (await zip.file(path)?.async("string")) ?? "";
  const [workbook, rels, shared, styles] = await Promise.all([
    read("xl/workbook.xml"),
    read("xl/_rels/workbook.xml.rels"),
    read("xl/sharedStrings.xml"),
    read("xl/styles.xml"),
  ]);

  const strings = [...shared.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textRuns(m[1]));
  const dateStyles = dateStyleIndexes(styles);
  const targets = relationshipTargets(rels);

  const sheets = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({
    name: decodeXml(attr(m[0], "name")),
    path: `xl/${(targets.get(attr(m[0], "r:id")) ?? "").replace(/^\/?xl\//, "")}`,
  }));

  return Promise.all(
    sheets.map(async ({ name, path }) => {
      const xml = await read(path);
      const rows: string[][] = [];
      for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
        const cells: string[] = [];
        for (const cell of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const attrs = cell[1];
          const body = cell[2] ?? "";
          const type = attr(attrs, "t");
          const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
          let value = "";
          if (type === "s") value = strings[Number(raw)] ?? "";
          else if (type === "inlineStr") value = textRuns(body);
          else if (type === "b") value = raw === "1" ? "TRUE" : "FALSE";
          else if (raw !== undefined) {
            value = type === "str" || type === "e" ? decodeXml(raw) : dateStyles.has(Number(attr(attrs, "s") || 0)) ? excelDate(Number(raw)) : raw;
          }
          cells[columnIndex(attr(attrs, "r"), cells.length)] = value.trim();
        }
        rows.push(Array.from(cells, (value) => value ?? ""));
      }
      return { name, rows };
    }),
  );
}

/**
 * Rows as self-describing records ("Row 5: Status: Done | Owner: Jane"), using the first row with at
 * least two filled cells as the header. Empty rows are dropped.
 */
export function sheetRecords(table: SheetTable): string[] {
  return sheetRows(table).map((row) => row.text);
}

export interface SheetRow {
  sheet: string;
  row: number;
  /** Column header → display value; empty cells are left out. */
  fields: Record<string, string>;
  text: string;
}

/** The rows of a sheet with their values keyed by column header, and the same record as text. */
export function sheetRows(table: SheetTable): SheetRow[] {
  const headerAt = table.rows.findIndex((row) => row.filter(Boolean).length >= 2);
  if (headerAt < 0) return [];
  const header = table.rows[headerAt];
  const rows: SheetRow[] = [];
  table.rows.slice(headerAt + 1).forEach((row, i) => {
    const fields: Record<string, string> = {};
    row.forEach((value, col) => {
      if (!value) return;
      const name = header[col] || columnName(col);
      // Percent columns hold fractions ("0.9"); show them the way the sheet does ("90%").
      fields[name] = name.includes("%") && /^(0(\.\d+)?|1(\.0+)?)$/.test(value) ? `${Math.round(Number(value) * 100)}%` : value;
    });
    const entries = Object.entries(fields);
    if (!entries.length) return;
    const number = headerAt + i + 2;
    rows.push({ sheet: table.name, row: number, fields, text: `Sheet "${table.name}" · Row ${number}: ${entries.map(([k, v]) => `${k}: ${v}`).join(" | ")}` });
  });
  return rows;
}

export function spreadsheetText(tables: SheetTable[]): string {
  return tables.map((table) => sheetRecords(table).join("\n")).filter(Boolean).join("\n\n");
}

function relationshipTargets(rels: string): Map<string, string> {
  return new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], "Id"), attr(m[0], "Target")]));
}

function attr(tag: string, name: string): string {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? "";
}

function textRuns(xml: string): string {
  return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join("");
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, "&");
}

/** "C12" → 2. Cells without a reference follow the previous one. */
function columnIndex(ref: string, fallback: number): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0];
  if (!letters) return fallback;
  return [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
}

function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return `Column ${name}`;
}

/** Positions in styles.xml's cellXfs whose number format shows a date. */
function dateStyleIndexes(styles: string): Set<number> {
  const custom = new Map(
    [...styles.matchAll(/<numFmt\b[^>]*>/g)].map((m) => [Number(attr(m[0], "numFmtId")), decodeXml(attr(m[0], "formatCode"))]),
  );
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? "";
  const dates = new Set<number>();
  [...cellXfs.matchAll(/<xf\b[^>]*>/g)].forEach((m, index) => {
    const id = Number(attr(m[0], "numFmtId"));
    const builtInDate = (id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58);
    const code = (custom.get(id) ?? "").replace(/"[^"]*"|\[[^\]]*\]/g, "");
    if (builtInDate || /[dy]/i.test(code)) dates.add(index);
  });
  return dates;
}

/** Excel serial date → "2026-09-15" (or "2026-09-15 14:30" when it has a time). */
function excelDate(serial: number): string {
  if (!Number.isFinite(serial)) return String(serial);
  const iso = new Date(Math.round((serial - 25569) * 86_400_000)).toISOString();
  return serial % 1 ? iso.slice(0, 16).replace("T", " ") : iso.slice(0, 10);
}
