// iOS polling, the promotion write, and the end-to-end promote run against a
// fake HTTP layer.

import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ASC_API, testflightBuildIsReady } from "../src/appstore.js";
import { HttpError, type Http, type HttpRequest } from "../src/http.js";
import { MemoryLogger } from "../src/log.js";
import { PLAY_API } from "../src/play.js";
import { makePromoteDeps, pollIos, promoteRow, runPromote, type PromoteConfig, type PromoteDeps } from "../src/promote.js";
import { makeSupabase } from "../src/supabase.js";

const NOW = new Date("2026-10-01T12:00:00Z");

function config(overrides: Partial<PromoteConfig> = {}): PromoteConfig {
  return {
    table: "app_release_requirements",
    dryRun: false,
    android: {
      packageName: "com.example.app",
      serviceAccountJson: "",
      track: "production",
      uploadWorkflow: "build.yml",
      minAgeHours: 2,
      reviewProbe: true,
    },
    ios: { bundleId: "com.example.app", keyId: "KEY", issuerId: "ISSUER", privateKey: "pem", testflightExternal: false },
    ...overrides,
  };
}

describe("pollIos", () => {
  let log: MemoryLogger;
  let deps: PromoteDeps;
  beforeEach(() => {
    log = new MemoryLogger();
    deps = {
      log,
      now: () => NOW,
      promote: vi.fn().mockResolvedValue(true),
      listUploadRuns: vi.fn(),
      googleAccessToken: vi.fn(),
      playAvailability: vi.fn(),
      testflightBuildIsReady: vi.fn().mockResolvedValue(true),
    };
  });
  const row = { platform: "ios", pending_build: 95, latest_build: 92 };

  it("promotes a ready build", async () => {
    expect(await pollIos(row, config(), deps)).toBe(true);
    expect(deps.promote).toHaveBeenCalledWith("ios", 95, 92);
  });

  it("waits for a build that is not ready", async () => {
    vi.mocked(deps.testflightBuildIsReady).mockResolvedValue(false);
    expect(await pollIos(row, config(), deps)).toBe(false);
    expect(deps.promote).not.toHaveBeenCalled();
    expect(log.errors).toEqual([]);
  });

  it("annotates and does not promote on a check error", async () => {
    vi.mocked(deps.testflightBuildIsReady).mockRejectedValue(new Error("401"));
    expect(await pollIos(row, config(), deps)).toBe(false);
    expect(deps.promote).not.toHaveBeenCalled();
    expect(log.errors[0]).toContain("could not check TestFlight");
  });

  it("skips with an annotation when credentials are absent, but only when something is staged", async () => {
    const noCreds = config({ ios: { ...config().ios, privateKey: "" } });
    await pollIos(row, noCreds, deps);
    expect(deps.testflightBuildIsReady).not.toHaveBeenCalled();
    expect(log.errors).toHaveLength(1);
    await pollIos({ ...row, pending_build: 92 }, noCreds, deps);
    expect(log.errors).toHaveLength(1);
  });
});

describe("testflightBuildIsReady", () => {
  function asc(build: Record<string, unknown> | null, included: unknown[] = []): { http: Http; calls: HttpRequest[] } {
    const calls: HttpRequest[] = [];
    const http: Http = async (request) => {
      calls.push(request);
      if (request.url.startsWith(`${ASC_API}/apps?`)) return { data: [{ id: "app-1" }] };
      if (request.url.startsWith(`${ASC_API}/builds?`)) {
        return { data: build ? [{ id: "b", attributes: build }] : [], included };
      }
      throw new Error(`unexpected ${request.url}`);
    };
    return { http, calls };
  }

  it("is ready once processing is VALID for internal testers", async () => {
    const { http, calls } = asc({ processingState: "VALID" });
    expect(await testflightBuildIsReady(http, "t", "com.example.app", 95, false)).toBe(true);
    expect(calls[1]!.url).toContain("filter[app]=app-1");
    expect(calls[1]!.url).toContain("filter[version]=95");
  });

  it("is not ready while processing, or when the build is unknown", async () => {
    expect(await testflightBuildIsReady(asc({ processingState: "PROCESSING" }).http, "t", "x", 95, false)).toBe(false);
    expect(await testflightBuildIsReady(asc(null).http, "t", "x", 95, false)).toBe(false);
  });

  it("waits for Beta App Review for external testers", async () => {
    for (const state of ["WAITING_FOR_REVIEW", "IN_REVIEW", "REJECTED"]) {
      const { http } = asc({ processingState: "VALID" }, [
        { type: "betaAppReviewSubmissions", attributes: { betaReviewState: state } },
      ]);
      expect(await testflightBuildIsReady(http, "t", "x", 95, true)).toBe(false);
    }
    const approved = asc({ processingState: "VALID" }, [
      { type: "betaAppReviewSubmissions", attributes: { betaReviewState: "APPROVED" } },
    ]);
    expect(await testflightBuildIsReady(approved.http, "t", "x", 95, true)).toBe(true);
    // A same-version rebuild skips review entirely: no submission at all.
    expect(await testflightBuildIsReady(asc({ processingState: "VALID" }).http, "t", "x", 95, true)).toBe(true);
  });
});

describe("promoteRow", () => {
  it("raises atomically and only upward", async () => {
    const calls: HttpRequest[] = [];
    const http: Http = async (request) => {
      calls.push(request);
      return [{ platform: "ios", latest_build: 95 }];
    };
    const log = new MemoryLogger();
    const ok = await promoteRow(makeSupabase(http, "https://db.example", "secret"), config(), log, NOW, "ios", 95, 92);
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url).toBe(
      "https://db.example/rest/v1/app_release_requirements?platform=eq.ios&latest_build=lt.95",
    );
    expect(JSON.parse(calls[0]!.body!)).toEqual({ latest_build: 95, updated_at: "2026-10-01T12:00:00Z" });
    expect(calls[0]!.headers).toMatchObject({ apikey: "secret", Authorization: "Bearer secret" });
  });

  it("reports no promotion when the row was already raised", async () => {
    const http: Http = async () => [];
    const ok = await promoteRow(makeSupabase(http, "https://db.example", "k"), config(), new MemoryLogger(), NOW, "ios", 95, 92);
    expect(ok).toBe(false);
  });

  it("writes nothing in a dry run", async () => {
    const http = vi.fn<Http>();
    const ok = await promoteRow(makeSupabase(http, "https://db.example", "k"), config({ dryRun: true }), new MemoryLogger(), NOW, "ios", 95, 92);
    expect(ok).toBe(false);
    expect(http).not.toHaveBeenCalled();
  });
});

describe("runPromote", () => {
  it("annotates and promotes nothing when Supabase is unreachable", async () => {
    const http: Http = async () => {
      throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND db.invalid") });
    };
    const log = new MemoryLogger();
    const supabase = makeSupabase(http, "https://db.invalid", "k");
    const deps = makePromoteDeps({ http, supabase, config: config(), github: { token: "", repository: "", apiUrl: "" }, log });
    expect(await runPromote(supabase, config(), deps)).toEqual([]);
    expect(log.errors).toEqual(["Could not read app_release_requirements: fetch failed: getaddrinfo ENOTFOUND db.invalid"]);
  });

  it("reads the configured table and polls both platforms", async () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const calls: HttpRequest[] = [];
    const http: Http = async (request) => {
      calls.push(request);
      const { method, url } = request;
      if (method === "GET" && url.includes("/rest/v1/releases?select=")) {
        return [
          { platform: "android", pending_build: 300, latest_build: 300 },
          { platform: "ios", pending_build: 95, latest_build: 92 },
        ];
      }
      if (url.startsWith(`${ASC_API}/apps?`)) return { data: [{ id: "app-1" }] };
      if (url.startsWith(`${ASC_API}/builds?`)) return { data: [{ id: "b", attributes: { processingState: "VALID" } }] };
      if (method === "PATCH") return [{ platform: "ios", latest_build: 95 }];
      throw new HttpError(500, url, "unexpected");
    };
    const cfg = config({ table: "releases", ios: { ...config().ios, privateKey: pem } });
    const log = new MemoryLogger();
    const supabase = makeSupabase(http, "https://db.example/", "k");
    const secrets: string[] = [];
    const deps = makePromoteDeps({
      http,
      supabase,
      config: cfg,
      github: { token: "", repository: "", apiUrl: "" },
      log,
      now: () => NOW,
      onSecret: (s) => secrets.push(s),
    });
    expect(await runPromote(supabase, cfg, deps)).toEqual(["ios"]);
    expect(calls.some((c) => c.url.startsWith(PLAY_API))).toBe(false);
    expect(calls.at(-1)!.url).toBe("https://db.example/rest/v1/releases?platform=eq.ios&latest_build=lt.95");
    expect(secrets).toHaveLength(1);
    expect(calls.find((c) => c.url.startsWith(ASC_API))!.headers!["Authorization"]).toBe(`Bearer ${secrets[0]}`);
    expect(log.errors).toEqual([]);
  });
});
