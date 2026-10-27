/// The words on the update screens. Override any of them, or translate them
/// all.
class VersionGateStrings {
  const VersionGateStrings({
    this.appName = 'this app',
    String? forceTitle,
    String? forceMessage,
    String? updateButton,
    String? optionalTitle,
    String? optionalMessage,
    String? downloadButton,
    String? laterButton,
    String? downloaded,
    String? installNow,
    String? storeOpenFailed,
  })  : _forceTitle = forceTitle,
        _forceMessage = forceMessage,
        _updateButton = updateButton,
        _optionalTitle = optionalTitle,
        _optionalMessage = optionalMessage,
        _downloadButton = downloadButton,
        _laterButton = laterButton,
        _downloaded = downloaded,
        _installNow = installNow,
        _storeOpenFailed = storeOpenFailed;

  /// Used in the default messages, e.g. "This version of Acme is no longer
  /// supported."
  final String appName;

  final String? _forceTitle;
  final String? _forceMessage;
  final String? _updateButton;
  final String? _optionalTitle;
  final String? _optionalMessage;
  final String? _downloadButton;
  final String? _laterButton;
  final String? _downloaded;
  final String? _installNow;
  final String? _storeOpenFailed;

  String get forceTitle => _forceTitle ?? 'Time for an update';

  /// Shown on the force-update screen when the requirements carry no
  /// `message` of their own.
  String get forceMessage =>
      _forceMessage ??
      'This version of $appName is no longer supported. Please update to keep going.';

  String get updateButton => _updateButton ?? 'Update now';
  String get optionalTitle => _optionalTitle ?? 'A new version is ready';
  String get optionalMessage =>
      _optionalMessage ??
      'A newer version of $appName is available with the latest fixes and features.';

  /// The prompt's button on Android, where it starts a Play in-app download.
  String get downloadButton => _downloadButton ?? 'Download update';
  String get laterButton => _laterButton ?? 'Maybe later';
  String get downloaded => _downloaded ?? 'Update downloaded.';
  String get installNow => _installNow ?? 'Install now';
  String get storeOpenFailed =>
      _storeOpenFailed ??
      "Couldn't open the store. Please update $appName from your app store.";
}
