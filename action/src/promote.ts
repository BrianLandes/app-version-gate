// mode: promote — move a staged build into the live update gate once the store
// really serves it.
//
// The upload workflow stages each uploaded build number in `pending_build`
// (mode: stage). A build is not installable the instant CI uploads it, though:
// Google Play still reviews the release, and TestFlight has to process the
// build (and run Beta App Review before external distribution). Until then,
// advancing `latest_build` would prompt users to update to something they
// cannot fetch.
//
// For each platform with a staged build (`pending_build > latest_build`) this
// asks the store whether that exact build is live yet, and only then promotes
// `pending_build -> latest_build`. It is meant to run on a schedule.
//
// The failure mode is deliberately one-directional: on ANY uncertainty (an API
// error, missing credentials, a build still processing, a CI upload in flight)
// it declines to promote and leaves `latest_build` where it is. Over-promoting
// is the bug this exists to prevent; under-promoting just means the "update
// available" prompt waits for the next poll. Every decline is logged, and
// anything a human should look at (a store-check error, a build stuck for
// days) is an error annotation. The values are only ever raised.
//
// Android uses a workaround (the review probe) because the Play Developer API
// has no review status. Read the header of play.ts before changing it.

import type { KeyObject } from "node:crypto";
import { ascToken, testflightBuildIsReady } from "./appstore.js";
import { listWorkflowRuns, type GitHubContext, type WorkflowRun } from "./github.js";
import { describeError, type Http } from "./http.js";
import { loadP8 } from "./jwt.js";
import type { Logger } from "./log.js";
import { PlayProbeError, PlayState, googleAccessToken, parseServiceAccount, playAvailability } from "./play.js";
import { asBuild, isoNow, type Supabase } from "./supabase.js";

// Play review usually clears within a day. A build still unpromoted after this
// long most likely needs a human (a rejection, a Play Console prompt).
export const PLAY_STUCK_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;

export interface AndroidConfig {
  packageName: string;
  serviceAccountJson: string;
  /** The track the upload workflow releases to, and so the one users install
   * from. Must match the upload step's track. */
  track: string;
  /** Workflow FILE name that uploads to Play. Its run_number is the
   * versionCode, and while a run of it is active Play must not be touched. */
  uploadWorkflow: string;
  minAgeHours: number;
  /** false = never auto-promote Android (the kill switch). */
  reviewProbe: boolean;
}

export interface IosConfig {
  bundleId: string;
  keyId: string;
  issuerId: string;
  privateKey: string;
  /** Also wait for Beta App Review (external TestFlight testers). */
  testflightExternal: boolean;
}

export interface PromoteConfig {
  table: string;
  dryRun: boolean;
  android: AndroidConfig;
  ios: IosConfig;
}

export interface ReleaseRow {
  platform?: unknown;
  pending_build?: unknown;
  latest_build?: unknown;
}

/** Everything the poll functions do to the outside world. Tests replace it. */
export interface PromoteDeps {
  log: Logger;
  now: () => Date;
  /** Raise latest_build to `pending` (or log it, in a dry run). Resolves true
   * only when a row was actually raised. */
  promote(platform: string, pending: number, latest: number): Promise<boolean>;
  listUploadRuns(): Promise<WorkflowRun[]>;
  googleAccessToken(serviceAccountJson: string): Promise<string>;
  playAvailability(accessToken: string, versionCode: number, commitProbe: boolean): Promise<PlayState>;
  testflightBuildIsReady(build: number): Promise<boolean>;
}

// --------------------------------------------------------------------------- //
// Android
// --------------------------------------------------------------------------- //

export async function pollAndroid(row: ReleaseRow, config: PromoteConfig, deps: PromoteDeps): Promise<boolean> {
  const { log } = deps;
  const android = config.android;
  const pending = asBuild(row.pending_build);
  const latest = asBuild(row.latest_build);
  if (pending <= latest) {
    log.info(`android: nothing staged (pending ${pending} <= latest ${latest}).`);
    return false;
  }

  // Kill switch.
  if (!android.reviewProbe) {
    log.error(
      `android: build ${pending} staged, but play-review-probe is off, so it is never ` +
        "auto-promoted. Once Play shows it live, raise latest_build by hand (see the " +
        "manual-promotion runbook in the action's README).",
    );
    return false;
  }
  if (!android.serviceAccountJson || !android.packageName) {
    log.error(`android: build ${pending} staged but play-service-account-json / android-package unset.`);
    return false;
  }
  if (!(android.minAgeHours >= 0)) {
    log.error(`android: play-min-age-hours must be a non-negative number; not probing build ${pending}.`);
    return false;
  }

  // Guard: never open an edit while a Play upload may hold one open. Opening or
  // committing an edit invalidates every other open edit, which would fail the
  // upload.
  let runs: WorkflowRun[];
  try {
    runs = await deps.listUploadRuns();
  } catch (error) {
    log.error(`android: could not list ${android.uploadWorkflow} runs, so not touching Play: ${describeError(error)}`);
    return false;
  }
  const active = runs.filter((run) => run.status !== "completed");
  const firstActive = active[0];
  if (firstActive) {
    log.info(
      `android: ${android.uploadWorkflow} run #${firstActive.run_number} is ${firstActive.status}; ` +
        `not touching Play while an upload may be in flight. latest stays ${latest}.`,
    );
    return false;
  }

  // Guard: give Play time to register the review before probing. The staging
  // run's run_number IS the build number (versionCode = github.run_number).
  const stagingRun = runs.find((run) => Number(run.run_number) === pending);
  if (!stagingRun) {
    log.error(`android: no ${android.uploadWorkflow} run #${pending} among recent runs; cannot age build ${pending}.`);
    return false;
  }
  const stagedAt = Date.parse(stagingRun.updated_at);
  if (Number.isNaN(stagedAt)) {
    log.error(`android: ${android.uploadWorkflow} run #${pending} has an unreadable updated_at; cannot age build ${pending}.`);
    return false;
  }
  const ageMs = deps.now().getTime() - stagedAt;
  if (ageMs > PLAY_STUCK_AFTER_MS) {
    log.error(
      `android: build ${pending} was staged ${Math.floor(ageMs / (24 * HOUR_MS))} days ago and is still not ` +
        "promoted. Check Play Console > Publishing overview for a rejection or a change waiting on a human.",
    );
  }
  if (ageMs < android.minAgeHours * HOUR_MS) {
    log.info(
      `android: build ${pending} staged ${(ageMs / HOUR_MS).toFixed(1)}h ago ` +
        `(< ${android.minAgeHours}h); not probing yet. latest stays ${latest}.`,
    );
    return false;
  }

  let state: PlayState;
  try {
    const token = await deps.googleAccessToken(android.serviceAccountJson);
    state = await deps.playAvailability(token, pending, !config.dryRun);
  } catch (error) {
    if (error instanceof PlayProbeError) {
      const hint = error.needsHuman
        ? " Play is waiting on a human: open Play Console > Publishing overview (most often a rejected release)."
        : "";
      log.error(`android: review probe for build ${pending} refused: ${error.message}.${hint}`);
      return false;
    }
    // Never let a check crash the poll.
    log.error(`android: could not check Play availability for build ${pending}: ${describeError(error)}`);
    return false;
  }

  switch (state) {
    case PlayState.NOT_ON_TRACK:
      log.info(`android: build ${pending} is not in a completed ${android.track} release; latest stays ${latest}.`);
      return false;
    case PlayState.IN_REVIEW:
      log.info(`android: build ${pending} is still in Google review; latest stays ${latest}.`);
      return false;
    case PlayState.DRY_RUN_STOP:
      log.info(`android: DRY RUN — build ${pending} is on the ${android.track} track; the review probe would run next.`);
      return false;
    case PlayState.LIVE:
      break;
    default:
      log.error(`android: unexpected Play state ${String(state)} for build ${pending}; not promoting.`);
      return false;
  }
  try {
    return await deps.promote("android", pending, latest);
  } catch (error) {
    log.error(`android: promotion failed for build ${pending}: ${describeError(error)}`);
    return false;
  }
}

// --------------------------------------------------------------------------- //
// iOS
// --------------------------------------------------------------------------- //

export async function pollIos(row: ReleaseRow, config: PromoteConfig, deps: PromoteDeps): Promise<boolean> {
  const { log } = deps;
  const ios = config.ios;
  const pending = asBuild(row.pending_build);
  const latest = asBuild(row.latest_build);
  if (pending <= latest) {
    log.info(`ios: nothing staged (pending ${pending} <= latest ${latest}).`);
    return false;
  }
  if (!(ios.keyId && ios.issuerId && ios.privateKey && ios.bundleId)) {
    log.error(
      `ios: build ${pending} staged but App Store Connect credentials ` +
        "(appstore-key-id / appstore-issuer-id / appstore-private-key / ios-bundle-id) unset.",
    );
    return false;
  }
  let ready: boolean;
  try {
    ready = await deps.testflightBuildIsReady(pending);
  } catch (error) {
    log.error(`ios: could not check TestFlight availability for build ${pending}: ${describeError(error)}`);
    return false;
  }
  if (!ready) {
    log.info(
      `ios: build ${pending} not yet ready on TestFlight (external=${ios.testflightExternal}); latest stays ${latest}.`,
    );
    return false;
  }
  try {
    return await deps.promote("ios", pending, latest);
  } catch (error) {
    log.error(`ios: promotion failed for build ${pending}: ${describeError(error)}`);
    return false;
  }
}

// --------------------------------------------------------------------------- //
// Orchestration
// --------------------------------------------------------------------------- //

/** Raise latest_build, atomically and only upward. */
export async function promoteRow(
  supabase: Supabase,
  config: PromoteConfig,
  log: Logger,
  now: Date,
  platform: string,
  pending: number,
  latest: number,
): Promise<boolean> {
  if (config.dryRun) {
    log.info(`${platform}: DRY RUN — would promote latest_build ${latest} -> ${pending}.`);
    return false;
  }
  // `latest_build=lt.<pending>` makes the raise atomic: a concurrent bump
  // can't be clobbered downward.
  const rows = await supabase(
    "PATCH",
    `${config.table}?platform=eq.${encodeURIComponent(platform)}&latest_build=lt.${pending}`,
    { latest_build: pending, updated_at: isoNow(now) },
  );
  if (!Array.isArray(rows) || rows.length === 0) {
    log.info(`${platform}: build ${pending} is live, but latest_build is already >= ${pending}; nothing to raise.`);
    return false;
  }
  log.info(`${platform}: build ${pending} confirmed available — latest_build ${latest} -> ${pending}.`);
  return true;
}

/** The production wiring of PromoteDeps. */
export function makePromoteDeps(options: {
  http: Http;
  supabase: Supabase;
  config: PromoteConfig;
  github: GitHubContext;
  log: Logger;
  now?: () => Date;
  /** Called with every token minted, so the action can mask it in logs. */
  onSecret?: (value: string) => void;
}): PromoteDeps {
  const { http, supabase, config, github, log } = options;
  const now = options.now ?? (() => new Date());
  const onSecret = options.onSecret ?? (() => {});
  const seconds = () => Math.floor(now().getTime() / 1000);
  return {
    log,
    now,
    promote: (platform, pending, latest) => promoteRow(supabase, config, log, now(), platform, pending, latest),
    listUploadRuns: () => listWorkflowRuns(http, github, config.android.uploadWorkflow),
    googleAccessToken: async (raw) => {
      const token = await googleAccessToken(http, parseServiceAccount(raw), seconds());
      onSecret(token);
      return token;
    },
    playAvailability: (token, versionCode, commitProbe) =>
      playAvailability(http, token, config.android.packageName, config.android.track, versionCode, commitProbe),
    testflightBuildIsReady: async (build) => {
      const key: KeyObject = loadP8(config.ios.privateKey);
      const token = ascToken(config.ios.keyId, config.ios.issuerId, key, seconds());
      onSecret(token);
      return testflightBuildIsReady(http, token, config.ios.bundleId, build, config.ios.testflightExternal);
    },
  };
}

/** Poll every platform row. Resolves with the platforms actually promoted. */
export async function runPromote(supabase: Supabase, config: PromoteConfig, deps: PromoteDeps): Promise<string[]> {
  const { log } = deps;
  if (config.dryRun) log.info("DRY RUN: no review-probe commit, no latest_build writes.");

  let rows: unknown;
  try {
    rows = await supabase("GET", `${config.table}?select=platform,pending_build,latest_build`);
  } catch (error) {
    log.error(`Could not read ${config.table}: ${describeError(error)}`);
    return [];
  }
  const byPlatform = new Map<string, ReleaseRow>();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row && typeof row === "object" && typeof (row as ReleaseRow).platform === "string") {
      byPlatform.set((row as ReleaseRow).platform as string, row as ReleaseRow);
    }
  }
  if (byPlatform.size === 0) {
    log.notice(`${config.table} has no android or ios rows; nothing to promote.`);
  }

  const promoted: string[] = [];
  const android = byPlatform.get("android");
  if (android && (await pollAndroid(android, config, deps))) promoted.push("android");
  const ios = byPlatform.get("ios");
  if (ios && (await pollIos(ios, config, deps))) promoted.push("ios");
  return promoted;
}
