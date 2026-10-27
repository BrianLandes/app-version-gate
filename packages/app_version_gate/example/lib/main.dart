// Run with `flutter create . && flutter run` from this directory.
//
// A real app reads its requirements from a backend:
//
//   final gate = AppVersionGate(
//     source: SupabaseRequirementsSource(Supabase.instance.client), // app_version_gate_supabase
//     // or: JsonUrlRequirementsSource(Uri.parse('https://example.com/release.json')),
//   );
//
// This example pretends to be build 10 and serves fixed requirements, so you
// can see both screens without a backend.
import 'package:app_version_gate/app_version_gate.dart';
import 'package:flutter/material.dart';

const _strings = VersionGateStrings(appName: 'Example');

AppVersionGate _gateFor({required int minSupported, required int latest}) =>
    AppVersionGate(
      enabled: true,
      currentBuild: () async => 10,
      platform: () => 'android',
      source: StaticRequirementsSource({
        'android': ReleaseRequirements(
          platform: 'android',
          minSupportedBuild: minSupported,
          latestBuild: latest,
          storeUrl: 'https://play.google.com/store/apps/details?id=com.example',
        ),
      }),
      log: debugPrint,
    );

void main() => runApp(const MaterialApp(home: _Home()));

class _Home extends StatelessWidget {
  const _Home();

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('app_version_gate')),
        body: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            const Text('This app is build 10.'),
            const SizedBox(height: 16),
            FilledButton(
              onPressed: () async {
                final gate = _gateFor(minSupported: 12, latest: 14);
                final result = await gate.check();
                if (!context.mounted ||
                    result.status != VersionGateStatus.forceUpdate) {
                  return;
                }
                await Navigator.of(context).push(MaterialPageRoute<void>(
                  builder: (_) => ForceUpdateScreen(
                      requirements: result.requirements!, strings: _strings),
                ));
              },
              child: const Text('Minimum is 12: force update'),
            ),
            const SizedBox(height: 8),
            OutlinedButton(
              onPressed: () async {
                final gate = _gateFor(minSupported: 0, latest: 14);
                await gate.check();
                if (!context.mounted) return;
                // Shows once per latest build; clear app data to see it again.
                await showUpdateAvailableDialogIfNeeded(context, gate,
                    strings: _strings);
              },
              child: const Text('Latest is 14: offer an update'),
            ),
          ],
        ),
      );
}
