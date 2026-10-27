// mode: stage — record a just-uploaded build number in the release table.
//
// Which column depends on `column`:
//
// * `pending_build` (the default, and what an upload workflow should write)
//   stages the build. A scheduled `mode: promote` run later moves it into
//   `latest_build` once the store confirms the build is actually installable,
//   so users are not prompted to update to a build still in Play review or
//   TestFlight processing.
// * `latest_build` is the value clients prompt against. Writing it directly
//   skips the availability check; use it only for an emergency bump.
//
// `min_supported_build` (the force-update kill switch) is never touched. The
// value is only ever raised, never lowered, so a manual hotfix bump or an
// out-of-order run can't regress it. Any failure is an error annotation but not
// a failed step: a published build is never marked failed because this
// bookkeeping call didn't land.

import { describeError } from "./http.js";
import type { Logger } from "./log.js";
import { asBuild, isoNow, type Supabase } from "./supabase.js";

export const STAGE_COLUMNS = ["pending_build", "latest_build"] as const;
export type StageColumn = (typeof STAGE_COLUMNS)[number];

export interface StageConfig {
  table: string;
  platform: "android" | "ios";
  build: number;
  column: StageColumn;
}

/** Resolves true when the column was raised. */
export async function runStage(supabase: Supabase, config: StageConfig, log: Logger, now: Date): Promise<boolean> {
  const { table, platform, build, column } = config;
  const where = `${table}?platform=eq.${platform}`;
  try {
    const rows = await supabase("GET", `${where}&select=${column}`);
    const first = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
    if (!first) {
      log.error(`No ${table} row for platform '${platform}'; cannot set ${column}.`);
      return false;
    }
    const current = asBuild(first[column]);
    if (build <= current) {
      log.info(`${column} for ${platform} already ${current} >= ${build}; leaving it.`);
      return false;
    }

    // `<column>=lt.<build>` keeps the write raise-only even if another run
    // raised it between the read above and this write.
    const updated = await supabase("PATCH", `${where}&${column}=lt.${build}`, {
      [column]: build,
      updated_at: isoNow(now),
    });
    if (!Array.isArray(updated) || updated.length === 0) {
      log.info(`${column} for ${platform} was raised to >= ${build} concurrently; leaving it.`);
      return false;
    }
    log.info(`${column} for ${platform}: ${current} -> ${build}.`);
    return true;
  } catch (error) {
    log.error(`Could not set ${column} for ${platform}: ${describeError(error)}`);
    return false;
  }
}
