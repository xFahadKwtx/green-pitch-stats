/**
 * Read-only Airtable access through the Lovable connector gateway.
 *
 * SAFETY: this module only ever issues GET requests. No helper here can create,
 * update or delete an Airtable record — do not add write helpers.
 */

const GATEWAY_URL = "https://connector-gateway.lovable.dev/airtable";

export const AIRTABLE_BASE_ID = "appd0pg0uKI1fSTOx";

export const AIRTABLE_TABLES = {
  playersDatabase: "tblXnvSOb53xfv3TK",
  statsJune: "tblbfKxLMLBaGFLEX",
  statsJuly: "tblH1InnirYscYCWH",
  statsAugust: "tbl78eFjDG3gqdPcX",
} as const;

export interface AirtableRecord {
  id: string;
  fields: Record<string, unknown>;
}

interface AirtableListResponse {
  records?: AirtableRecord[];
  offset?: string;
}

/** Fetch every record of a table (read-only, follows Airtable pagination). */
export async function listAirtableRecords(
  tableId: string,
  params: { fields?: string[]; filterByFormula?: string } = {},
): Promise<AirtableRecord[]> {
  const lovableApiKey = process.env["LOVABLE_API_KEY"];
  const airtableApiKey = process.env["AIRTABLE_API_KEY"];
  if (!lovableApiKey) throw new Error("LOVABLE_API_KEY is not configured");
  if (!airtableApiKey) throw new Error("AIRTABLE_API_KEY is not configured");

  const records: AirtableRecord[] = [];
  let offset: string | undefined;

  do {
    const url = new URL(`${GATEWAY_URL}/v0/${AIRTABLE_BASE_ID}/${tableId}`);
    url.searchParams.set("pageSize", "100");
    if (offset) url.searchParams.set("offset", offset);
    if (params.filterByFormula) {
      url.searchParams.set("filterByFormula", params.filterByFormula);
    }
    for (const field of params.fields ?? []) {
      url.searchParams.append("fields[]", field);
    }

    // GET only — this integration is strictly read-only.
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${lovableApiKey}`,
        "X-Connection-Api-Key": airtableApiKey,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`Airtable request failed [${response.status}]: ${body}`);
      throw new Error(`Airtable request failed [${response.status}]: ${body}`);
    }

    const payload = (await response.json()) as AirtableListResponse;
    records.push(...(payload.records ?? []));
    offset = payload.offset;
  } while (offset);

  return records;
}

export const str = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

export const numeric = (value: unknown): number => {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[^\d.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

/** Parses Airtable pair cells such as "91 - 76" into [91, 76]. */
export const pair = (value: unknown): [number, number] => {
  const text = str(value);
  if (!text) return [0, 0];
  const parts = text.split(/[-/]/).map((p) => Number(p.replace(/[^\d.]/g, "")));
  const first = Number.isFinite(parts[0]) ? (parts[0] as number) : 0;
  const second = Number.isFinite(parts[1] as number) ? (parts[1] as number) : 0;
  return [first, second];
};

export const selects = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
