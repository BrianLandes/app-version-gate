import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:app_version_gate/app_version_gate.dart';

void main() {
  test('normal launch keeps the short startup delay', () {
    fakeAsync((async) {
      var shown = 0;
      final scheduler = UpdatePromptScheduler(
        normalDelay: const Duration(seconds: 1),
        externalLaunchIdleDelay: const Duration(seconds: 4),
        onReady: () async => shown++,
      );

      scheduler.schedule(externalLaunch: false);
      async.elapse(const Duration(milliseconds: 999));
      expect(shown, 0);
      async.elapse(const Duration(milliseconds: 1));
      expect(shown, 1);
    });
  });

  test('external launch waits for a full inactivity window', () {
    fakeAsync((async) {
      var shown = 0;
      final scheduler = UpdatePromptScheduler(
        normalDelay: const Duration(seconds: 1),
        externalLaunchIdleDelay: const Duration(seconds: 4),
        onReady: () async => shown++,
      );

      scheduler.schedule(externalLaunch: true);
      async.elapse(const Duration(seconds: 3));
      scheduler.noteActivity();
      async.elapse(const Duration(seconds: 3));
      expect(shown, 0);
      async.elapse(const Duration(seconds: 1));
      expect(shown, 1);
    });
  });

  test('external navigation detected before scheduling is retained', () {
    fakeAsync((async) {
      var shown = 0;
      final scheduler = UpdatePromptScheduler(
        normalDelay: const Duration(seconds: 1),
        externalLaunchIdleDelay: const Duration(seconds: 4),
        onReady: () async => shown++,
      );

      scheduler.noteExternalNavigation();
      scheduler.schedule(externalLaunch: false);
      async.elapse(const Duration(seconds: 1));
      expect(shown, 0);
      async.elapse(const Duration(seconds: 3));
      expect(shown, 1);
    });
  });

  test('backgrounding pauses and resume restarts the delay', () {
    fakeAsync((async) {
      var shown = 0;
      final scheduler = UpdatePromptScheduler(
        normalDelay: const Duration(seconds: 1),
        externalLaunchIdleDelay: const Duration(seconds: 4),
        onReady: () async => shown++,
      );

      scheduler.schedule(externalLaunch: true);
      async.elapse(const Duration(seconds: 2));
      scheduler.setForeground(false);
      async.elapse(const Duration(seconds: 10));
      expect(shown, 0);

      scheduler.setForeground(true);
      async.elapse(const Duration(seconds: 3));
      expect(shown, 0);
      async.elapse(const Duration(seconds: 1));
      expect(shown, 1);
    });
  });
}
