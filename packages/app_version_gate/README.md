# app_version_gate

Force-update and update-available prompts for Flutter apps, driven by per-platform build numbers.

- **A kill switch.** Raise `min_supported_build` and every older build shows a blocking update screen on its next launch, or its next return to the foreground.
- **A once-per-build prompt.** Raise `latest_build` and older builds get a dismissible "a new version is ready" dialog, once. On Android it tries Play's in-app download first and falls back to the store link.
- **It never bricks a healthy install.** Every failure (offline, an outage, a malformed row, a timeout) fails open.

It reads from any backend: Supabase (with [app_version_gate_supabase](https://pub.dev/packages/app_version_gate_supabase)), a JSON file on any host, or your own source. The [companion GitHub Action](https://github.com/BrianLandes/app-version-gate) advances `latest_build` only once the store actually serves the new build, so users are never prompted for an update they can't download yet.

Built for [GobbleGo](https://gobblego.com), where it has gated every Android and iOS release.

## Quick start

```dart
import 'package:app_version_gate/app_version_gate.dart';

final gate = AppVersionGate(
  source: JsonUrlRequirementsSource(Uri.parse('https://example.com/release.json')),
);

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await gate.check(); // gives up after 5 seconds and fails open
  runApp(const MyApp());
}

// In MyApp:
home: switch (gate.result) {
  VersionGateResult(status: VersionGateStatus.forceUpdate, :final requirements?) =>
    ForceUpdateScreen(
      requirements: requirements,
      strings: const VersionGateStrings(appName: 'Acme'),
    ),
  _ => const HomePage(),
},
```

Once the user is somewhere a dialog won't get in the way (signed in, not mid-onboarding):

```dart
await showUpdateAvailableDialogIfNeeded(context, gate,
    strings: const VersionGateStrings(appName: 'Acme'));
```

And to catch a minimum raised while the app sat in the background, since a process the OS keeps alive never runs `main()` again:

```dart
final observer = AppVersionGateObserver(gate, onForceUpdate: (requirements) {
  navigatorKey.currentState?.pushAndRemoveUntil(
    MaterialPageRoute(builder: (_) => ForceUpdateScreen(requirements: requirements)),
    (_) => false,
  );
})..attach();
```

## The requirements

One record per platform:

| Field | Meaning |
|---|---|
| `min_supported_build` | Builds below this must update. `0` = off. |
| `latest_build` | Builds below this are offered an update, once per value. `0` = off. |
| `store_url` | Where the button goes. Null hides it. A TestFlight `itms-beta://` link works and falls back to https. |
| `message` | Optional text for the force-update screen. |

**Build numbers are per platform**: the `+42` in `1.0.0+42`, which is `versionCode` on Android and `CFBundleVersion` on iOS. They're never compared across platforms, because your Android and iOS CI usually count separately.

**Never raise `min_supported_build` above the build live in the public store.** If you do, users are stuck on a screen whose only button leads to a store with nothing newer to download.

## Sources

| Source | Use |
|---|---|
| `SupabaseRequirementsSource` | A Postgres table, from [app_version_gate_supabase](https://pub.dev/packages/app_version_gate_supabase). The migration is [in the repo](https://github.com/BrianLandes/app-version-gate/tree/main/supabase/migrations). |
| `JsonUrlRequirementsSource` | A static JSON file: `{"android": {...}, "ios": {...}}`. No backend needed. |
| `StaticRequirementsSource` | Fixed values, for tests and previews. |
| Your own | Implement `ReleaseRequirementsSource.fetch(platform)`. Throw on failure; the gate fails open. |

## Behavior worth knowing

- **Off in debug builds and on the web** by default. A local debug run usually reports build 1 and would gate itself the moment you set a minimum. Pass `enabled:` to override, or `debugOverride:` to preview a screen.
- **Rechecks on resume at most every 15 minutes** (`resumeRecheckInterval`). A recheck can only *escalate* to force-update. A failed fetch on resume never drops a prompt the startup check found.
- **The prompt shows once per `latest_build`.** It's remembered in shared_preferences under `promptedBuildKey`.
- **The force screen uses the store link on both platforms**, not Play's immediate-update flow, so sideloaded and test builds are gated the same as store installs.
- **Store links fall back to the in-app browser** when no app takes them. In production, one user's TestFlight link failed ten taps in a row on the only button off the force-update screen.
- **Deep links and push notifications:** use `UpdatePromptScheduler` to hold the prompt until a notification or link has finished navigating. Otherwise it lands on top of the screen the user came for.

## Customizing

- `VersionGateStrings` holds every word on both screens; pass `appName` for the defaults, or override each one.
- `illustration:` adds your artwork. Both screens otherwise follow your `Theme`.
- `builder:` replaces either screen's content while keeping its behavior.
- `onError:` reports every recovered failure with a `task` and an `expected` flag (an offline cold start is expected), so your logger can file routine ones as info.

## License

MIT
