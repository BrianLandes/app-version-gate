-- app_release_requirements: what app_version_gate reads, and what the
-- app-version-gate GitHub Action writes.
-- https://github.com/BrianLandes/app-version-gate
--
-- One row per platform. The app compares its own build number against:
--
--   min_supported_build  below this, the blocking update screen. THE KILL
--                        SWITCH: raise it to force stale builds off the same
--                        day. Never raise it above the build that is live in
--                        the public store, or users are locked on a screen
--                        whose button leads to a store with nothing newer.
--   latest_build         below this, a dismissible prompt, once per value.
--   pending_build        written by CI on upload (`mode: stage`). The Action's
--                        `mode: promote` copies it to latest_build once the
--                        store actually serves that build. Never read by apps.
--
-- 0 turns a gate off. Build numbers are per platform and never compared across
-- platforms: Android and iOS builds usually come from separate CI counters.
--
-- Access: readable by anon and authenticated, because the gate runs before
-- sign-in and a signed-out user on a stale build still needs to learn why the
-- app won't continue. Nothing here is sensitive. Writes are service_role only:
-- the SQL editor, or the Action with a secret key.

CREATE TABLE public.app_release_requirements (
  platform            text        PRIMARY KEY CHECK (platform IN ('android', 'ios')),
  min_supported_build integer     NOT NULL DEFAULT 0 CHECK (min_supported_build >= 0),
  latest_build        integer     NOT NULL DEFAULT 0 CHECK (latest_build >= 0),
  pending_build       integer     NOT NULL DEFAULT 0 CHECK (pending_build >= 0),
  -- Where the update button sends the user. NULL hides the button.
  store_url           text,
  -- An optional explanation for the force-update screen.
  message             text,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.app_release_requirements.pending_build IS
  'Uploaded to the store but not yet confirmed installable. Promoted into '
  'latest_build once the store serves it. pending_build > latest_build means a '
  'build is waiting on store review or processing.';

ALTER TABLE public.app_release_requirements ENABLE ROW LEVEL SECURITY;

-- Supabase grants every new table to anon and authenticated by default, RLS
-- being all that stands between it and the internet. Grant exactly what the
-- gate needs instead.
REVOKE ALL ON public.app_release_requirements FROM anon, authenticated;
GRANT SELECT ON public.app_release_requirements TO anon, authenticated;

CREATE POLICY "Anyone can read release requirements"
  ON public.app_release_requirements
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- Both platforms start with every gate off, so applying this changes nothing
-- until you set a store URL and raise a number.
INSERT INTO public.app_release_requirements (platform) VALUES ('android'), ('ios');
