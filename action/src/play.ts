// Google Play: where does a versionCode stand on the release track?
//
// THE REVIEW PROBE (read this before changing anything in this file)
// -----------------------------------------------------------------
// The Play Developer API cannot report review state. A release's `status` is
// only what the uploader *asked for*: an upload with `status: completed` reads
// `completed` the moment it commits, days before Google approves it. The first
// version of this check, in a production app, trusted that field and promoted
// a build on the first poll after upload, an hour and a half before Google had
// approved it. Users were prompted to update to a build Play would not serve.
//
// The only review signal Play exposes is a side effect of `edits.commit`:
// called with `changesInReviewBehavior=ERROR_IF_IN_REVIEW`, it fails with HTTP
// 400 "You already have changes in review" while anything is in review. So the
// check opens an edit, changes nothing, and commits it with that flag:
//
//   400 "already have changes in review"          -> still in review; wait.
//   400 "cannot be sent for review automatically" -> Play needs a human
//                                                    (usually a rejection);
//                                                    alert, wait.
//   200                                           -> nothing in review, so the
//                                                    `completed` release is live.
//
// This is a workaround, and it has three sharp edges, each guarded:
//
// 1. Without the flag, the commit defaults to CANCEL_IN_REVIEW_AND_SUBMIT,
//    which would cancel the review we are waiting on and restart it. The flag
//    lives in one constant (PROBE_COMMIT_QUERY) used by the one commit call in
//    this codebase, and the tests fail if any commit URL lacks it or a second
//    commit call appears.
// 2. Committing, or even opening, an edit invalidates every other open edit on
//    the app, including a CI upload that is still running, which would fail
//    that build. So the poller touches Play only when no run of the upload
//    workflow is queued, waiting or in progress (see promote.ts).
// 3. A probe could pass in a gap right after upload, before Play has
//    registered the review. So it probes only once the staging run is
//    `play-min-age-hours` old (see promote.ts).

import { HttpError, extractMessage, type Http } from "./http.js";
import { buildJwt, rs256Signer } from "./jwt.js";
import { createPrivateKey } from "node:crypto";

export const ANDROID_SCOPE = "https://www.googleapis.com/auth/androidpublisher";
export const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
export const PLAY_API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";

// The ONLY query string the review probe may commit with. Play's default is
// CANCEL_IN_REVIEW_AND_SUBMIT, which would cancel the review we are waiting on.
// Never build a commit URL anywhere else; the tests enforce both.
export const PROBE_COMMIT_QUERY = "changesInReviewBehavior=ERROR_IF_IN_REVIEW";

// Substrings of Play's 400 error messages for the two expected refusals, e.g.
// "You already have changes in review. Cancel this review or wait for it to
// complete before you try again." and "Changes cannot be sent for review
// automatically. Please set the query parameter changesNotSentForReview to
// true." If Google rewords them, the probe is refused with an unrecognised
// error, which fails safe (no promotion) and annotates.
export const PLAY_IN_REVIEW_MARKER = "already have changes in review";
export const PLAY_NEEDS_HUMAN_MARKER = "cannot be sent for review automatically";

/** Outcomes of the Android store check. */
export const PlayState = {
  /** No completed release on the track carries the build yet. */
  NOT_ON_TRACK: "not_on_track",
  /** Completed, but Google is still reviewing it. */
  IN_REVIEW: "in_review",
  /** Completed and nothing in review: installable. */
  LIVE: "live",
  /** On the track; the dry run stopped before the probe. */
  DRY_RUN_STOP: "dry_run_stop",
} as const;
export type PlayState = (typeof PlayState)[keyof typeof PlayState];

/**
 * The probe commit failed in a way that is not a plain "still in review".
 *
 * `needsHuman` is true for Play's "cannot be sent for review automatically",
 * which means the app has changes Play will not auto-submit: most often a
 * rejected release, sometimes unsent Play Console changes.
 */
export class PlayProbeError extends Error {
  readonly needsHuman: boolean;
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`HTTP ${status}: ${message}`);
    this.name = "PlayProbeError";
    this.needsHuman = message.includes(PLAY_NEEDS_HUMAN_MARKER);
  }
}

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export function parseServiceAccount(raw: string): ServiceAccount {
  const parsed = JSON.parse(raw) as Partial<ServiceAccount>;
  if (typeof parsed.client_email !== "string" || typeof parsed.private_key !== "string") {
    throw new Error("service account JSON lacks client_email / private_key");
  }
  return parsed as ServiceAccount;
}

/** Exchange a service-account JWT assertion for an OAuth access token. */
export async function googleAccessToken(http: Http, account: ServiceAccount, nowSeconds: number): Promise<string> {
  const tokenUri = account.token_uri || DEFAULT_TOKEN_URI;
  const assertion = buildJwt(
    { alg: "RS256", typ: "JWT" },
    {
      iss: account.client_email,
      scope: ANDROID_SCOPE,
      aud: tokenUri,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    },
    rs256Signer(createPrivateKey(account.private_key)),
  );
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  }).toString();
  const response = (await http({
    method: "POST",
    url: tokenUri,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  })) as { access_token?: unknown } | null;
  if (typeof response?.access_token !== "string") {
    throw new Error("Google token endpoint returned no access_token");
  }
  return response.access_token;
}

interface Track {
  releases?: { status?: string; versionCodes?: (string | number)[] }[];
}

/**
 * True when `versionCode` is in a `completed` release on the track.
 *
 * Necessary but NOT sufficient for "live": `completed` is set at upload,
 * before review. The probe in playAvailability supplies the rest.
 */
export function releaseCompleted(track: Track | null, versionCode: number): boolean {
  const wanted = String(versionCode);
  for (const release of track?.releases ?? []) {
    if (release.status !== "completed") continue;
    if ((release.versionCodes ?? []).map(String).includes(wanted)) return true;
  }
  return false;
}

export function editsUrl(packageName: string): string {
  return `${PLAY_API}/${encodeURIComponent(packageName)}/edits`;
}

/**
 * Where `versionCode` stands on `track`: one of the PlayState outcomes.
 *
 * Opens one edit, reads the track, and then either commits that same,
 * unchanged edit as the review probe or abandons it. Nothing in the edit is
 * ever modified, so a successful commit publishes nothing. Throws
 * PlayProbeError for a refusal other than "in review", and lets any other
 * error propagate; the caller declines to promote on both.
 */
export async function playAvailability(
  http: Http,
  accessToken: string,
  packageName: string,
  track: string,
  versionCode: number,
  commitProbe: boolean,
): Promise<PlayState> {
  const auth = { Authorization: `Bearer ${accessToken}` };
  const base = editsUrl(packageName);
  const edit = (await http({
    method: "POST",
    url: base,
    headers: { ...auth, "Content-Type": "application/json" },
    body: "{}",
  })) as { id?: unknown } | null;
  if (typeof edit?.id !== "string" || !edit.id) {
    throw new Error("Play returned an edit without an id");
  }
  const editId = edit.id;
  let committed = false;
  try {
    let current: Track | null;
    try {
      current = (await http({
        method: "GET",
        url: `${base}/${editId}/tracks/${encodeURIComponent(track)}`,
        headers: auth,
      })) as Track | null;
    } catch (error) {
      // 404 = no release on the track yet.
      if (!(error instanceof HttpError && error.status === 404)) throw error;
      current = null;
    }
    if (!releaseCompleted(current, versionCode)) return PlayState.NOT_ON_TRACK;
    if (!commitProbe) return PlayState.DRY_RUN_STOP;

    // The review probe. Read the header of this file before touching this call.
    try {
      await http({ method: "POST", url: `${base}/${editId}:commit?${PROBE_COMMIT_QUERY}`, headers: auth });
    } catch (error) {
      if (error instanceof HttpError) {
        const message = extractMessage(error.body);
        if (error.status === 400 && message.includes(PLAY_IN_REVIEW_MARKER)) return PlayState.IN_REVIEW;
        throw new PlayProbeError(error.status, message);
      }
      throw error;
    }
    committed = true;
    return PlayState.LIVE;
  } finally {
    if (!committed) {
      try {
        await http({ method: "DELETE", url: `${base}/${editId}`, headers: auth });
      } catch {
        // Abandoning an unchanged edit is best-effort.
      }
    }
  }
}
