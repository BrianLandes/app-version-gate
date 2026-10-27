// PostgREST access to the release-requirements table, authenticated with a
// Supabase secret key (`sb_secret_…`) or a legacy service-role JWT. The table
// is not anon-writable, so both modes need elevated access.

import type { Http } from "./http.js";

export type Supabase = (method: "GET" | "PATCH", pathAndQuery: string, body?: Record<string, unknown>) => Promise<unknown>;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Table and column names are interpolated into PostgREST URLs, so only plain
 * SQL identifiers are accepted. */
export function assertIdentifier(kind: string, value: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new Error(`${kind} must be a plain identifier (letters, digits, underscore), got "${value}"`);
  }
  return value;
}

export function makeSupabase(http: Http, baseUrl: string, key: string): Supabase {
  const rest = `${baseUrl.replace(/\/+$/, "")}/rest/v1/`;
  return (method, pathAndQuery, body) =>
    http({
      method,
      url: rest + pathAndQuery,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        // Ask PostgREST to return the affected rows, so a PATCH that matched
        // nothing (no row, or already raised) is distinguishable from one that
        // wrote.
        Prefer: "return=representation",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

/** Rows come back as JSON numbers, or null/absent for an unset column. */
export function asBuild(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

export function isoNow(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}
