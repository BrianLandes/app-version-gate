// The poller's Android guards: Play is not touched at all while an upload may
// be in flight, and a build is promoted only on a successful probe, never on
// "in review", a refusal, an error, or a young build.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRun } from "../src/github.js";
import { MemoryLogger } from "../src/log.js";
import { PlayProbeError, PlayState } from "../src/play.js";
import { pollAndroid, type PromoteConfig, type PromoteDeps } from "../src/promote.js";

const NOW = new Date("2026-10-01T12:00:00Z");
const ROW = { platform: "android", pending_build: 309, latest_build: 306 };

function config(overrides: Partial<PromoteConfig["android"]> = {}, dryRun = false): PromoteConfig {
  return {
    table: "app_release_requirements",
    dryRun,
    android: {
      packageName: "com.example.app",
      serviceAccountJson: "{}",
      track: "production",
      uploadWorkflow: "build.yml",
      minAgeHours: 2,
      reviewProbe: true,
      ...overrides,
    },
    ios: { bundleId: "", keyId: "", issuerId: "", privateKey: "", testflightExternal: false },
  };
}

function buildRun(number: number, hoursAgo: number, status = "completed"): WorkflowRun {
  return {
    run_number: number,
    status,
    updated_at: new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString(),
  };
}

let log: MemoryLogger;
let deps: PromoteDeps & {
  promote: ReturnType<typeof vi.fn>;
  playAvailability: ReturnType<typeof vi.fn>;
  listUploadRuns: ReturnType<typeof vi.fn>;
  googleAccessToken: ReturnType<typeof vi.fn>;
};

function runs(...list: WorkflowRun[]) {
  deps.listUploadRuns.mockResolvedValue(list);
}

beforeEach(() => {
  log = new MemoryLogger();
  deps = {
    log,
    now: () => NOW,
    promote: vi.fn().mockResolvedValue(true),
    listUploadRuns: vi.fn().mockResolvedValue([]),
    googleAccessToken: vi.fn().mockResolvedValue("token"),
    playAvailability: vi.fn().mockResolvedValue(PlayState.LIVE),
    testflightBuildIsReady: vi.fn(),
  };
});

describe("pollAndroid", () => {
  it("promotes an aged build the probe says is live", async () => {
    runs(buildRun(309, 5));
    expect(await pollAndroid(ROW, config(), deps)).toBe(true);
    expect(deps.promote).toHaveBeenCalledOnce();
    expect(deps.promote).toHaveBeenCalledWith("android", 309, 306);
    expect(deps.playAvailability).toHaveBeenCalledWith("token", 309, true);
  });

  it("does not promote while in review", async () => {
    runs(buildRun(309, 5));
    deps.playAvailability.mockResolvedValue(PlayState.IN_REVIEW);
    expect(await pollAndroid(ROW, config(), deps)).toBe(false);
    expect(deps.promote).not.toHaveBeenCalled();
  });

  it("does not promote a build that is not on the track", async () => {
    runs(buildRun(309, 5));
    deps.playAvailability.mockResolvedValue(PlayState.NOT_ON_TRACK);
    await pollAndroid(ROW, config(), deps);
    expect(deps.promote).not.toHaveBeenCalled();
  });

  it("never touches Play while an upload may be running", async () => {
    for (const status of ["in_progress", "queued", "waiting", "requested", "pending"]) {
      runs(buildRun(310, 0.1, status), buildRun(309, 5));
      await pollAndroid(ROW, config(), deps);
    }
    expect(deps.googleAccessToken).not.toHaveBeenCalled();
    expect(deps.playAvailability).not.toHaveBeenCalled();
    expect(deps.promote).not.toHaveBeenCalled();
  });

  it("waits out the minimum age", async () => {
    runs(buildRun(309, 1));
    await pollAndroid(ROW, config(), deps);
    expect(deps.playAvailability).not.toHaveBeenCalled();
    expect(deps.promote).not.toHaveBeenCalled();
  });

  it("honours a custom minimum age", async () => {
    runs(buildRun(309, 5));
    await pollAndroid(ROW, config({ minAgeHours: 6 }), deps);
    expect(deps.playAvailability).not.toHaveBeenCalled();
  });

  it("refuses to probe on an unparseable minimum age", async () => {
    runs(buildRun(309, 5));
    await pollAndroid(ROW, config({ minAgeHours: Number.NaN }), deps);
    expect(deps.listUploadRuns).not.toHaveBeenCalled();
    expect(deps.playAvailability).not.toHaveBeenCalled();
    expect(log.errors).toHaveLength(1);
  });

  it("stops everything with the kill switch", async () => {
    runs(buildRun(309, 5));
    await pollAndroid(ROW, config({ reviewProbe: false }), deps);
    expect(deps.listUploadRuns).not.toHaveBeenCalled();
    expect(deps.playAvailability).not.toHaveBeenCalled();
    expect(deps.promote).not.toHaveBeenCalled();
    expect(log.errors).toHaveLength(1);
  });

  it("makes no Play call when GitHub fails", async () => {
    deps.listUploadRuns.mockRejectedValue(new Error("boom"));
    await pollAndroid(ROW, config(), deps);
    expect(deps.playAvailability).not.toHaveBeenCalled();
    expect(deps.promote).not.toHaveBeenCalled();
    expect(log.errors[0]).toContain("not touching Play");
  });

  it("makes no Play call when the staging run is not among recent runs", async () => {
    runs(buildRun(305, 50));
    await pollAndroid(ROW, config(), deps);
    expect(deps.playAvailability).not.toHaveBeenCalled();
    expect(log.errors[0]).toContain("cannot age build 309");
  });

  it("warns and does not promote on a probe refusal", async () => {
    runs(buildRun(309, 5));
    deps.playAvailability.mockRejectedValue(
      new PlayProbeError(400, "Changes cannot be sent for review automatically."),
    );
    await pollAndroid(ROW, config(), deps);
    expect(deps.promote).not.toHaveBeenCalled();
    expect(log.errors.at(-1)).toContain("Publishing overview");
  });

  it("warns and does not promote when the token exchange fails", async () => {
    runs(buildRun(309, 5));
    deps.googleAccessToken.mockRejectedValue(new Error("invalid_grant"));
    await pollAndroid(ROW, config(), deps);
    expect(deps.playAvailability).not.toHaveBeenCalled();
    expect(deps.promote).not.toHaveBeenCalled();
    expect(log.errors.at(-1)).toContain("invalid_grant");
  });

  it("raises an alarm for a stuck build", async () => {
    runs(buildRun(309, 24 * 4));
    deps.playAvailability.mockResolvedValue(PlayState.IN_REVIEW);
    await pollAndroid(ROW, config(), deps);
    expect(log.errors.at(-1)).toContain("still not promoted");
    expect(log.errors.at(-1)).toContain("4 days ago");
  });

  it("asks for no commit in a dry run", async () => {
    runs(buildRun(309, 5));
    deps.playAvailability.mockResolvedValue(PlayState.DRY_RUN_STOP);
    await pollAndroid(ROW, config({}, true), deps);
    expect(deps.playAvailability).toHaveBeenCalledWith("token", 309, false);
    expect(deps.promote).not.toHaveBeenCalled();
  });

  it("makes no calls when nothing is staged", async () => {
    for (const row of [{ ...ROW, pending_build: 306 }, { ...ROW, pending_build: 300 }, { platform: "android" }]) {
      await pollAndroid(row, config(), deps);
    }
    expect(deps.listUploadRuns).not.toHaveBeenCalled();
    expect(deps.playAvailability).not.toHaveBeenCalled();
    expect(log.errors).toEqual([]);
  });

  it("skips with an annotation when credentials are absent", async () => {
    runs(buildRun(309, 5));
    await pollAndroid(ROW, config({ serviceAccountJson: "" }), deps);
    await pollAndroid(ROW, config({ packageName: "" }), deps);
    expect(deps.listUploadRuns).not.toHaveBeenCalled();
    expect(log.errors).toHaveLength(2);
  });

  it("reports a failed promotion write without throwing", async () => {
    runs(buildRun(309, 5));
    deps.promote.mockRejectedValue(new Error("HTTP 500"));
    expect(await pollAndroid(ROW, config(), deps)).toBe(false);
    expect(log.errors.at(-1)).toContain("promotion failed");
  });
});
