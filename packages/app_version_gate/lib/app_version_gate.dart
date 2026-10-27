/// Force-update and update-available prompts for Flutter apps.
///
/// Start with [AppVersionGate]: call `check()` in `main()`, then show
/// [ForceUpdateScreen] or [showUpdateAvailableDialogIfNeeded] based on its
/// result.
library;

export 'src/force_update_screen.dart' show ForceUpdateScreen;
export 'src/observer.dart' show AppVersionGateObserver;
export 'src/open_store_url.dart'
    show StoreUrlLauncher, openStoreUrl, platformLaunch;
export 'src/release_requirements.dart' show ReleaseRequirements;
export 'src/requirements_source.dart'
    show
        JsonUrlRequirementsSource,
        ReleaseRequirementsSource,
        StaticRequirementsSource;
export 'src/strings.dart' show VersionGateStrings;
export 'src/update_available_dialog.dart'
    show
        FlexibleUpdater,
        PlayFlexibleUpdater,
        UpdateAvailableDialog,
        UpdateDialogBuilder,
        resetUpdateDialogForTesting,
        showUpdateAvailableDialogIfNeeded;
export 'src/update_prompt_scheduler.dart' show UpdatePromptScheduler;
export 'src/version_gate.dart'
    show
        AppVersionGate,
        VersionGateErrorHandler,
        VersionGateResult,
        VersionGateStatus,
        evaluateVersionGate;
