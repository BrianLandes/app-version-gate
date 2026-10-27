// Unit tests for openStoreUrl: the store link on the update screens falls back
// to the in-app browser when no external app takes it.
//
// In production, an iOS user on the blocking update screen got
// `launchUrl returned false` for the TestFlight link ten times running, with no
// other way off the screen.

import 'package:flutter_test/flutter_test.dart';
import 'package:app_version_gate/app_version_gate.dart';
import 'package:url_launcher/url_launcher.dart';

final _uri = Uri.parse('https://testflight.apple.com/join/example');

/// A launcher that answers each mode from [results] and records the order.
({List<LaunchMode> tried, StoreUrlLauncher launch}) _launcher(
  Map<LaunchMode, Object> results,
) {
  final tried = <LaunchMode>[];
  Future<bool> launch(Uri uri, LaunchMode mode) async {
    tried.add(mode);
    final r = results[mode];
    if (r is bool) return r;
    throw r!;
  }

  return (tried: tried, launch: launch);
}

void main() {
  test('opens externally when it can, without trying the fallback', () async {
    final l = _launcher({LaunchMode.externalApplication: true});
    Object? reported = 'untouched';

    expect(
      await openStoreUrl(_uri,
          launch: l.launch, onExternalFailed: (e) => reported = e),
      isTrue,
    );
    expect(l.tried, [LaunchMode.externalApplication]);
    expect(reported, 'untouched');
  });

  test(
      'falls back to the in-app browser when the external launch returns false',
      () async {
    final l = _launcher({
      LaunchMode.externalApplication: false,
      LaunchMode.inAppBrowserView: true,
    });
    var failures = 0;
    Object? reported = 'untouched';

    expect(
      await openStoreUrl(_uri, launch: l.launch, onExternalFailed: (e) {
        failures++;
        reported = e;
      }),
      isTrue,
    );
    expect(
        l.tried, [LaunchMode.externalApplication, LaunchMode.inAppBrowserView]);
    expect(failures, 1);
    expect(reported, isNull);
  });

  test('falls back when the external launch throws, and reports the error',
      () async {
    final boom = Exception('no handler');
    final l = _launcher({
      LaunchMode.externalApplication: boom,
      LaunchMode.inAppBrowserView: true,
    });
    Object? reported;

    expect(
      await openStoreUrl(_uri,
          launch: l.launch, onExternalFailed: (e) => reported = e),
      isTrue,
    );
    expect(reported, same(boom));
  });

  test('reports failure when neither launch opens the link', () async {
    final l = _launcher({
      LaunchMode.externalApplication: false,
      LaunchMode.inAppBrowserView: false,
    });
    expect(await openStoreUrl(_uri, launch: l.launch), isFalse);
  });

  test("the fallback's own error propagates to the caller", () async {
    final l = _launcher({
      LaunchMode.externalApplication: false,
      LaunchMode.inAppBrowserView: StateError('no browser'),
    });
    await expectLater(openStoreUrl(_uri, launch: l.launch), throwsStateError);
  });

  test(
    'a TestFlight-scheme link falls back to the same join page over https',
    () async {
      final opened = <Uri>[];
      Future<bool> launch(Uri uri, LaunchMode mode) async {
        opened.add(uri);
        return mode == LaunchMode.inAppBrowserView;
      }

      expect(
        await openStoreUrl(
          Uri.parse('itms-beta://testflight.apple.com/join/example'),
          launch: launch,
        ),
        isTrue,
      );
      expect(opened.last, _uri);
    },
  );

  test(
    'a link with no web equivalent reports failure instead of throwing',
    () async {
      final l = _launcher({LaunchMode.externalApplication: false});

      expect(
        await openStoreUrl(
          Uri.parse('market://details?id=x'),
          launch: l.launch,
        ),
        isFalse,
      );
      expect(l.tried, [LaunchMode.externalApplication]);
    },
  );
}
