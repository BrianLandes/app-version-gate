import 'dart:async';

// The gate's decisions: the pure comparison, failing open, the once-per-build
// prompt bookkeeping, and the re-check on resume.

import 'package:app_version_gate/app_version_gate.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

ReleaseRequirements _req({int min = 0, int latest = 0, String? storeUrl}) =>
    ReleaseRequirements(
      platform: 'android',
      minSupportedBuild: min,
      latestBuild: latest,
      storeUrl: storeUrl,
    );

/// A source that answers from a queue (a [ReleaseRequirements], null for "no
/// row", or an error to throw) and counts its calls.
class _QueueSource implements ReleaseRequirementsSource {
  final answers = <Object?>[];
  int calls = 0;

  @override
  Future<ReleaseRequirements?> fetch(String platform) async {
    calls++;
    final answer = answers.isEmpty ? null : answers.removeAt(0);
    if (answer is Exception) throw answer;
    return answer as ReleaseRequirements?;
  }
}

AppVersionGate _gate(
  ReleaseRequirementsSource source, {
  int? build = 10,
  bool enabled = true,
  void Function(String task, bool expected)? onError,
}) =>
    AppVersionGate(
      source: source,
      enabled: enabled,
      currentBuild: () async => build,
      platform: () => 'android',
      onError: onError == null
          ? null
          : (e, st, {required task, required expected}) =>
              onError(task, expected),
    );

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('evaluateVersionGate', () {
    VersionGateStatus eval(int? build, ReleaseRequirements? req) =>
        evaluateVersionGate(currentBuild: build, requirements: req);

    test('a build below the minimum is force-gated', () {
      expect(
          eval(39, _req(min: 40, latest: 45)), VersionGateStatus.forceUpdate);
    });

    test('a build exactly at the minimum is not force-gated', () {
      expect(eval(40, _req(min: 40, latest: 45)),
          VersionGateStatus.optionalUpdate);
    });

    test('a build below latest gets the optional prompt', () {
      expect(eval(44, _req(min: 40, latest: 45)),
          VersionGateStatus.optionalUpdate);
    });

    test('a build at latest is up to date', () {
      expect(eval(45, _req(min: 40, latest: 45)), VersionGateStatus.upToDate);
    });

    test('a build ahead of latest (a local build) is up to date', () {
      expect(eval(999, _req(min: 40, latest: 45)), VersionGateStatus.upToDate);
    });

    test('a minimum of 0 turns the force gate off', () {
      expect(eval(1, _req()), VersionGateStatus.upToDate);
    });

    test('the force gate works with the prompt off (latest 0)', () {
      expect(eval(39, _req(min: 40)), VersionGateStatus.forceUpdate);
    });

    test('an unparseable build number fails open', () {
      expect(eval(int.tryParse('not-a-number'), _req(min: 40, latest: 45)),
          VersionGateStatus.upToDate);
    });

    test('missing requirements fail open', () {
      expect(eval(1, null), VersionGateStatus.upToDate);
    });
  });

  group('check', () {
    test('a throwing source fails open, and reports it as expected', () async {
      final source = _QueueSource()
        ..answers.add(Exception('backend unreachable'));
      final reported = <(String, bool)>[];
      final result =
          await _gate(source, onError: (t, e) => reported.add((t, e))).check();

      expect(result.status, VersionGateStatus.upToDate);
      expect(result.requirements, isNull);
      expect(reported, [('fetch', true)]);
    });

    test('a source that never answers fails open after the timeout', () async {
      final gate = AppVersionGate(
        source: _NeverSource(),
        enabled: true,
        currentBuild: () async => 1,
        platform: () => 'android',
        fetchTimeout: const Duration(milliseconds: 10),
      );
      expect((await gate.check()).status, VersionGateStatus.upToDate);
    });

    test('a stale build is force-gated', () async {
      final source = _QueueSource()..answers.add(_req(min: 40, latest: 45));
      final result = await _gate(source).check();
      expect(result.status, VersionGateStatus.forceUpdate);
      expect(result.requirements?.minSupportedBuild, 40);
    });

    test('a missing row fails open', () async {
      expect((await _gate(_QueueSource()).check()).status,
          VersionGateStatus.upToDate);
    });

    test('when disabled it never fetches', () async {
      final source = _QueueSource()..answers.add(_req(min: 40));
      expect((await _gate(source, enabled: false).check()).status,
          VersionGateStatus.upToDate);
      expect(source.calls, 0);
    });

    test('a platform without a store never fetches', () async {
      final source = _QueueSource()..answers.add(_req(min: 40));
      final gate = AppVersionGate(
        source: source,
        enabled: true,
        currentBuild: () async => 1,
        platform: () => null,
      );
      expect((await gate.check()).status, VersionGateStatus.upToDate);
      expect(source.calls, 0);
    });

    test('a debug override wins without fetching', () async {
      final source = _QueueSource();
      final gate = AppVersionGate(
        source: source,
        debugOverride:
            VersionGateResult(VersionGateStatus.forceUpdate, _req(min: 99)),
      );
      expect((await gate.check()).status, VersionGateStatus.forceUpdate);
      expect(source.calls, 0);
    });
  });

  group('the optional prompt shows once per new build', () {
    late AppVersionGate gate;

    setUp(() {
      SharedPreferences.setMockInitialValues({});
      gate = _gate(_QueueSource());
    });

    test('prompts for a never-seen latest build, then not again', () async {
      gate.setResultForTesting(VersionGateResult(
          VersionGateStatus.optionalUpdate, _req(latest: 45)));
      expect(await gate.shouldShowOptionalPrompt(), isTrue);
      await gate.markOptionalPromptShown();
      expect(await gate.shouldShowOptionalPrompt(), isFalse);
    });

    test('prompts again when a newer latest build appears', () async {
      gate.setResultForTesting(VersionGateResult(
          VersionGateStatus.optionalUpdate, _req(latest: 45)));
      await gate.markOptionalPromptShown();
      gate.setResultForTesting(VersionGateResult(
          VersionGateStatus.optionalUpdate, _req(latest: 46)));
      expect(await gate.shouldShowOptionalPrompt(), isTrue);
    });

    test('never prompts when up to date or force-gated', () async {
      gate.setResultForTesting(
          VersionGateResult(VersionGateStatus.upToDate, _req(latest: 45)));
      expect(await gate.shouldShowOptionalPrompt(), isFalse);
      gate.setResultForTesting(VersionGateResult(
          VersionGateStatus.forceUpdate, _req(min: 50, latest: 55)));
      expect(await gate.shouldShowOptionalPrompt(), isFalse);
    });

    test('remembers under the configured key', () async {
      final custom =
          AppVersionGate(source: _QueueSource(), promptedBuildKey: 'legacy_key')
            ..setResultForTesting(VersionGateResult(
                VersionGateStatus.optionalUpdate, _req(latest: 45)));
      await custom.markOptionalPromptShown();
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getInt('legacy_key'), 45);
    });
  });

  group('recheckOnResume', () {
    late _QueueSource source;
    late AppVersionGate gate;
    late DateTime clock;

    setUp(() async {
      source = _QueueSource()
        ..answers.add(_req(min: 5, latest: 20)); // startup: optional
      gate = _gate(source);
      clock = DateTime(2026, 9, 25, 9);
      gate.now = () => clock;
      await gate.check();
      expect(gate.result.status, VersionGateStatus.optionalUpdate);
    });

    test('a minimum raised while backgrounded force-gates the build', () async {
      clock = clock.add(gate.resumeRecheckInterval);
      source.answers.add(_req(min: 20, latest: 20));

      expect(await gate.recheckOnResume(), isTrue);
      expect(gate.result.status, VersionGateStatus.forceUpdate);
      expect(gate.result.requirements?.minSupportedBuild, 20);
    });

    test('does not re-fetch within the interval', () async {
      clock = clock.add(const Duration(minutes: 14));
      source.answers.add(_req(min: 20));

      expect(await gate.recheckOnResume(), isFalse);
      expect(source.calls, 1, reason: 'only the startup check ran');
    });

    test('a failed re-check keeps the startup result', () async {
      clock = clock.add(const Duration(hours: 1));
      source.answers.add(Exception('offline'));

      expect(await gate.recheckOnResume(), isFalse);
      expect(gate.result.status, VersionGateStatus.optionalUpdate,
          reason: 'a fetch failure must not drop the optional prompt');
    });

    test('once force-gated, resumes do nothing', () async {
      clock = clock.add(const Duration(hours: 1));
      source.answers.add(_req(min: 20));
      await gate.recheckOnResume();

      clock = clock.add(const Duration(hours: 1));
      expect(await gate.recheckOnResume(), isFalse);
      expect(source.calls, 2);
    });
  });
}

class _NeverSource implements ReleaseRequirementsSource {
  @override
  Future<ReleaseRequirements?> fetch(String platform) =>
      Completer<ReleaseRequirements?>().future;
}
