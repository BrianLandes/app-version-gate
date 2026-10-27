import 'dart:convert';
import 'dart:io';

import 'package:app_version_gate/app_version_gate.dart';
import 'package:app_version_gate_supabase/app_version_gate_supabase.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:supabase/supabase.dart';

SupabaseClient _client(http.Response Function(http.Request) handler,
        {List<http.Request>? seen}) =>
    SupabaseClient(
      'https://project.supabase.co',
      'anon-key',
      httpClient: MockClient((request) async {
        seen?.add(request);
        final r = handler(request);
        // postgrest reads the request back off the response.
        return http.Response(r.body, r.statusCode,
            headers: r.headers, request: request);
      }),
    );

void main() {
  test('reads one platform row, naming its columns', () async {
    final seen = <http.Request>[];
    final source = SupabaseRequirementsSource(_client(
      (_) => http.Response(
        jsonEncode({
          'platform': 'android',
          'min_supported_build': 313,
          'latest_build': 320,
          'store_url':
              'https://play.google.com/store/apps/details?id=com.example',
          'message': null,
        }),
        200,
        headers: {'content-type': 'application/json'},
      ),
      seen: seen,
    ));

    final r = await source.fetch('android');

    expect(r?.minSupportedBuild, 313);
    expect(r?.latestBuild, 320);
    final url = seen.single.url;
    expect(url.path, '/rest/v1/app_release_requirements');
    expect(url.queryParameters['platform'], 'eq.android');
    expect(url.queryParameters['select']?.replaceAll(' ', ''),
        'platform,min_supported_build,latest_build,store_url,message');
  });

  test('reads from a custom table', () async {
    final seen = <http.Request>[];
    await SupabaseRequirementsSource(
      _client(
          (_) => http.Response('null', 200,
              headers: {'content-type': 'application/json'}),
          seen: seen),
      table: 'release_gates',
    ).fetch('ios');
    expect(seen.single.url.path, '/rest/v1/release_gates');
  });

  test('no row means no requirements', () async {
    final source = SupabaseRequirementsSource(
      _client((_) => http.Response('', 406,
          headers: {'content-type': 'application/json'})),
    );
    // maybeSingle maps PostgREST's "no rows" to null.
    expect(await source.fetch('ios').catchError((_) => null), isNull);
  });

  test('an error throws, so the gate fails open', () async {
    final gate = AppVersionGate(
      source: SupabaseRequirementsSource(_client((_) => http.Response(
            jsonEncode({'message': 'permission denied', 'code': '42501'}),
            401,
            headers: {'content-type': 'application/json'},
          ))),
      enabled: true,
      currentBuild: () async => 1,
      platform: () => 'android',
    );
    expect((await gate.check()).status, VersionGateStatus.upToDate);
  });

  // Against a real Supabase stack with the migration applied:
  //   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_ANON_KEY=... flutter test
  final url = Platform.environment['SUPABASE_URL'];
  final key = Platform.environment['SUPABASE_ANON_KEY'];
  test('anon can read the table on a real stack', () async {
    final r = await SupabaseRequirementsSource(SupabaseClient(url!, key!))
        .fetch('android');
    expect(r?.platform, 'android');
  },
      skip: url == null || key == null
          ? 'SUPABASE_URL / SUPABASE_ANON_KEY not set'
          : false);
}
