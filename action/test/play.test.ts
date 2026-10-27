// The Android review probe's guards. The probe commits an edit to the real
// Play app, so the properties that keep it harmless are asserted here rather
// than trusted:
//
//   * every commit carries changesInReviewBehavior=ERROR_IF_IN_REVIEW, because
//     Play's default would cancel the review we are waiting on;
//   * there is exactly one place in the code (and in the shipped bundle) that
//     commits an edit;
//   * a build is LIVE only on a successful probe, never on "in review", a
//     refusal, an error, or a build that is not in a completed release.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HttpError, type Http, type HttpRequest } from "../src/http.js";
import {
  PLAY_API,
  PROBE_COMMIT_QUERY,
  PlayProbeError,
  PlayState,
  playAvailability,
  releaseCompleted,
} from "../src/play.js";

const PACKAGE = "com.example.app";
const TRACK = "production";
const EDITS = `${PLAY_API}/${PACKAGE}/edits`;
const ROOT = join(import.meta.dirname, "..");

function httpError(status: number, message: string): HttpError {
  return new HttpError(status, EDITS, JSON.stringify({ error: { code: status, message } }));
}

function track(versionCode: number, status = "completed") {
  return { track: TRACK, releases: [{ status, versionCodes: [String(versionCode)] }] };
}

/** Stands in for the HTTP function, recording every call to the Play API. */
class FakePlay {
  readonly calls: HttpRequest[] = [];
  constructor(
    private readonly track: unknown | null,
    private readonly commitError: Error | null = null,
    private readonly trackPath = `/tracks/${TRACK}`,
  ) {}

  readonly http: Http = async (request) => {
    this.calls.push(request);
    const { method, url } = request;
    if (method === "POST" && url === EDITS) return { id: "edit-1" };
    if (method === "GET" && url.endsWith(this.trackPath)) {
      if (this.track === null) throw httpError(404, "not found");
      return this.track;
    }
    if (method === "POST" && url.includes(":commit")) {
      if (this.commitError) throw this.commitError;
      return { id: "edit-1" };
    }
    if (method === "DELETE") return null;
    throw new Error(`unexpected Play call ${method} ${url}`);
  };

  commits(): string[] {
    return this.calls.filter((c) => c.url.includes(":commit")).map((c) => c.url);
  }

  deleted(): boolean {
    return this.calls.some((c) => c.method === "DELETE");
  }
}

function check(play: FakePlay, commitProbe = true, trackName = TRACK): Promise<PlayState> {
  return playAvailability(play.http, "token", PACKAGE, trackName, 309, commitProbe);
}

describe("playAvailability", () => {
  it("every commit refuses to cancel a review", async () => {
    for (const error of [null, httpError(400, "You already have changes in review.")]) {
      const play = new FakePlay(track(309), error);
      await check(play);
      expect(play.commits().length, "the probe should have committed").toBeGreaterThan(0);
      for (const url of play.commits()) {
        expect(url).toContain("changesInReviewBehavior=ERROR_IF_IN_REVIEW");
      }
    }
  });

  it("commits the opened edit with exactly the probe query, and nothing else", async () => {
    const play = new FakePlay(track(309));
    await check(play);
    expect(play.commits()).toEqual([`${EDITS}/edit-1:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW`]);
    const commitUrl = new URL(play.commits()[0]!);
    expect([...commitUrl.searchParams.entries()]).toEqual([["changesInReviewBehavior", "ERROR_IF_IN_REVIEW"]]);
    const commitCall = play.calls.find((c) => c.url.includes(":commit"))!;
    expect(commitCall.body, "the probe must not send a body").toBeUndefined();
    expect(PROBE_COMMIT_QUERY).toBe("changesInReviewBehavior=ERROR_IF_IN_REVIEW");
  });

  it("reports in-review and abandons the edit", async () => {
    const play = new FakePlay(
      track(309),
      httpError(
        400,
        "You already have changes in review. Cancel this review or wait for it to complete before you try again.",
      ),
    );
    expect(await check(play)).toBe(PlayState.IN_REVIEW);
    expect(play.deleted()).toBe(true);
  });

  it("treats a clean commit as live", async () => {
    const play = new FakePlay(track(309));
    expect(await check(play)).toBe(PlayState.LIVE);
    expect(play.deleted(), "a committed edit is already closed").toBe(false);
  });

  it("raises a rejection-style refusal for a human", async () => {
    const play = new FakePlay(
      track(309),
      httpError(
        400,
        "Changes cannot be sent for review automatically. Please set the query parameter changesNotSentForReview to true.",
      ),
    );
    const error = await check(play).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlayProbeError);
    expect((error as PlayProbeError).needsHuman).toBe(true);
    expect(play.deleted()).toBe(true);
  });

  it("raises any other commit error", async () => {
    const play = new FakePlay(track(309), httpError(403, "permission denied"));
    const error = await check(play).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlayProbeError);
    expect((error as PlayProbeError).needsHuman).toBe(false);
    expect(play.deleted()).toBe(true);
  });

  it("lets a network error propagate and still abandons the edit", async () => {
    const play = new FakePlay(track(309), new TypeError("fetch failed"));
    await expect(check(play)).rejects.toThrow("fetch failed");
    expect(play.deleted()).toBe(true);
  });

  it("does not probe unless the build is in a completed release", async () => {
    for (const t of [null, track(308), track(309, "draft"), track(309, "inProgress")]) {
      const play = new FakePlay(t);
      expect(await check(play)).toBe(PlayState.NOT_ON_TRACK);
      expect(play.commits()).toEqual([]);
      expect(play.deleted()).toBe(true);
    }
  });

  it("never commits in a dry run", async () => {
    const play = new FakePlay(track(309));
    expect(await check(play, false)).toBe(PlayState.DRY_RUN_STOP);
    expect(play.commits()).toEqual([]);
    expect(play.deleted()).toBe(true);
  });

  it("reads the configured track, which must be the one the upload step releases to", async () => {
    // Reading another track promotes the gate past what users can install: a
    // production app once uploaded to production while this check still read
    // the beta track.
    const play = new FakePlay(track(309), null, "/tracks/beta");
    expect(await check(play, true, "beta")).toBe(PlayState.LIVE);
    const reads = play.calls.filter((c) => c.method === "GET").map((c) => c.url);
    expect(reads).toEqual([`${EDITS}/edit-1/tracks/beta`]);
  });
});

describe("the probe is the only commit", () => {
  function sources(): Record<string, string> {
    const dir = join(ROOT, "src");
    return Object.fromEntries(
      readdirSync(dir)
        .filter((f) => f.endsWith(".ts"))
        .map((f) => [f, readFileSync(join(dir, f), "utf8")]),
    );
  }

  it("has exactly one edits commit call in the source, carrying PROBE_COMMIT_QUERY", () => {
    const all = sources();
    const hits = Object.entries(all).flatMap(([file, text]) =>
      [...text.matchAll(/:commit/g)].map(() => file),
    );
    expect(hits, "commit Play edits only through the probe, with PROBE_COMMIT_QUERY").toEqual(["play.ts"]);
    expect(all["play.ts"]).toContain(":commit?${PROBE_COMMIT_QUERY}");
    expect(all["play.ts"]).toContain(
      'export const PROBE_COMMIT_QUERY = "changesInReviewBehavior=ERROR_IF_IN_REVIEW";',
    );
  });

  it("has exactly one edits commit call in the shipped bundle", () => {
    const bundle = readFileSync(join(ROOT, "dist/index.js"), "utf8");
    expect([...bundle.matchAll(/:commit/g)].length).toBe(1);
    expect(bundle).toContain(":commit?${PROBE_COMMIT_QUERY}");
    expect(bundle).toContain('"changesInReviewBehavior=ERROR_IF_IN_REVIEW"');
  });
});

describe("releaseCompleted", () => {
  it("matches numeric and string version codes in completed releases only", () => {
    expect(releaseCompleted({ releases: [{ status: "completed", versionCodes: [309] }] }, 309)).toBe(true);
    expect(releaseCompleted({ releases: [{ status: "completed", versionCodes: ["309"] }] }, 309)).toBe(true);
    expect(releaseCompleted({ releases: [{ status: "halted", versionCodes: ["309"] }] }, 309)).toBe(false);
    expect(releaseCompleted({ releases: [{ status: "completed" }] }, 309)).toBe(false);
    expect(releaseCompleted(null, 309)).toBe(false);
  });
});
