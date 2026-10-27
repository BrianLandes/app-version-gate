import 'package:app_version_gate/app_version_gate.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

const _req = ReleaseRequirements(
  platform: 'android',
  minSupportedBuild: 40,
  latestBuild: 45,
  storeUrl: 'https://play.google.com/store/apps/details?id=com.example',
);

class _FakeUpdater implements FlexibleUpdater {
  _FakeUpdater({this.available = true, this.throws = false});
  final bool available;
  final bool throws;
  int downloads = 0;

  @override
  Future<bool> isAvailable() async {
    if (throws) throw Exception('ERROR_APP_NOT_OWNED');
    return available;
  }

  @override
  Future<void> download() async => downloads++;

  @override
  Future<void> complete() async {}
}

Widget _app(Widget home) => MaterialApp(home: home);

void main() {
  group('ForceUpdateScreen', () {
    testWidgets('shows the operator message over the default copy',
        (tester) async {
      await tester.pumpWidget(_app(const ForceUpdateScreen(
        requirements: ReleaseRequirements(
            platform: 'ios', minSupportedBuild: 9, message: 'Data fix inside.'),
        strings: VersionGateStrings(appName: 'Acme'),
      )));
      expect(find.text('Data fix inside.'), findsOneWidget);
      expect(find.textContaining('Acme'), findsNothing);
    });

    testWidgets('falls back to the default message, naming the app',
        (tester) async {
      await tester.pumpWidget(_app(const ForceUpdateScreen(
        requirements: _req,
        strings: VersionGateStrings(appName: 'Acme'),
      )));
      expect(find.textContaining('This version of Acme'), findsOneWidget);
    });

    testWidgets('hides the button when there is no store URL', (tester) async {
      await tester.pumpWidget(_app(const ForceUpdateScreen(
        requirements:
            ReleaseRequirements(platform: 'ios', minSupportedBuild: 9),
      )));
      expect(find.byType(FilledButton), findsNothing);
    });

    testWidgets('cannot be popped', (tester) async {
      await tester
          .pumpWidget(_app(const ForceUpdateScreen(requirements: _req)));
      final popScope = tester.widget<PopScope>(find.byType(PopScope));
      expect(popScope.canPop, isFalse);
    });

    testWidgets('opens the store, and says so when it cannot', (tester) async {
      final tried = <LaunchMode>[];
      final errors = <String>[];
      await tester.pumpWidget(_app(ForceUpdateScreen(
        requirements: _req,
        launch: (uri, mode) async {
          tried.add(mode);
          return false;
        },
        onError: (e, st, {required task, required expected}) =>
            errors.add(task),
      )));
      await tester.tap(find.byType(FilledButton));
      await tester.pumpAndSettle();

      expect(
          tried, [LaunchMode.externalApplication, LaunchMode.inAppBrowserView]);
      expect(errors, ['openStore.external', 'openStore']);
      expect(find.textContaining("Couldn't open the store"), findsOneWidget);
    });

    testWidgets('a custom builder keeps the store action', (tester) async {
      Uri? opened;
      await tester.pumpWidget(_app(ForceUpdateScreen(
        requirements: _req,
        launch: (uri, mode) async {
          opened = uri;
          return true;
        },
        builder: (context, req, openStore) =>
            TextButton(onPressed: openStore, child: const Text('Go')),
      )));
      await tester.tap(find.text('Go'));
      await tester.pump();
      expect(opened.toString(), _req.storeUrl);
    });
  });

  group('UpdateAvailableDialog', () {
    Future<void> open(WidgetTester tester, Widget dialog) async {
      await tester.pumpWidget(_app(Builder(
        builder: (context) => Scaffold(
          body: TextButton(
            onPressed: () =>
                showDialog<void>(context: context, builder: (_) => dialog),
            child: const Text('open'),
          ),
        ),
      )));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
    }

    testWidgets('downloads through Play when Play has the update',
        (tester) async {
      final updater = _FakeUpdater();
      var storeOpened = false;
      await open(
          tester,
          UpdateAvailableDialog(
            requirements: _req,
            flexibleUpdater: updater,
            launch: (uri, mode) async => storeOpened = true,
          ));
      await tester.tap(find.text('Download update'));
      await tester.pumpAndSettle();

      expect(updater.downloads, 1);
      expect(storeOpened, isFalse);
      expect(find.byType(UpdateAvailableDialog), findsNothing);
      expect(find.text('Update downloaded.'), findsOneWidget);
    });

    testWidgets('falls back to the store when Play has nothing',
        (tester) async {
      Uri? opened;
      await open(
          tester,
          UpdateAvailableDialog(
            requirements: _req,
            flexibleUpdater: _FakeUpdater(available: false),
            launch: (uri, mode) async {
              opened = uri;
              return true;
            },
          ));
      await tester.tap(find.text('Download update'));
      await tester.pumpAndSettle();
      expect(opened.toString(), _req.storeUrl);
      expect(find.byType(UpdateAvailableDialog), findsNothing);
    });

    testWidgets(
        'a sideloaded build (Play throws) falls back too, reported as expected',
        (tester) async {
      final reported = <(String, bool)>[];
      Uri? opened;
      await open(
          tester,
          UpdateAvailableDialog(
            requirements: _req,
            flexibleUpdater: _FakeUpdater(throws: true),
            onError: (e, st, {required task, required expected}) =>
                reported.add((task, expected)),
            launch: (uri, mode) async {
              opened = uri;
              return true;
            },
          ));
      await tester.tap(find.text('Download update'));
      await tester.pumpAndSettle();
      expect(reported, [('flexibleUpdate', true)]);
      expect(opened, isNotNull);
    });

    testWidgets('without a Play updater the button says update, not download',
        (tester) async {
      await open(tester, const UpdateAvailableDialog(requirements: _req));
      expect(find.text('Update now'), findsOneWidget);
      await tester.tap(find.text('Maybe later'));
      await tester.pumpAndSettle();
      expect(find.byType(UpdateAvailableDialog), findsNothing);
    });
  });

  group('showUpdateAvailableDialogIfNeeded', () {
    setUp(() {
      SharedPreferences.setMockInitialValues({});
      resetUpdateDialogForTesting();
    });

    testWidgets('shows once per latest build', (tester) async {
      final gate = AppVersionGate(source: const StaticRequirementsSource({}))
        ..setResultForTesting(
            const VersionGateResult(VersionGateStatus.optionalUpdate, _req));
      late BuildContext ctx;
      await tester.pumpWidget(_app(Builder(builder: (c) {
        ctx = c;
        return const SizedBox();
      })));

      final first = showUpdateAvailableDialogIfNeeded(ctx, gate,
          flexibleUpdater: _FakeUpdater());
      await tester.pumpAndSettle();
      expect(find.byType(UpdateAvailableDialog), findsOneWidget);
      await tester.tap(find.text('Maybe later'));
      await tester.pumpAndSettle();
      expect(await first, isTrue);

      expect(await showUpdateAvailableDialogIfNeeded(ctx, gate), isFalse);
    });
  });
}
