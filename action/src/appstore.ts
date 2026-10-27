// App Store Connect / TestFlight: has a build finished processing (and, for
// external testers, passed Beta App Review)? Unlike Play, App Store Connect
// reports both directly, so no workaround is needed here.

import type { KeyObject } from "node:crypto";
import type { Http } from "./http.js";
import { buildJwt, es256Signer } from "./jwt.js";

export const ASC_API = "https://api.appstoreconnect.apple.com/v1";

/** Beta App Review states in which external testers cannot install yet. */
const BETA_REVIEW_BLOCKING = new Set(["WAITING_FOR_REVIEW", "IN_REVIEW", "REJECTED"]);

export function ascToken(keyId: string, issuerId: string, key: KeyObject, nowSeconds: number): string {
  return buildJwt(
    { alg: "ES256", kid: keyId, typ: "JWT" },
    { iss: issuerId, iat: nowSeconds, exp: nowSeconds + 600, aud: "appstoreconnect-v1" },
    es256Signer(key),
  );
}

interface JsonApiList {
  data?: { id: string; attributes?: Record<string, unknown> }[];
  included?: { type?: string; attributes?: Record<string, unknown> }[];
}

/** True when the build has finished processing (and passed Beta App Review
 * when it is being distributed to external testers). */
export async function testflightBuildIsReady(
  http: Http,
  token: string,
  bundleId: string,
  buildNumber: number,
  external: boolean,
): Promise<boolean> {
  const headers = { Authorization: `Bearer ${token}` };

  const apps = (await http({
    method: "GET",
    url: `${ASC_API}/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=1`,
    headers,
  })) as JsonApiList | null;
  const app = apps?.data?.[0];
  if (!app) return false;

  const query =
    `${ASC_API}/builds` +
    `?filter[app]=${encodeURIComponent(app.id)}` +
    `&filter[version]=${buildNumber}` +
    `&limit=1` +
    `&include=betaAppReviewSubmission` +
    `&fields[builds]=processingState,version` +
    `&fields[betaAppReviewSubmissions]=betaReviewState`;
  const builds = (await http({ method: "GET", url: query, headers })) as JsonApiList | null;
  const build = builds?.data?.[0];
  if (!build) return false;
  if (build.attributes?.["processingState"] !== "VALID") return false;
  if (!external) return true; // internal testers get it as soon as processing completes

  // External distribution: not ready while a Beta App Review submission is
  // still pending. A same-version rebuild skips review entirely (no
  // submission), in which case an absent/approved state is treated as ready.
  for (const included of builds?.included ?? []) {
    if (included.type !== "betaAppReviewSubmissions") continue;
    if (BETA_REVIEW_BLOCKING.has(String(included.attributes?.["betaReviewState"]))) return false;
  }
  return true;
}
