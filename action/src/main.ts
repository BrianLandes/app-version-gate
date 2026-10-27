// App Version Gate: stage uploaded builds and promote them into an in-app
// update gate only once the store really serves them.
//
// The approach (in particular the Android review probe) came from GobbleGo's
// production release pipeline, where it replaced a check that promoted builds
// before Google had approved them.
//
// The action never fails the step over an operational problem: an unreachable
// API, missing store credentials or a store refusal is an error annotation and
// a declined promotion. Only a configuration mistake (a bad `mode`, `platform`
// or `build` input) fails the step.

import * as core from "@actions/core";
import { describeError, fetchHttp, type Http } from "./http.js";
import { InputError, readConfig } from "./inputs.js";
import type { Logger } from "./log.js";
import { makePromoteDeps, runPromote } from "./promote.js";
import { runStage } from "./stage.js";
import { makeSupabase } from "./supabase.js";

const coreLogger: Logger = {
  info: (message) => core.info(message),
  notice: (message) => core.notice(message),
  error: (message) => core.error(message),
};

export async function run(http: Http = fetchHttp, log: Logger = coreLogger): Promise<void> {
  try {
    const config = readConfig((name) => core.getInput(name));
    const { supabaseUrl, supabaseKey } = config.common;
    if (!supabaseUrl || !supabaseKey) {
      log.error(`supabase-url / supabase-secret-key not set; skipping ${config.mode}.`);
      if (config.mode === "promote") core.setOutput("promoted", "");
      return;
    }
    const supabase = makeSupabase(http, supabaseUrl, supabaseKey);

    if (config.mode === "stage") {
      await runStage(supabase, config.stage, log, new Date());
      return;
    }

    const deps = makePromoteDeps({
      http,
      supabase,
      config: config.promote,
      github: config.github,
      log,
      onSecret: (value) => core.setSecret(value),
    });
    const promoted = await runPromote(supabase, config.promote, deps);
    core.setOutput("promoted", promoted.join(","));
  } catch (error) {
    if (error instanceof InputError) {
      core.setFailed(`Invalid input: ${error.message}`);
    } else {
      // A bug, not an operational failure: fail the step, without a stack trace.
      core.setFailed(`app-version-gate: unexpected error: ${describeError(error)}`);
    }
  }
}
