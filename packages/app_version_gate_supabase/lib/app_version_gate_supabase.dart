/// Reads app_version_gate's release requirements from a Supabase table.
library;

import 'package:app_version_gate/app_version_gate.dart';
import 'package:supabase/supabase.dart';

/// Reads one row per platform from [table], which must be readable by the
/// roles your app uses before sign-in (the gate runs before login). The
/// migration in this package's repository creates it with that policy.
///
/// ```dart
/// final gate = AppVersionGate(
///   source: SupabaseRequirementsSource(Supabase.instance.client),
/// );
/// ```
class SupabaseRequirementsSource implements ReleaseRequirementsSource {
  SupabaseRequirementsSource(this.client,
      {this.table = 'app_release_requirements'});

  final SupabaseClient client;
  final String table;

  /// The columns read. Named, never `*`: a later column grant can't break a
  /// build that's already shipped.
  static const columns =
      'platform, min_supported_build, latest_build, store_url, message';

  @override
  Future<ReleaseRequirements?> fetch(String platform) async {
    final row = await client
        .from(table)
        .select(columns)
        .eq('platform', platform)
        .maybeSingle();
    return row == null ? null : ReleaseRequirements.fromJson(row);
  }
}
