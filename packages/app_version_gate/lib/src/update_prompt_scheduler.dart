import 'dart:async';

/// Schedules the optional-update prompt without competing with an external
/// navigation that brought the user into the app.
///
/// A prompt that pops up while a push notification or app link is still
/// resolving lands on top of the screen the user came for, or interrupts the
/// route change itself.
///
/// Normal icon launches retain the short startup delay. Push notifications and
/// app links use an inactivity delay that restarts whenever the user interacts
/// or the navigator changes route, allowing resolver pages to reach their real
/// destination before the prompt appears.
class UpdatePromptScheduler {
  UpdatePromptScheduler({
    required Future<void> Function() onReady,
    this.normalDelay = const Duration(milliseconds: 1500),
    this.externalLaunchIdleDelay = const Duration(seconds: 4),
  }) : _onReady = onReady;

  final Future<void> Function() _onReady;
  final Duration normalDelay;
  final Duration externalLaunchIdleDelay;

  Timer? _timer;
  bool _pending = false;
  bool _externalLaunch = false;
  bool _foreground = true;
  bool _disposed = false;

  bool get isPending => _pending;

  /// Begins waiting to show the prompt. Call only after startup has determined
  /// whether a push notification or app link launched the app.
  void schedule({required bool externalLaunch}) {
    if (_disposed) return;
    _pending = true;
    _externalLaunch = _externalLaunch || externalLaunch;
    _armTimer();
  }

  /// Marks an incoming push-notification or app-link navigation. This can run
  /// before [schedule], so a late startup check cannot lose the signal.
  void noteExternalNavigation() {
    if (_disposed) return;
    _externalLaunch = true;
    if (_pending) _armTimer();
  }

  /// Restarts the inactivity window only for an external launch. Regular icon
  /// launches intentionally keep their existing fixed startup delay.
  void noteActivity() {
    if (_disposed || !_pending || !_externalLaunch) return;
    _armTimer();
  }

  /// Prevents a dialog from appearing while the app is backgrounded. The full
  /// delay starts again after the app resumes.
  void setForeground(bool foreground) {
    if (_disposed || _foreground == foreground) return;
    _foreground = foreground;
    if (!foreground) {
      _timer?.cancel();
    } else if (_pending) {
      _armTimer();
    }
  }

  void _armTimer() {
    _timer?.cancel();
    if (!_pending || !_foreground || _disposed) return;
    final delay = _externalLaunch ? externalLaunchIdleDelay : normalDelay;
    _timer = Timer(delay, () {
      if (_disposed || !_pending || !_foreground) return;
      _pending = false;
      unawaited(_onReady());
    });
  }

  void dispose() {
    _disposed = true;
    _pending = false;
    _timer?.cancel();
  }
}
