# App Version Gate (GitHub Action)

`uses: BrianLandes/app-version-gate@v0`

Your app shows an "update available" prompt when its build number is below
`latest_build` in a Supabase table. This action keeps that number honest: it
moves only once the store actually serves the new build, not when CI uploads
it.

A build is not installable the moment CI uploads it. Google Play still reviews
the release, and TestFlight still has to process the build (and run Beta App
Review before external testers can get it). If `latest_build` moves at upload
time, users are prompted to update to something the store won't give them yet.

The action has two modes:

- **`mode: stage`** runs in your build workflow, right after the store upload.
  It writes the new build number to `pending_build`.
- **`mode: promote`** runs on a schedule. For each platform with a staged build
  (`pending_build > latest_build`) it asks the store whether that exact build is
  live, and only then raises `latest_build` to it.

Both modes only ever **raise** a value, never lower it. `min_supported_build`
(the force-update kill switch) is never touched.

- **iOS** is straightforward. App Store Connect reports processing state and
  Beta App Review state directly.
- **Android** is not. The Play Developer API has **no review status**. The
  action learns whether a release is still in review by **committing an empty
  edit with `changesInReviewBehavior=ERROR_IF_IN_REVIEW`**, which Play refuses
  while anything is in review. That is a workaround, fenced by guards, tests, a
  kill switch and a dry run, and every uncertain outcome resolves to *don't
  promote*. Read [The Play review probe](#the-play-review-probe) before you turn
  it on.

## Contents

- [The table](#the-table)
- [Setup](#setup)
- [Inputs](#inputs)
- [Outputs](#outputs)
- [How failures behave](#how-failures-behave)
- [The iOS check](#the-ios-check)
- [The Play review probe](#the-play-review-probe)
- [Development](#development)

## The table

One row per platform, keyed by `platform` (`'android'` or `'ios'`):

| Column | Written by | Meaning |
|---|---|---|
| `latest_build` | `promote` (or `stage` with `column: latest_build`, or you, by hand) | Clients below this build get the "update available" prompt. |
| `pending_build` | `stage` | The newest uploaded build. `pending_build > latest_build` means a build is uploaded but not yet confirmed live. Clients never read it. |
| `min_supported_build` | only you | Clients below this get a blocking update screen. This action never writes it. |
| `updated_at` | both modes | Timestamp of the last write. |

The table must not be writable by clients. Both modes write through PostgREST
with a Supabase secret key, so they work behind any RLS policy. The
repository's `supabase/` directory has a migration that creates the table.

## Setup

You need two workflows: a stage step in each build workflow, and one scheduled
promote workflow.

### 1. Stage each upload

Add a step after the store upload in each build workflow. It must come after the
upload, because a staged build is what `promote` goes on to check.

**Android.** The Android check assumes the versionCode **is** the upload
workflow's `github.run_number`. It uses that to find the run that uploaded the
build and to age it (see [Assumptions](#assumptions)).

```yaml
# .github/workflows/build.yml (the file name is the play-upload-workflow input)
      - name: Upload to Google Play
        uses: r0adkll/upload-google-play@v1
        with:
          serviceAccountJsonPlainText: ${{ secrets.PLAY_SERVICE_ACCOUNT_JSON }}
          packageName: com.example.app
          releaseFiles: build/app/outputs/bundle/release/app-release.aab
          track: production          # must equal the promote job's play-track
          status: completed

      - name: Stage the build for the update gate
        uses: BrianLandes/app-version-gate@v0
        with:
          mode: stage
          platform: android
          build: ${{ github.run_number }}   # = the versionCode
          supabase-url: ${{ secrets.SUPABASE_URL }}
          supabase-secret-key: ${{ secrets.SUPABASE_SECRET_KEY }}
```

**iOS.** Stage the `CFBundleVersion` you uploaded to TestFlight. The iOS check
looks the build up by that number and doesn't depend on run numbers.

```yaml
      - name: Stage the build for the update gate
        uses: BrianLandes/app-version-gate@v0
        with:
          mode: stage
          platform: ios
          build: ${{ steps.buildnum.outputs.code }}
          supabase-url: ${{ secrets.SUPABASE_URL }}
          supabase-secret-key: ${{ secrets.SUPABASE_SECRET_KEY }}
```

A failed stage call never fails the build. It annotates and exits 0, because a
published build must not be marked failed over this bookkeeping.

### 2. Promote on a schedule

```yaml
# .github/workflows/promote-releases.yml
name: Promote released builds

on:
  schedule:
    - cron: '17 * * * *'   # hourly, off the top of the hour
  workflow_dispatch:
    inputs:
      dry_run:
        description: 'Read-only: skip the Play review-probe commit and every latest_build write'
        type: boolean
        default: false

# One poll at a time; a slow run should not stack with the next tick.
concurrency:
  group: app-version-gate-promote
  cancel-in-progress: false

jobs:
  promote:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    # actions: read lets the action list the upload workflow's runs: whether
    # one is in flight (then Play must not be touched), and when the pending
    # build was staged.
    permissions:
      actions: read
      contents: read
    steps:
      - uses: BrianLandes/app-version-gate@v0
        id: gate
        with:
          mode: promote
          supabase-url: ${{ secrets.SUPABASE_URL }}
          supabase-secret-key: ${{ secrets.SUPABASE_SECRET_KEY }}
          # Android
          android-package: com.example.app
          play-service-account-json: ${{ secrets.PLAY_SERVICE_ACCOUNT_JSON }}
          play-track: production
          play-upload-workflow: build.yml
          play-review-probe: ${{ vars.PLAY_REVIEW_PROBE || 'on' }}
          play-min-age-hours: ${{ vars.PLAY_MIN_AGE_HOURS || '2' }}
          # iOS
          ios-bundle-id: com.example.app
          appstore-key-id: ${{ secrets.APPSTORE_API_KEY_ID }}
          appstore-issuer-id: ${{ secrets.APPSTORE_API_ISSUER_ID }}
          appstore-private-key: ${{ secrets.APPSTORE_API_PRIVATE_KEY }}
          testflight-external: ${{ vars.TESTFLIGHT_EXTERNAL || 'false' }}
          dry-run: ${{ inputs.dry_run || false }}

      - if: steps.gate.outputs.promoted != ''
        run: echo "Promoted ${{ steps.gate.outputs.promoted }}"
```

Keeping `PLAY_REVIEW_PROBE` and `PLAY_MIN_AGE_HOURS` in repository variables
(*Settings → Secrets and variables → Actions → Variables*) means you can flip
the kill switch without a commit.

The action reuses the store credentials your build workflows already hold. Leave
a platform's credentials out and that platform is skipped. That is silent while
nothing is staged for it, and an error annotation once a build is staged and
can't be checked.

Because the promote step makes real writes to your production Play app, pin it
to a full commit SHA rather than `@v0` if you want to review every change to the
probe before it runs.

## Inputs

| Input | Mode | Default | Description |
|---|---|---|---|
| `mode` | both | (required) | `stage` or `promote`. |
| `supabase-url` | both | (required) | Supabase project URL, e.g. `https://<ref>.supabase.co`. |
| `supabase-secret-key` | both | (required) | A Supabase secret API key (`sb_secret_…`) or legacy service-role JWT. |
| `table` | both | `app_release_requirements` | The release table. Must be a plain identifier. |
| `platform` | stage | | `android` or `ios`. |
| `build` | stage | | The build number just uploaded, as a positive integer. |
| `column` | stage | `pending_build` | `pending_build` stages the build for `promote`. `latest_build` skips the store check and is for emergency bumps only. Either way, the value is only raised. |
| `android-package` | promote | | Android application ID. If it's empty, Android is skipped. |
| `play-service-account-json` | promote | | Service-account JSON key with Play Console access to the app. If it's empty, Android is skipped. |
| `play-track` | promote | `production` | The track your upload step releases to, which is the one users install from. It must match the upload's `track`. |
| `play-upload-workflow` | promote | `build.yml` | **File name** of the workflow that uploads to Play. Its `run_number` must be the versionCode. Play is never touched while a run of it is queued, waiting or in progress. |
| `play-min-age-hours` | promote | `2` | Hours after the staging run finished before the first probe. Anything that isn't a non-negative number disables the probe and annotates. |
| `play-review-probe` | promote | `on` | `off` (also `false`, `0` or `no`) is the Android kill switch. It never touches Play and never auto-promotes Android, and it annotates whenever an Android build is staged. |
| `ios-bundle-id` | promote | | iOS bundle ID. If it's empty, iOS is skipped. |
| `appstore-key-id` | promote | | App Store Connect API key ID. |
| `appstore-issuer-id` | promote | | App Store Connect API issuer ID. |
| `appstore-private-key` | promote | | The `.p8` key, as raw PEM or base64 (of the file or of its DER body). The form is detected automatically, and literal `\n` escapes are accepted. |
| `testflight-external` | promote | `false` | `true` if builds go to external TestFlight testers. Promotion then also waits for Beta App Review, not just processing. |
| `dry-run` | promote | `false` | Checks everything, but skips the Play review-probe commit and every `latest_build` write. A dry run still opens and deletes a Play edit (see the [guards](#guards-and-what-each-one-protects)). |
| `github-token` | promote | `${{ github.token }}` | Lists the upload workflow's runs. Needs `actions: read`. |

## Outputs

| Output | Mode | Description |
|---|---|---|
| `promoted` | promote | Comma-separated platforms whose `latest_build` was raised this run (e.g. `android,ios`), or empty. A dry run always leaves it empty. |

## How failures behave

The failure mode is deliberately one-directional. On **any** uncertainty (an
API error, missing credentials, a build still processing, an upload in flight)
`promote` declines and leaves `latest_build` where it is. Over-promoting is the
bug this action exists to prevent. Under-promoting just means the prompt waits
for the next poll, so an extra or missed run is harmless.

- Every decline is logged.
- Anything a human should look at becomes an `::error::` annotation on the run
  and the step still exits 0. That covers a store-check error, a probe refusal,
  a build stuck for days, missing credentials for a staged build, and the kill
  switch being on while a build is staged.
- Only a configuration mistake fails the step: an invalid `mode`, `platform`,
  `build`, `column` or `table`.
- Secret material (the service-account key, the `.p8`) stays in memory and is
  never written to disk. Tokens the action mints are masked in the log.

## The iOS check

For a staged iOS build, the action signs an ES256 App Store Connect API token,
looks the app up by `ios-bundle-id` and fetches the build by version:

- `processingState` must be `VALID`.
- With `testflight-external: true`, any Beta App Review submission for the build
  must also be out of `WAITING_FOR_REVIEW`, `IN_REVIEW` and `REJECTED`. A
  same-version rebuild skips review and has no submission, and counts as ready.

The App Store Connect API key needs a role that can read the app's builds. The key your TestFlight upload step uses already can.

---

## The Play review probe

The Android half of `promote` uses a workaround for a gap in Google's API. This
section explains it in full. Read it before you enable Android promotion,
change your Play upload step, or change `src/play.ts` / `src/promote.ts`.

### Why it exists

The obvious check is "the versionCode is in a `completed` release on the
track". That field is the status **the uploader requested**, not what Google
has approved. An upload step that releases with `status: completed` makes the
track read `completed` from the moment of upload. The API's only release
statuses are `draft`, `inProgress`, `halted` and `completed`, and review state
is not exposed anywhere.

A production app's first version of this poller trusted that field, and it
promoted every Android build on the first poll after upload. One build was
uploaded and then promoted an hour and a half later, before Google had approved
it. Users were prompted to update to a build Play would not yet serve them.

The only review signal the API exposes is a side effect of
[`edits.commit`](https://developers.google.com/android-publisher/api-ref/rest/v3/edits/commit).
Its `changesInReviewBehavior` parameter controls what happens when changes are
already in review:

| Value | Behaviour |
|---|---|
| unset / `CANCEL_IN_REVIEW_AND_SUBMIT` (**the default**) | cancels the in-progress review and resubmits |
| `ERROR_IF_IN_REVIEW` | returns HTTP 400 "You already have changes in review…" |

So an edit that changes nothing, committed with `ERROR_IF_IN_REVIEW`, answers
"is anything in review?" and does nothing else.

### How the Android check works

On each poll, for a staged build (`pending_build > latest_build`):

1. **Kill switch.** If `play-review-probe` is `off`, stop and annotate. Promote
   by hand.
2. **Upload guard.** List the recent runs of `play-upload-workflow` through the
   GitHub API. If any run is queued, waiting or in progress (any status other
   than `completed`), stop. Play is not touched at all. (Why: see the
   [ramifications](#ramifications-what-you-are-accepting).) If the runs can't be
   listed, stop and annotate.
3. **Minimum age.** Find the upload run whose `run_number` equals the pending
   build (versionCode = `github.run_number`). If it finished less than
   `play-min-age-hours` ago (default 2), stop. This covers any lag between the
   upload commit and Play registering the review. If the build was staged more
   than 3 days ago, also raise an `::error::` annotation, because it is probably
   stuck. If no run with that number is among the 100 most recent runs, stop
   and annotate.
4. **Track check.** Open an edit and read `play-track`. If the build isn't in a
   `completed` release, abandon (delete) the edit and stop. In a dry run, stop
   here too, abandoning the edit.
5. **Review probe.** Commit that same unchanged edit with
   `?changesInReviewBehavior=ERROR_IF_IN_REVIEW`:

| Play's answer | Meaning | Action |
|---|---|---|
| 200 | nothing in review, so the `completed` release is being served | **promote** |
| 400 "…already have changes in review…" | Google is still reviewing | wait for the next poll |
| 400 "…cannot be sent for review automatically…" | Play needs a human: usually a **rejected** release, sometimes unsent Play Console changes | `::error::` annotation, wait |
| anything else (403, 5xx, network) | unknown | `::error::` annotation, wait |

Only step 5 writes anything to Play, and what it commits is empty. The
promotion itself is a single conditional update
(`… where platform = 'android' and latest_build < <N>`), so a concurrent raise
is never undone.

### Guards, and what each one protects

| Guard | Protects against | Where |
|---|---|---|
| `PROBE_COMMIT_QUERY` constant, used by the single commit call | omitting the flag, which would **cancel the review you are waiting on** (Play's default) | `src/play.ts` |
| Tests: every commit URL carries the flag and nothing else, and both the source and the shipped bundle contain exactly one commit call | a later change dropping or bypassing it | `test/play.test.ts` |
| Tests and `check-dist` run before every release of this action, so the committed bundle is the tested source | shipping a broken guard | this repository's release process |
| No Play calls while any `play-upload-workflow` run is active | invalidating a CI upload's open edit, which fails that build | `pollAndroid` in `src/promote.ts` |
| Minimum age | probing in a gap before Play registers the review | `pollAndroid` |
| Any error means no promotion | over-promotion, the bug this exists to prevent | throughout |
| Only-raise writes (`latest_build=lt.<N>`) | a concurrent or out-of-order run lowering the gate | `promoteRow`, `runStage` |
| `play-review-probe: off` | anything unforeseen. It turns Android auto-promotion off without a code change | input (put it in a repository variable) |
| `dry-run` | trying the logic without writing to Play or Supabase | input (wire it to a `workflow_dispatch` input) |

### Ramifications (what you are accepting)

- **The action commits to your production Play app roughly hourly while a
  build is in review.** Each commit is empty. At most one probe runs per poll,
  and only while a build is staged, has aged past the minimum, and is on the
  track. Once the build is promoted, polls stop touching Play.
- **Commits and edits invalidate other edits.** Per Google, *"If anyone commits
  an edit or makes changes to an app through the Play Console, all other edits
  for the app (owned by any user) are invalidated."* Opening an edit also
  invalidates your own previous one, and CI and the poller usually share one
  service account. The upload guard handles the workflow named in
  `play-upload-workflow`, and nothing else. It doesn't know about a second
  workflow that uploads, or about a human running their own API tool (fastlane,
  a script) against the app, which could fail if a probe lands mid-session. Set
  `play-review-probe` to `off` while doing that. A dry run opens and deletes an
  edit too, so it carries the same exposure.
- **Residual race.** The guard checks for active runs once, then probes within
  seconds. An upload run that starts in that window can still collide only if it
  reaches its upload step before the probe finishes. A workflow that builds the
  app first takes many minutes to get there, so the window is theoretical. If
  your upload workflow uploads within seconds of starting (for example, it
  only uploads a prebuilt artifact), the window is real. Keep the build in the
  same workflow, or accept the occasional failed upload and re-run it.
- **Unsent Play Console changes.** If someone has saved changes in Play Console
  without sending them for review, the probe will probably be refused with
  "cannot be sent for review automatically" (an alert, no harm). It has not been
  ruled out that an empty API commit sends those pending changes for review
  instead. Don't leave half-finished Console changes saved while a build is
  pending, or set `play-review-probe` to `off` while you work in the Console.
- **Rejections block promotion, correctly.** A rejected release leaves the app
  in the "cannot be sent automatically" state, so the probe is refused and the
  run annotates. Your next CI upload will also fail until the rejection is dealt
  with in Play Console.
- **Other changes in review delay promotion.** A store-listing or policy update
  in review reads as "in review" too. It's a harmless delay.
- **Promotion lags approval by up to one poll.** GitHub runs scheduled workflows
  late, in practice sometimes every 3–5 hours for an hourly cron. Run the
  workflow manually for an immediate check.
- **Managed publishing must stay off.** With it on, an approved release waits
  for a human to click Publish. Whether it still counts as "in review" in that
  state is unknown, so the probe could promote a build that isn't served yet. If
  you turn managed publishing on, set `play-review-probe` to `off`.

### Permissions

- **Google Cloud Console:** the service account needs **no** GCP IAM roles. The
  *Google Play Android Developer API* must be enabled in its project.
- **Play Console** (*Users and permissions*, on the service account's email):
  *View app information*, plus the release permission for the track you
  upload to (*Release to production, exclude devices, and use Play App Signing*
  for `production`, *Release to testing tracks* for a testing track). Committing
  an edit is the same operation your CI upload performs with that account, so
  the account your upload step uses already has what the probe needs. If it
  doesn't, the probe gets a 403, annotates, and never promotes. The first
  supervised run (below) settles it.
- **GitHub:** the promote job declares `permissions: actions: read, contents:
  read` so `github-token` can list the upload workflow's runs. There are no
  repository settings to change.

### First rollout (do once, supervised)

1. **Dry run.** Actions → your promote workflow → *Run workflow* with
   `dry_run` ticked. Expect the Android line to report the GitHub, age and track
   checks, and no commit and no `latest_build` write.
2. **First real probe, while nothing is in review.** Run it without `dry_run`
   when nothing is staged and nothing is in review. It will say "nothing staged"
   and skip Play. Then wait for the next CI build. The polls after it should
   log `still in Google review` until Google approves, then promote. Watch that
   first cycle's logs.
3. **If the probe is refused with something unexpected** (for example, Play
   rejects an edit with no changes, or a 403), the run shows an `::error::` and
   nothing is promoted. Set `play-review-probe` to `off`, promote builds by
   hand, and investigate.
4. After the cycle, check Play Console → *Publishing overview* and the release
   history. The probe should leave no trace, since it commits nothing.

Worst case if the flag were ever lost: one probe cancels the in-progress review
and resubmits the same release, so review restarts. Nothing ships early, and
nothing is lost.

### Runbook

**Promote Android by hand** (with the probe off, or after checking Play Console
yourself). In the Supabase SQL editor:

```sql
update app_release_requirements
   set latest_build = <N>, updated_at = now()
 where platform = 'android' and latest_build < <N>;
```

(Or run the action once with `mode: stage`, `column: latest_build`,
`build: <N>`.)

**"build N was staged X days ago and is still not promoted"**: open Play
Console → *Publishing overview*. Usually it is a rejection (fix it, then upload
a new build, which supersedes N) or a Console prompt waiting on a human. The
alarm repeats on every poll until the build is promoted or a newer one is
staged.

**"review probe for build N refused … Play is waiting on a human"**: same as
above. Resolve it in Play Console, and the next poll retries on its own.

**"no `<workflow>` run #N among recent runs"**: the versionCode isn't the upload
workflow's run number, `play-upload-workflow` names the wrong file, or the run
is older than the 100 most recent. Promote by hand. If your versionCode
scheme differs, this check can't age your builds (see Assumptions).

**Turn Android auto-promotion off**: set the repository variable
`PLAY_REVIEW_PROBE` to `off` (with the workflow above). Each poll then annotates
and leaves promotion to you. Delete the variable to turn it back on.

**Change the minimum age**: set the repository variable `PLAY_MIN_AGE_HOURS`.

### Assumptions

If any of these stop holding, revisit the Android check before relying on it:

- Only `play-upload-workflow` uploads to Play. The upload guard watches that
  workflow by file name.
- The versionCode is that workflow's `github.run_number`. The age lookup depends
  on it.
- The app sends changes for review automatically. That means no
  `changesNotSentForReview` on the upload, and managed publishing off.
- Users get the build from `play-track`, and the upload step releases straight
  to it. If releases go through a testing track first, promote the gate from
  the track **most** users are on, never the earliest. Reading the wrong track
  prompts users for builds they can't install.
- The error texts `already have changes in review` and `cannot be sent for
  review automatically` are matched as substrings. If Google rewords them, the
  probe is refused with an unrecognised error, which fails safe and annotates.
  Update `PLAY_IN_REVIEW_MARKER` / `PLAY_NEEDS_HUMAN_MARKER` in `src/play.ts`.

### When this can be deleted

If the Play Developer API adds a review or publishing state to tracks or
releases, replace step 5 with a read of that field and remove the probe. As of
2026-09 it has none. See the
[`edits.tracks`](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.tracks)
reference.

---

## Development

The action is TypeScript under `action/src`, bundled by esbuild into the
single committed file `action/dist/index.js`. GitHub runs JavaScript actions
straight from the repository without installing dependencies, so the bundle
must be committed.

```bash
cd action
npm ci
npm run typecheck    # tsc, strict
npm test             # vitest
npm run build        # rebuild dist/index.js; commit the result
npm run check-dist   # fails if dist/index.js is stale relative to src
```

The decision logic (`pollAndroid`, `pollIos`, `playAvailability`,
`testflightBuildIsReady`, `runStage`) takes its HTTP function, clock and logger
as parameters, so the tests drive it with fakes and never touch the network.

To try the bundle locally, set inputs the way the runner does (`INPUT_` plus the
upper-cased input name, hyphens kept):

```bash
env INPUT_MODE=promote INPUT_DRY-RUN=true \
    INPUT_SUPABASE-URL=https://<ref>.supabase.co INPUT_SUPABASE-SECRET-KEY=... \
    GITHUB_OUTPUT=/dev/null node action/dist/index.js
```
