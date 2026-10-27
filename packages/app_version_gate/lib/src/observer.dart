import 'dart:async';

import 'package:flutter/widgets.dart';

import 'release_requirements.dart';
import 'version_gate.dart';

/// Rechecks the gate whenever the app returns to the foreground, and calls
/// [onForceUpdate] when a minimum raised while the app sat in the background
/// now blocks this build.
///
/// ```dart
/// late final _observer = AppVersionGateObserver(gate, onForceUpdate: (req) {
///   navigatorKey.currentState?.pushAndRemoveUntil(
///     MaterialPageRoute(builder: (_) => ForceUpdateScreen(requirements: req)),
///     (_) => false,
///   );
/// });
///
/// @override void initState() { super.initState(); _observer.attach(); }
/// @override void dispose() { _observer.detach(); super.dispose(); }
/// ```
class AppVersionGateObserver with WidgetsBindingObserver {
  AppVersionGateObserver(this.gate, {required this.onForceUpdate});

  final AppVersionGate gate;
  final void Function(ReleaseRequirements requirements) onForceUpdate;

  void attach() => WidgetsBinding.instance.addObserver(this);
  void detach() => WidgetsBinding.instance.removeObserver(this);

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) unawaited(_recheck());
  }

  Future<void> _recheck() async {
    if (!await gate.recheckOnResume()) return;
    final requirements = gate.result.requirements;
    if (requirements != null) onForceUpdate(requirements);
  }
}
