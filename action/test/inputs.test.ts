import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InputError, readConfig } from "../src/inputs.js";

function getter(values: Record<string, string>) {
  return (name: string) => values[name] ?? "";
}

const BASE = { "supabase-url": "https://db.example", "supabase-secret-key": "k" };

describe("readConfig", () => {
  it("applies the documented promote defaults", () => {
    const config = readConfig(getter({ ...BASE, mode: "promote", "github-token": "t" }), {
      GITHUB_REPOSITORY: "o/r",
    });
    if (config.mode !== "promote") throw new Error("wrong mode");
    expect(config.common.table).toBe("app_release_requirements");
    expect(config.github).toEqual({ token: "t", repository: "o/r", apiUrl: "https://api.github.com" });
    expect(config.promote.dryRun).toBe(false);
    expect(config.promote.android).toMatchObject({
      track: "production",
      uploadWorkflow: "build.yml",
      minAgeHours: 2,
      reviewProbe: true,
    });
    expect(config.promote.ios.testflightExternal).toBe(false);
  });

  it("turns the review probe off for any usual spelling of off", () => {
    for (const value of ["off", "OFF", "false", "0", "no"]) {
      const config = readConfig(getter({ ...BASE, mode: "promote", "play-review-probe": value }));
      if (config.mode !== "promote") throw new Error("wrong mode");
      expect(config.promote.android.reviewProbe).toBe(false);
    }
  });

  it("parses booleans and the minimum age", () => {
    const config = readConfig(
      getter({ ...BASE, mode: "promote", "dry-run": "true", "testflight-external": "1", "play-min-age-hours": "0.5" }),
    );
    if (config.mode !== "promote") throw new Error("wrong mode");
    expect(config.promote.dryRun).toBe(true);
    expect(config.promote.ios.testflightExternal).toBe(true);
    expect(config.promote.android.minAgeHours).toBe(0.5);
  });

  it("defaults stage to pending_build", () => {
    const config = readConfig(getter({ ...BASE, mode: "stage", platform: "ios", build: "93" }));
    expect(config).toMatchObject({ mode: "stage", stage: { platform: "ios", build: 93, column: "pending_build" } });
  });

  it("rejects bad configuration", () => {
    const bad: Record<string, string>[] = [
      { mode: "deploy" },
      { mode: "stage", platform: "web", build: "1" },
      { mode: "stage", platform: "ios", build: "1.5" },
      { mode: "stage", platform: "ios", build: "0" },
      { mode: "stage", platform: "ios", build: "abc" },
      { mode: "stage", platform: "ios", build: "1", column: "min_supported_build" },
      { mode: "promote", table: "x; drop table y" },
    ];
    for (const values of bad) {
      expect(() => readConfig(getter({ ...BASE, ...values }))).toThrow(InputError);
    }
  });
});

describe("action.yml", () => {
  it("documents every input the code reads, and nothing else", () => {
    const yml = readFileSync(join(import.meta.dirname, "../../action.yml"), "utf8");
    const declared = [...yml.matchAll(/^ {2}([a-z][a-z0-9-]*):\s*$/gm)].map((m) => m[1]);
    const inputsBlock = yml.slice(yml.indexOf("\ninputs:"), yml.indexOf("\noutputs:"));
    const inputNames = declared.filter((name) => inputsBlock.includes(`\n  ${name}:`));
    const src = ["inputs.ts", "main.ts"].map((f) => readFileSync(join(import.meta.dirname, "../src", f), "utf8")).join("\n");
    const read = new Set([...src.matchAll(/(?:input|get)\("([a-z0-9-]+)"/g)].map((m) => m[1]));
    expect(new Set(inputNames)).toEqual(read);
  });
});
