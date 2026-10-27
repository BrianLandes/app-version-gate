import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'release_requirements.dart';
import 'requirements_source.dart';

/// What the gate decided about this build.
enum VersionGateStatus {
  /// Current, or the gate is off or couldn't tell. Proceed normally.
  upToDate,

  /// A newer build exists. Offer the dismissible prompt.
  optionalUpdate,

  /// Below the supported minimum. Show the blocking update screen.
  forceUpdate,
}

class VersionGateResult {
  const VersionGateResult(this.status, [this.requirements]);

  final VersionGateStatus status;

  /// The requirements the decision was made against. Null when the gate
  /// didn't run or failed open.
  final ReleaseRequirements? requirements;

  static const upToDate = VersionGateResult(VersionGateStatus.upToDate);

  @override
  String toString() => 'VersionGateResult(${status.name}, $requirements)';
}

/// Reports a failure the gate recovered from. [expected] is true for routine
/// ones, such as an offline cold start, so a logger can file them as info
/// rather than errors.
typedef VersionGateErrorHandler = void Function(
  Object error,
  StackTrace stackTrace, {
  required String task,
  required bool expected,
});

/// Compares [currentBuild] against [requirements].
///
/// Fails open: an unparseable build number or missing requirements mean
/// "up to date". The gate must never brick an install because of bad data.
VersionGateStatus evaluateVersionGate({
  required int? currentBuild,
  required ReleaseRequirements? requirements,
}) {
  if (currentBuild == null || requirements == null) {
    return VersionGateStatus.upToDate;
  }
  if (requirements.minSupportedBuild > 0 &&
      currentBuild < requirements.minSupportedBuild) {
    return VersionGateStatus.forceUpdate;
  }
  if (requirements.latestBuild > 0 && currentBuild < requirements.latestBuild) {
    return VersionGateStatus.optionalUpdate;
  }
  return VersionGateStatus.upToDate;
}

/// Decides whether this build may run, should be offered an update, or is
/// fine.
///
/// Call [check] once in `main()` before `runApp()`, then read [result]
/// synchronously when building the first screen. Call [recheckOnResume] when
/// the app returns to the foreground (or use `AppVersionGateObserver`): a
/// process the OS keeps alive never runs `main()` again, so without it a
/// raised minimum can take days to reach a phone that never closes the app.
///
/// Every failure (no network, backend outage, a malformed row, a timeout)
/// fails **open**. This class must never be the reason a healthy install
/// can't start.
class AppVersionGate {
  AppVersionGate({
    required ReleaseRequirementsSource source,
    bool? enabled,
    Future<int?> Function()? currentBuild,
    String? Function()? platform,
    this.fetchTimeout = const Duration(seconds: 5),
    this.resumeRecheckInterval = const Duration(minutes: 15),
    this.promptedBuildKey = 'app_version_gate.prompted_build',
    this.onError,
    this.log,
    this.debugOverride,
  })  : _source = source,
        // A debug run reports whatever build number the local pubspec has,
        // usually 1, and would gate itself the moment a minimum is set.
        enabled = enabled ?? (!kDebugMode && !kIsWeb),
        _currentBuild = currentBuild ?? _packageInfoBuild,
        _platform = platform ?? _defaultPlatform;

  final ReleaseRequirementsSource _source;
  final Future<int?> Function() _currentBuild;
  final String? Function() _platform;

  /// When false, [check] and [recheckOnResume] decide "up to date" without
  /// fetching. Defaults to off in debug builds and on the web.
  final bool enabled;

  /// How long to wait for the source before failing open.
  final Duration fetchTimeout;

  /// The minimum time between checks on resume. Resumes are frequent (every
  /// return from a share sheet or a permission dialog), so a raised minimum
  /// can take this long to land.
  final Duration resumeRecheckInterval;

  /// The shared_preferences key that remembers which `latest_build` the user
  /// was last prompted about, so the prompt shows once per new build.
  final String promptedBuildKey;

  final VersionGateErrorHandler? onError;

  /// Receives one line per decision, for your debug log.
  final void Function(String message)? log;

  /// Skips the fetch and reports this result instead, even in debug builds.
  /// For previewing the update UI. Wire it to a `--dart-define` if you like.
  final VersionGateResult? debugOverride;

  @visibleForTesting
  DateTime Function() now = DateTime.now;

  VersionGateResult _result = VersionGateResult.upToDate;
  DateTime? _checkedAt;

  /// The latest decision. Up to date until [check] says otherwise.
  VersionGateResult get result => _result;

  /// Runs the gate. Safe to await before `runApp()`: it gives up after
  /// [fetchTimeout] and fails open.
  Future<VersionGateResult> check() async {
    _checkedAt = now();
    final override = debugOverride;
    if (override != null) {
      log?.call('Debug override → ${override.status.name}');
      return _result = override;
    }
    final fresh = await evaluate();
    if (fresh != null) _result = fresh;
    return _result;
  }

  /// Runs the gate again on resume, at most once per [resumeRecheckInterval].
  ///
  /// It can only escalate to [VersionGateStatus.forceUpdate]. Any other
  /// outcome, including a failed fetch, keeps the startup result, so a flaky
  /// network on resume never drops a pending prompt. Returns true when this
  /// call moved the build to force-update: show the blocking screen now.
  Future<bool> recheckOnResume() async {
    if (debugOverride != null) return false;
    if (_result.status == VersionGateStatus.forceUpdate) return false;
    final last = _checkedAt;
    if (last != null && now().difference(last) < resumeRecheckInterval) {
      return false;
    }
    _checkedAt = now();
    final fresh = await evaluate();
    if (fresh == null ||
        fresh.status != VersionGateStatus.forceUpdate ||
        fresh.requirements == null) {
      return false;
    }
    _result = fresh;
    return true;
  }

  /// Fetches and evaluates this install's build, or returns null when the
  /// gate doesn't apply here (disabled, or a platform without a store).
  @visibleForTesting
  Future<VersionGateResult?> evaluate() async {
    if (!enabled) {
      log?.call('Skipped (disabled)');
      return null;
    }
    final platform = _platform();
    if (platform == null) return null;

    int? build;
    try {
      build = await _currentBuild();
    } catch (e, st) {
      onError?.call(e, st, task: 'currentBuild', expected: false);
      return VersionGateResult.upToDate;
    }

    ReleaseRequirements? requirements;
    try {
      requirements = await _source.fetch(platform).timeout(fetchTimeout);
    } catch (e, st) {
      // Offline cold starts land here routinely: a log line, not a crash.
      onError?.call(e, st, task: 'fetch', expected: true);
      log?.call('Fetch failed, failing open: $e');
      return VersionGateResult.upToDate;
    }
    final status = evaluateVersionGate(
      currentBuild: build,
      requirements: requirements,
    );
    log?.call('Build $build ($platform) → ${status.name}');
    return VersionGateResult(status, requirements);
  }

  /// True when the optional prompt should show: there is an optional update,
  /// and the user hasn't been prompted about this `latest_build` yet.
  Future<bool> shouldShowOptionalPrompt() async {
    if (_result.status != VersionGateStatus.optionalUpdate) return false;
    final latest = _result.requirements?.latestBuild ?? 0;
    if (latest <= 0) return false;
    final prefs = await SharedPreferences.getInstance();
    return latest > (prefs.getInt(promptedBuildKey) ?? 0);
  }

  /// Records that the user has seen the prompt for the current `latest_build`.
  Future<void> markOptionalPromptShown() async {
    final latest = _result.requirements?.latestBuild ?? 0;
    if (latest <= 0) return;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setInt(promptedBuildKey, latest);
  }

  @visibleForTesting
  void setResultForTesting(VersionGateResult result) => _result = result;
}

Future<int?> _packageInfoBuild() async =>
    int.tryParse((await PackageInfo.fromPlatform()).buildNumber);

String? _defaultPlatform() {
  if (kIsWeb) return null;
  return switch (defaultTargetPlatform) {
    TargetPlatform.android => 'android',
    TargetPlatform.iOS => 'ios',
    _ => null,
  };
}
