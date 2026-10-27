import 'package:flutter/material.dart';

import 'open_store_url.dart';
import 'release_requirements.dart';
import 'strings.dart';
import 'version_gate.dart';

/// The blocking "you must update" screen. Show it as the app's home when the
/// gate says [VersionGateStatus.forceUpdate].
///
/// It can't be dismissed: there's no back navigation, and the only way
/// forward is the store. Use it on both platforms, rather than Play's
/// immediate-update flow on Android, so sideloaded and test installs are gated
/// the same as store installs.
///
/// The defaults follow your app's [Theme]. Pass [illustration] for artwork,
/// and [builder] to replace the content entirely while keeping the
/// non-dismissible shell and the store-opening logic.
class ForceUpdateScreen extends StatelessWidget {
  const ForceUpdateScreen({
    super.key,
    required this.requirements,
    this.strings = const VersionGateStrings(),
    this.illustration,
    this.backgroundColor,
    this.onError,
    this.builder,
    @visibleForTesting this.launch,
  });

  final ReleaseRequirements requirements;
  final VersionGateStrings strings;
  final Widget? illustration;
  final Color? backgroundColor;
  final VersionGateErrorHandler? onError;

  /// Replaces the default content. [openStore] is null when there is no
  /// store URL to send the user to.
  final Widget Function(
    BuildContext context,
    ReleaseRequirements requirements,
    VoidCallback? openStore,
  )? builder;

  final StoreUrlLauncher? launch;

  Future<void> _openStore(BuildContext context) async {
    final uri = Uri.tryParse(requirements.storeUrl ?? '');
    if (uri == null) return;
    final messenger = ScaffoldMessenger.maybeOf(context);
    try {
      final launched = await openStoreUrl(
        uri,
        launch: launch ?? platformLaunch,
        onExternalFailed: (e) => onError?.call(
          e ?? StateError('External launch returned false for $uri'),
          StackTrace.current,
          task: 'openStore.external',
          expected: true,
        ),
      );
      if (!launched) throw StateError('launchUrl returned false for $uri');
    } catch (e, st) {
      onError?.call(e, st, task: 'openStore', expected: false);
      messenger?.showSnackBar(SnackBar(content: Text(strings.storeOpenFailed)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final openStore =
        requirements.storeUrl == null ? null : () => _openStore(context);
    return PopScope(
      canPop: false,
      child: Scaffold(
        backgroundColor: backgroundColor,
        body: SafeArea(
          child: builder?.call(context, requirements, openStore) ??
              _DefaultContent(
                title: strings.forceTitle,
                message: requirements.message ?? strings.forceMessage,
                buttonLabel: strings.updateButton,
                illustration: illustration,
                onPressed: openStore,
              ),
        ),
      ),
    );
  }
}

class _DefaultContent extends StatelessWidget {
  const _DefaultContent({
    required this.title,
    required this.message,
    required this.buttonLabel,
    required this.illustration,
    required this.onPressed,
  });

  final String title;
  final String message;
  final String buttonLabel;
  final Widget? illustration;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 24),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              illustration ??
                  Icon(Icons.system_update,
                      size: 72, color: theme.colorScheme.primary),
              const SizedBox(height: 24),
              Text(
                title,
                textAlign: TextAlign.center,
                style: theme.textTheme.headlineSmall
                    ?.copyWith(fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 12),
              Text(message,
                  textAlign: TextAlign.center,
                  style: theme.textTheme.bodyLarge),
              if (onPressed != null) ...[
                const SizedBox(height: 28),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: onPressed,
                    style: FilledButton.styleFrom(
                        minimumSize: const Size.fromHeight(52)),
                    child: Text(buttonLabel),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
