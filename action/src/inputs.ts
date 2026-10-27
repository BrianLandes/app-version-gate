// Turns the action's inputs into typed configuration. Takes a getter rather
// than calling @actions/core directly so it can be tested with a plain map.

import type { GitHubContext } from "./github.js";
import type { PromoteConfig } from "./promote.js";
import { STAGE_COLUMNS, type StageConfig, type StageColumn } from "./stage.js";
import { assertIdentifier } from "./supabase.js";

export type InputGetter = (name: string) => string;

/** A configuration mistake: the step fails, unlike operational errors. */
export class InputError extends Error {
  override name = "InputError";
}

export interface CommonConfig {
  supabaseUrl: string;
  supabaseKey: string;
  table: string;
}

export type ActionConfig =
  | { mode: "stage"; common: CommonConfig; stage: StageConfig }
  | { mode: "promote"; common: CommonConfig; promote: PromoteConfig; github: GitHubContext };

const TRUE = new Set(["1", "true", "yes", "on"]);
const OFF = new Set(["off", "false", "0", "no"]);

export function parseBool(value: string): boolean {
  return TRUE.has(value.trim().toLowerCase());
}

export function readConfig(get: InputGetter, env: NodeJS.ProcessEnv = process.env): ActionConfig {
  const input = (name: string, fallback = "") => get(name).trim() || fallback;

  const mode = input("mode").toLowerCase();
  if (mode !== "stage" && mode !== "promote") {
    throw new InputError(`mode must be "stage" or "promote", got "${mode}"`);
  }

  let table: string;
  try {
    table = assertIdentifier("table", input("table", "app_release_requirements"));
  } catch (error) {
    throw new InputError((error as Error).message);
  }
  const common: CommonConfig = {
    supabaseUrl: input("supabase-url"),
    supabaseKey: input("supabase-secret-key"),
    table,
  };

  if (mode === "stage") {
    const platform = input("platform").toLowerCase();
    if (platform !== "android" && platform !== "ios") {
      throw new InputError(`platform must be "android" or "ios", got "${platform}"`);
    }
    const rawBuild = input("build");
    const build = Number(rawBuild);
    if (!/^\d+$/.test(rawBuild) || !Number.isSafeInteger(build) || build <= 0) {
      throw new InputError(`build must be a positive integer, got "${rawBuild}"`);
    }
    const column = input("column", "pending_build");
    if (!(STAGE_COLUMNS as readonly string[]).includes(column)) {
      throw new InputError(`column must be one of ${STAGE_COLUMNS.join(", ")}, got "${column}"`);
    }
    return { mode, common, stage: { table, platform, build, column: column as StageColumn } };
  }

  const minAgeRaw = input("play-min-age-hours", "2");
  return {
    mode,
    common,
    github: {
      token: input("github-token"),
      repository: env["GITHUB_REPOSITORY"] ?? "",
      apiUrl: env["GITHUB_API_URL"] || "https://api.github.com",
    },
    promote: {
      table,
      dryRun: parseBool(get("dry-run")),
      android: {
        packageName: input("android-package"),
        serviceAccountJson: input("play-service-account-json"),
        track: input("play-track", "production"),
        uploadWorkflow: input("play-upload-workflow", "build.yml"),
        // NaN for garbage; pollAndroid refuses to probe on a non-number.
        minAgeHours: minAgeRaw === "" ? 2 : Number(minAgeRaw),
        // Only an explicit "off" (or false/0/no) disables it. Disabling is the
        // safe direction, so any of the usual spellings counts.
        reviewProbe: !OFF.has(input("play-review-probe", "on").toLowerCase()),
      },
      ios: {
        bundleId: input("ios-bundle-id"),
        keyId: input("appstore-key-id"),
        issuerId: input("appstore-issuer-id"),
        privateKey: input("appstore-private-key"),
        testflightExternal: parseBool(get("testflight-external")),
      },
    },
  };
}
