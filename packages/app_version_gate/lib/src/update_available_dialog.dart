import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:in_app_update/in_app_update.dart';

import 'open_store_url.dart';
import 'release_requirements.dart';
import 'strings.dart';
import 'version_gate.dart';

/// Play's flexible in-app update, behind an interface so tests and other
/// stores can stand in for it.
abstract interface class FlexibleUpdater {
  /// Whether Play has a flexible update for this install. False for a
  /// sideloaded build Play doesn't know, or a release that isn't live on this
  /// user's track yet.
  Future<bool> isAvailable();

  /// Downloads the update in the background. Completes when it has finished.
  Future<void> download();

  /// Installs a downloaded update and restarts the app.
  Future<void> complete();
}

class PlayFlexibleUpdater implements FlexibleUpdater {
  const PlayFlexibleUpdater();

  @override
  Future<bool> isAvailable() async {
    final info = await InAppUpdate.checkForUpdate();
    return info.updateAvailability == UpdateAvailability.updateAvailable &&
        info.flexibleUpdateAllowed;
  }

  @override
  Future<void> download() => InAppUpdate.startFlexibleUpdate();

  @override
  Future<void> complete() => InAppUpdate.completeFlexibleUpdate();
}

bool _showing = false;

/// Shows the dismissible update prompt if the gate found an optional update
/// and the user hasn't seen one for this `latest_build`. Safe to call on
/// every launch. Returns whether it showed.
///
/// On Android, "update" first tries Play's flexible in-app update: download
/// in the background, then install now or on the next app close. That only
/// works for installs that came from Play with the release live on the
/// user's track, so a sideloaded build, or any Play failure, falls back to
/// the store link, as iOS always does.
///
/// Call it once the user is somewhere a dialog won't get in the way: after
/// sign-in, and not while a deep link is still resolving (see
/// `UpdatePromptScheduler`).
Future<bool> showUpdateAvailableDialogIfNeeded(
  BuildContext context,
  AppVersionGate gate, {
  VersionGateStrings strings = const VersionGateStrings(),
  Widget? illustration,
  VersionGateErrorHandler? onError,
  FlexibleUpdater? flexibleUpdater,
  UpdateDialogBuilder? builder,
}) async {
  if (_showing) return false;
  if (!await gate.shouldShowOptionalPrompt()) return false;
  final requirements = gate.result.requirements;
  if (requirements == null) return false;
  final android = !kIsWeb && defaultTargetPlatform == TargetPlatform.android;
  // Without a store URL, iOS has nothing to offer. Android can still try Play.
  if (!android && requirements.storeUrl == null) return false;

  _showing = true;
  try {
    await gate.markOptionalPromptShown();
    if (!context.mounted) return false;
    await showDialog<void>(
      context: context,
      useRootNavigator: true,
      barrierDismissible: false,
      builder: (_) => UpdateAvailableDialog(
        requirements: requirements,
        strings: strings,
        illustration: illustration,
        onError: onError,
        flexibleUpdater:
            android ? (flexibleUpdater ?? const PlayFlexibleUpdater()) : null,
        builder: builder,
      ),
    );
    return true;
  } finally {
    _showing = false;
  }
}

@visibleForTesting
void resetUpdateDialogForTesting() => _showing = false;

/// Builds custom dialog content. Call [onUpdate] and [onLater] from your
/// buttons. [busy] is true while an update is starting.
typedef UpdateDialogBuilder = Widget Function(
  BuildContext context, {
  required ReleaseRequirements requirements,
  required VoidCallback onUpdate,
  required VoidCallback onLater,
  required bool busy,
});

/// The prompt itself. Usually shown through
/// [showUpdateAvailableDialogIfNeeded], which handles the once-per-build
/// bookkeeping.
class UpdateAvailableDialog extends StatefulWidget {
  const UpdateAvailableDialog({
    super.key,
    required this.requirements,
    this.strings = const VersionGateStrings(),
    this.illustration,
    this.onError,
    this.flexibleUpdater,
    this.builder,
    @visibleForTesting this.launch,
  });

  final ReleaseRequirements requirements;
  final VersionGateStrings strings;
  final Widget? illustration;
  final VersionGateErrorHandler? onError;

  /// Tried before the store link. Null skips straight to the store.
  final FlexibleUpdater? flexibleUpdater;
  final UpdateDialogBuilder? builder;
  final StoreUrlLauncher? launch;

  @override
  State<UpdateAvailableDialog> createState() => _UpdateAvailableDialogState();
}

class _UpdateAvailableDialogState extends State<UpdateAvailableDialog> {
  bool _busy = false;

  Future<void> _update() async {
    if (_busy) return;
    setState(() => _busy = true);
    final messenger = ScaffoldMessenger.maybeOf(context);
    final navigator = Navigator.of(context);
    final strings = widget.strings;

    final updater = widget.flexibleUpdater;
    if (updater != null) {
      try {
        if (await updater.isAvailable()) {
          // Close the dialog as Play takes over. The download runs in the
          // background; if the user never taps install, Play installs it on
          // the next app close.
          if (navigator.canPop()) navigator.pop();
          await updater.download();
          messenger?.showSnackBar(SnackBar(
            content: Text(strings.downloaded),
            duration: const Duration(seconds: 10),
            action: SnackBarAction(
                label: strings.installNow, onPressed: updater.complete),
          ));
          return;
        }
      } catch (e, st) {
        // Expected for sideloaded installs: Play doesn't know this package.
        widget.onError?.call(e, st, task: 'flexibleUpdate', expected: true);
      }
    }
    await _openStore(messenger, navigator);
  }

  Future<void> _openStore(
      ScaffoldMessengerState? messenger, NavigatorState navigator) async {
    final uri = Uri.tryParse(widget.requirements.storeUrl ?? '');
    try {
      if (uri == null) throw StateError('No store URL for this platform');
      final launched = await openStoreUrl(
        uri,
        launch: widget.launch ?? platformLaunch,
        onExternalFailed: (e) => widget.onError?.call(
          e ?? StateError('External launch returned false for $uri'),
          StackTrace.current,
          task: 'openStore.external',
          expected: true,
        ),
      );
      if (!launched) throw StateError('launchUrl returned false for $uri');
      if (mounted && navigator.canPop()) navigator.pop();
    } catch (e, st) {
      widget.onError?.call(e, st, task: 'openStore', expected: false);
      messenger?.showSnackBar(
          SnackBar(content: Text(widget.strings.storeOpenFailed)));
      if (mounted) setState(() => _busy = false);
    }
  }

  void _later() => Navigator.of(context).pop();

  @override
  Widget build(BuildContext context) {
    final custom = widget.builder;
    if (custom != null) {
      return custom(
        context,
        requirements: widget.requirements,
        onUpdate: _busy ? () {} : _update,
        onLater: _busy ? () {} : _later,
        busy: _busy,
      );
    }
    final strings = widget.strings;
    return AlertDialog(
      icon: widget.illustration ?? const Icon(Icons.system_update),
      title: Text(strings.optionalTitle, textAlign: TextAlign.center),
      content: Text(strings.optionalMessage, textAlign: TextAlign.center),
      actionsAlignment: MainAxisAlignment.center,
      actions: [
        TextButton(
            onPressed: _busy ? null : _later, child: Text(strings.laterButton)),
        FilledButton(
          onPressed: _busy ? null : _update,
          child: Text(widget.flexibleUpdater != null
              ? strings.downloadButton
              : strings.updateButton),
        ),
      ],
    );
  }
}
