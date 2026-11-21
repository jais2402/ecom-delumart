-- Own profile edits (handle, privacy, research opt-out) for the signed-in actor.
--
-- app_web holds no INSERT or UPDATE on core.user_profile (0011); core.update_profile is the only
-- way these three fields change. It derives the actor from the sign-in session, locks the
-- actor's own profile row and validates every field in the database:
--   * handle: 3-24 characters of lowercase letters, digits and hyphens; unique ignoring case;
--     not one of the reserved names (core.reserved_handles()). A taken or reserved handle is
--     CONFLICT ("not available"), a malformed one VALIDATION_FAILED;
--   * privacy: an object whose keys are only public_shelf, show_collector_level and
--     show_handle_on_purchases, each a boolean; merged into the stored settings;
--   * research_opt_out: a boolean.
-- A NULL argument leaves that field unchanged. Returns the updated own profile (no
-- fingerprints, no personal data).

-- handles are unique ignoring case, whatever writes them
CREATE UNIQUE INDEX user_profile_handle_ci ON core.user_profile (lower(handle)) WHERE handle IS NOT NULL;

CREATE FUNCTION core.reserved_handles() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT ARRAY['admin', 'support', 'delulumart', 'staff', 'official', 'help', 'system', 'root', 'moderator']
$$;

CREATE FUNCTION core.privacy_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT ARRAY['public_shelf', 'show_collector_level', 'show_handle_on_purchases']
$$;

-- The actor's own profile as the web app shows it to its owner.
CREATE FUNCTION core.own_profile_json(actor uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('userId', u.id, 'handle', u.handle, 'privacy', u.privacy,
                            'researchOptOut', u.research_opt_out)
    FROM core.user_profile u WHERE u.id = actor
$$;

CREATE FUNCTION core.update_profile(handle text, privacy jsonb, research_opt_out boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor uuid := core.actor_id();
BEGIN
  IF actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  IF update_profile.handle IS NOT NULL AND update_profile.handle !~ '^[a-z0-9-]{3,24}$' THEN
    PERFORM core.fail('VALIDATION_FAILED', 'a handle is 3-24 lowercase letters, digits or hyphens');
  END IF;
  IF update_profile.privacy IS NOT NULL AND (
       jsonb_typeof(update_profile.privacy) <> 'object'
       OR EXISTS (SELECT 1 FROM jsonb_each(update_profile.privacy) e
                   WHERE e.key <> ALL (core.privacy_keys()) OR jsonb_typeof(e.value) <> 'boolean')) THEN
    PERFORM core.fail('VALIDATION_FAILED',
      'privacy settings are public_shelf, show_collector_level and show_handle_on_purchases, each true or false');
  END IF;
  PERFORM 1 FROM core.user_profile u WHERE u.id = actor FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM core.fail('NOT_FOUND', 'finish onboarding first');
  END IF;
  IF update_profile.handle IS NOT NULL THEN
    IF update_profile.handle = ANY (core.reserved_handles())
       OR EXISTS (SELECT 1 FROM core.user_profile u
                   WHERE lower(u.handle) = lower(update_profile.handle) AND u.id <> actor) THEN
      PERFORM core.fail('CONFLICT', 'this handle is not available');
    END IF;
  END IF;
  BEGIN
    UPDATE core.user_profile u
       SET handle = COALESCE(update_profile.handle, u.handle),
           privacy = CASE WHEN update_profile.privacy IS NULL THEN u.privacy ELSE u.privacy || update_profile.privacy END,
           research_opt_out = COALESCE(update_profile.research_opt_out, u.research_opt_out)
     WHERE u.id = actor;
  EXCEPTION WHEN unique_violation THEN
    PERFORM core.fail('CONFLICT', 'this handle is not available');   -- taken concurrently
  END;
  RETURN core.own_profile_json(actor);
END $$;

REVOKE ALL ON FUNCTION core.reserved_handles(), core.privacy_keys(), core.own_profile_json(uuid),
  core.update_profile(text, jsonb, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.update_profile(text, jsonb, boolean) TO app_web;
