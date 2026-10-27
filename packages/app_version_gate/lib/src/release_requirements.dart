/// One platform's release requirements.
///
/// Build numbers are compared per platform and never across platforms: an
/// Android build and an iOS build usually come from separate CI counters, so
/// Android build 47 and iOS build 47 are unrelated artifacts. That is why the
/// minimum is a per-platform build number rather than a single semver.
///
/// A build below [minSupportedBuild] is blocked by the force-update screen. A
/// build below [latestBuild] gets a dismissible prompt. `0` turns either gate
/// off.
class ReleaseRequirements {
  const ReleaseRequirements({
    required this.platform,
    this.minSupportedBuild = 0,
    this.latestBuild = 0,
    this.storeUrl,
    this.message,
  });

  /// `android` or `ios`.
  final String platform;

  /// Builds below this must update. `0` disables the force gate.
  final int minSupportedBuild;

  /// Builds below this are offered an update. `0` disables the prompt.
  final int latestBuild;

  /// Where the update button sends the user. Null hides the button, e.g. on
  /// iOS before the App Store listing exists.
  final String? storeUrl;

  /// An optional explanation shown on the force-update screen, for when a
  /// minimum was raised for a reason worth telling users.
  final String? message;

  /// Reads a row shaped like the `app_release_requirements` table. Numbers may
  /// arrive as strings or doubles (JSON files, Remote Config) and are coerced;
  /// a missing or unreadable number means `0`, which turns that gate off.
  factory ReleaseRequirements.fromJson(Map<String, dynamic> json) =>
      ReleaseRequirements(
        platform: json['platform']?.toString() ?? '',
        minSupportedBuild: _int(json['min_supported_build']),
        latestBuild: _int(json['latest_build']),
        storeUrl: _string(json['store_url']),
        message: _string(json['message']),
      );

  Map<String, dynamic> toJson() => {
        'platform': platform,
        'min_supported_build': minSupportedBuild,
        'latest_build': latestBuild,
        'store_url': storeUrl,
        'message': message,
      };

  @override
  String toString() =>
      'ReleaseRequirements($platform, min: $minSupportedBuild, latest: $latestBuild)';
}

int _int(Object? value) => switch (value) {
      int v => v,
      num v => v.toInt(),
      String v => int.tryParse(v.trim()) ?? 0,
      _ => 0,
    };

String? _string(Object? value) {
  final s = value?.toString().trim();
  return (s == null || s.isEmpty) ? null : s;
}
