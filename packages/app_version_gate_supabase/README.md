# app_version_gate_supabase

A Supabase source for [app_version_gate](https://pub.dev/packages/app_version_gate). It reads each platform's release requirements from an `app_release_requirements` table.

```dart
import 'package:app_version_gate/app_version_gate.dart';
import 'package:app_version_gate_supabase/app_version_gate_supabase.dart';

final gate = AppVersionGate(
  source: SupabaseRequirementsSource(Supabase.instance.client),
);
```

## The table

Copy [the migration](https://github.com/BrianLandes/app-version-gate/blob/main/supabase/migrations/20260101000000_app_release_requirements.sql) into your `supabase/migrations/`. It creates one row per platform with every gate off. It also grants anon and authenticated SELECT, and nothing more, because the gate runs before sign-in.

Raise the numbers in the SQL editor:

```sql
update app_release_requirements
   set min_supported_build = 120, updated_at = now()
 where platform = 'android';
```

or let [the GitHub Action](https://github.com/BrianLandes/app-version-gate) advance `latest_build` each time a build is actually live in the store.

The source names its columns rather than selecting `*`, so a later column grant can't break builds you've already shipped. Pass `table:` to read a different table with the same columns.

## License

MIT
