import 'dart:convert';

import 'package:app_version_gate/app_version_gate.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  group('ReleaseRequirements.fromJson', () {
    test('coerces numbers that arrive as strings or doubles', () {
      final r = ReleaseRequirements.fromJson({
        'platform': 'ios',
        'min_supported_build': '12',
        'latest_build': 30.0,
      });
      expect(r.minSupportedBuild, 12);
      expect(r.latestBuild, 30);
    });

    test('a missing or unreadable number turns that gate off', () {
      final r = ReleaseRequirements.fromJson(
          {'platform': 'ios', 'min_supported_build': 'soon'});
      expect(r.minSupportedBuild, 0);
      expect(r.latestBuild, 0);
    });

    test('a blank store URL or message is null', () {
      final r = ReleaseRequirements.fromJson(
          {'platform': 'ios', 'store_url': ' ', 'message': ''});
      expect(r.storeUrl, isNull);
      expect(r.message, isNull);
    });
  });

  group('JsonUrlRequirementsSource', () {
    final url = Uri.parse('https://example.com/release.json');

    JsonUrlRequirementsSource source(Object body,
            {int status = 200, List<Uri>? seen}) =>
        JsonUrlRequirementsSource(
          url,
          client: MockClient((request) async {
            seen?.add(request.url);
            return http.Response(jsonEncode(body), status);
          }),
        );

    test('reads a document keyed by platform', () async {
      final r = await source({
        'android': {
          'min_supported_build': 5,
          'latest_build': 9,
          'store_url': 'https://play.example'
        },
        'ios': {'latest_build': 3},
      }).fetch('android');
      expect(r?.platform, 'android');
      expect(r?.minSupportedBuild, 5);
      expect(r?.storeUrl, 'https://play.example');
    });

    test('reads a list of rows', () async {
      final r = await source([
        {'platform': 'android', 'latest_build': 9},
        {'platform': 'ios', 'latest_build': 3},
      ]).fetch('ios');
      expect(r?.latestBuild, 3);
    });

    test('a platform missing from the document is null', () async {
      expect(await source({'android': {}}).fetch('ios'), isNull);
    });

    test('an HTTP error throws, for the gate to fail open on', () async {
      expect(source({}, status: 503).fetch('ios'),
          throwsA(isA<http.ClientException>()));
    });

    test('busts caches so a raised minimum lands immediately', () async {
      final seen = <Uri>[];
      await source({}, seen: seen).fetch('ios');
      expect(seen.single.queryParameters, contains('_'));
    });
  });
}
