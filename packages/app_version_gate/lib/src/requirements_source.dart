import 'dart:convert';

import 'package:http/http.dart' as http;

import 'release_requirements.dart';

/// Where the gate reads a platform's [ReleaseRequirements] from.
///
/// Implementations may throw on any failure. The gate catches everything and
/// fails open, so a source never needs its own fallback.
abstract interface class ReleaseRequirementsSource {
  /// The requirements for [platform] (`android` or `ios`), or null when there
  /// are none, which leaves the gate off.
  Future<ReleaseRequirements?> fetch(String platform);
}

/// Reads requirements from a JSON document at [url]: a static file on any
/// host (GitHub Pages, S3, your own site), so the gate needs no backend.
///
/// The document maps each platform to its row:
///
/// ```json
/// {
///   "android": { "min_supported_build": 120, "latest_build": 131,
///                "store_url": "https://play.google.com/store/apps/details?id=com.example" },
///   "ios":     { "min_supported_build": 0, "latest_build": 64 }
/// }
/// ```
///
/// A list of rows that each carry a `platform` key works too.
class JsonUrlRequirementsSource implements ReleaseRequirementsSource {
  JsonUrlRequirementsSource(this.url, {http.Client? client}) : _client = client;

  final Uri url;
  final http.Client? _client;

  @override
  Future<ReleaseRequirements?> fetch(String platform) async {
    final client = _client ?? http.Client();
    try {
      // A query parameter keeps CDNs and browsers from serving a stale copy
      // after a minimum is raised.
      final response = await client.get(
        url.replace(queryParameters: {
          ...url.queryParameters,
          '_': DateTime.now().millisecondsSinceEpoch.toString(),
        }),
        headers: const {'Cache-Control': 'no-cache'},
      );
      if (response.statusCode != 200) {
        throw http.ClientException('HTTP ${response.statusCode}', url);
      }
      final body = jsonDecode(response.body);
      final Object? row = switch (body) {
        Map<String, dynamic> m => m[platform],
        List<dynamic> l => l.cast<Object?>().firstWhere(
              (r) => r is Map && r['platform'] == platform,
              orElse: () => null,
            ),
        _ => throw const FormatException('Expected a JSON object or list'),
      };
      if (row is! Map) return null;
      return ReleaseRequirements.fromJson({
        ...row.cast<String, dynamic>(),
        'platform': platform,
      });
    } finally {
      if (_client == null) client.close();
    }
  }
}

/// Fixed requirements. For tests, previews and debug menus.
class StaticRequirementsSource implements ReleaseRequirementsSource {
  const StaticRequirementsSource(this.requirements);

  /// Keyed by platform.
  final Map<String, ReleaseRequirements> requirements;

  @override
  Future<ReleaseRequirements?> fetch(String platform) async =>
      requirements[platform];
}
