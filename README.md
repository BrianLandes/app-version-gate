# app-version-gate

**Force-update and update-available prompts for Flutter apps, with a GitHub Action that announces a build only once the store actually serves it.**

Every mobile app eventually ships a build it needs to retire: a data bug, a broken API contract, a security fix. You need a kill switch that reaches old builds. You also need a way to tell users a new build is out without prompting them for one the store hasn't approved yet.

This repo has three parts, and each works on its own:

| Part | What it does |
|---|---|
| [`app_version_gate`](packages/app_version_gate) (pub.dev) | The Flutter side. Checks the build at startup and on resume, shows a blocking update screen below the minimum and a once-per-build prompt below the latest, tries Play's in-app update before the store link, and **fails open** on any error. Reads from any backend. |
| [`app_version_gate_supabase`](packages/app_version_gate_supabase) (pub.dev) | Reads the requirements from a Supabase table. [The migration](supabase/migrations) creates it, readable before sign-in and writable only by the service role. |
| [The GitHub Action](action) | `mode: stage` records each build CI uploads. `mode: promote`, run hourly, advances `latest_build` only once App Store Connect or Google Play confirms that build is live. |

```text
 CI uploads build 312 ──► stage: pending_build = 312
                                   │
        hourly: promote ──► is 312 live in the store?
                             no  ─► wait (users see nothing)
                             yes ─► latest_build = 312
                                   │
           app on build 311 ──► "A new version is ready"  (once)
           app below minimum ──► blocking update screen     (kill switch)
```

## Why this exists

It was built for [GobbleGo](https://gobblego.com), a Flutter + Supabase app, and every part comes from something that went wrong in production:

- **Users were prompted to update to a build they couldn't download.** CI bumped `latest_build` the moment it uploaded, but a build isn't installable until Google reviews it or TestFlight finishes processing. Hence the split between staging and promoting.
- **Google Play's API has no review status.** A release reads `completed` from the moment you upload it, which is how build 309 was promoted 90 minutes after upload, before Google had approved it. The Action works around this: it commits an *empty* edit with `changesInReviewBehavior=ERROR_IF_IN_REVIEW`, which Play refuses while anything is in review. That call is fenced by guards, unit tests, a kill switch and a dry run, and [the Action's README](action/README.md#the-play-review-probe) documents every one.
- **A raised minimum took 31 hours to reach a phone that never closed the app.** A process the OS keeps alive never runs `main()` again, so the gate rechecks on resume.
- **A user was stuck on the force-update screen.** Ten taps on its only button in two minutes, and each time the TestFlight link failed to open. Store links now fall back to the in-app browser.

## Quick start

1. **Create the table.** Copy [the migration](supabase/migrations/20260101000000_app_release_requirements.sql) into your Supabase project's `supabase/migrations/` and push it. Set `store_url` for each platform.
2. **Gate the app.** See [`app_version_gate`](packages/app_version_gate#quick-start):
   ```dart
   final gate = AppVersionGate(source: SupabaseRequirementsSource(Supabase.instance.client));
   await gate.check(); // in main(), before runApp()
   ```
3. **Promote automatically** (optional). Add the two workflows from [the Action's setup](action/README.md#setup). Without them, raise `latest_build` by hand when a build goes live.

To force old builds off, raise `min_supported_build` in the SQL editor. **Never raise it above the build live in the public store.**

## Not using Supabase?

The Flutter package reads from any `ReleaseRequirementsSource`. `JsonUrlRequirementsSource` reads a static JSON file on any host, so it needs no backend at all. The Action currently writes only to Supabase.

## Development

```bash
cd packages/app_version_gate && flutter test
cd packages/app_version_gate_supabase && flutter test
cd action && npm ci && npm test && npm run check-dist   # dist/ is committed: rebuild with npm run build
```

## License

MIT
