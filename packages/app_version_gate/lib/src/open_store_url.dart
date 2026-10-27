import 'package:url_launcher/url_launcher.dart';

/// Opens [uri] the way [launchUrl] does. Injectable so tests can stand in for
/// the platform.
typedef StoreUrlLauncher = Future<bool> Function(Uri uri, LaunchMode mode);

/// The real launcher, via url_launcher.
Future<bool> platformLaunch(Uri uri, LaunchMode mode) =>
    launchUrl(uri, mode: mode);

/// Opens a store or TestFlight link, falling back to the in-app browser when
/// no external app will take it.
///
/// In production, an iOS user on the blocking update screen tapped "Update
/// Now" ten times in two minutes and got `launchUrl returned false` for the
/// TestFlight link every time: stuck on a screen whose only way out is that
/// button. The external launch is still tried first, because it lands in the
/// store or TestFlight app, which is the best outcome. The in-app browser means
/// the user at least sees the page and can follow it from there.
///
/// The store URL may be TestFlight's own `itms-beta://` scheme, which opens the
/// TestFlight app directly (the "View in TestFlight" button on a join page uses
/// it). The in-app browser only takes http(s), so the fallback opens the same
/// join page over https instead.
///
/// [onExternalFailed] receives why the external launch failed (null when it
/// simply returned false), so callers can log it; the fallback may still
/// succeed. Returns whether either attempt opened the link. Only the fallback's
/// error propagates.
Future<bool> openStoreUrl(
  Uri uri, {
  StoreUrlLauncher launch = platformLaunch,
  void Function(Object? error)? onExternalFailed,
}) async {
  try {
    if (await launch(uri, LaunchMode.externalApplication)) return true;
    onExternalFailed?.call(null);
  } catch (e) {
    onExternalFailed?.call(e);
  }
  final web = _webEquivalent(uri);
  if (web == null) return false;
  return launch(web, LaunchMode.inAppBrowserView);
}

Uri? _webEquivalent(Uri uri) => switch (uri.scheme) {
      'http' || 'https' => uri,
      'itms-beta' => uri.replace(scheme: 'https'),
      _ => null,
    };
