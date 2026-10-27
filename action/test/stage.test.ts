import { describe, expect, it } from "vitest";
import type { Http, HttpRequest } from "../src/http.js";
import { MemoryLogger } from "../src/log.js";
import { runStage, type StageConfig } from "../src/stage.js";
import { makeSupabase } from "../src/supabase.js";

const NOW = new Date("2026-10-01T12:00:00Z");
const STAGE: StageConfig = { table: "app_release_requirements", platform: "android", build: 310, column: "pending_build" };

function fake(current: Record<string, unknown>[] | Error, patched: unknown = [{}]) {
  const calls: HttpRequest[] = [];
  const http: Http = async (request) => {
    calls.push(request);
    if (request.method === "GET") {
      if (current instanceof Error) throw current;
      return current;
    }
    return patched;
  };
  return { supabase: makeSupabase(http, "https://db.example", "k"), calls };
}

describe("runStage", () => {
  it("raises the column, guarded so a concurrent raise is never undone", async () => {
    const { supabase, calls } = fake([{ pending_build: 309 }]);
    const log = new MemoryLogger();
    expect(await runStage(supabase, STAGE, log, NOW)).toBe(true);
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["GET", "https://db.example/rest/v1/app_release_requirements?platform=eq.android&select=pending_build"],
      ["PATCH", "https://db.example/rest/v1/app_release_requirements?platform=eq.android&pending_build=lt.310"],
    ]);
    expect(JSON.parse(calls[1]!.body!)).toEqual({ pending_build: 310, updated_at: "2026-10-01T12:00:00Z" });
    expect(log.infos).toEqual(["pending_build for android: 309 -> 310."]);
  });

  it("never lowers or rewrites the value", async () => {
    for (const current of [310, 400]) {
      const { supabase, calls } = fake([{ pending_build: current }]);
      expect(await runStage(supabase, STAGE, new MemoryLogger(), NOW)).toBe(false);
      expect(calls.filter((c) => c.method === "PATCH")).toEqual([]);
    }
  });

  it("can write latest_build directly", async () => {
    const { supabase, calls } = fake([{ latest_build: null }]);
    expect(await runStage(supabase, { ...STAGE, column: "latest_build", platform: "ios" }, new MemoryLogger(), NOW)).toBe(true);
    expect(calls[1]!.url).toContain("platform=eq.ios&latest_build=lt.310");
  });

  it("annotates a missing row without writing", async () => {
    const { supabase, calls } = fake([]);
    const log = new MemoryLogger();
    expect(await runStage(supabase, STAGE, log, NOW)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(log.errors[0]).toContain("No app_release_requirements row for platform 'android'");
  });

  it("treats an empty PATCH result as a concurrent raise", async () => {
    const { supabase } = fake([{ pending_build: 1 }], []);
    const log = new MemoryLogger();
    expect(await runStage(supabase, STAGE, log, NOW)).toBe(false);
    expect(log.errors).toEqual([]);
  });

  it("annotates instead of throwing on an API error", async () => {
    const { supabase } = fake(new TypeError("fetch failed"));
    const log = new MemoryLogger();
    expect(await runStage(supabase, STAGE, log, NOW)).toBe(false);
    expect(log.errors).toEqual(["Could not set pending_build for android: fetch failed"]);
  });
});
