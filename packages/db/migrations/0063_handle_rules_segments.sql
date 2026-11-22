-- Handle look-alikes without refusing ordinary names (eighth security review, minor 4).
--
-- 0056 refused a protected word anywhere in the folded handle, so `mustafa`, `gustaf`, `badminton`,
-- `ecosystem`, `eastafrica`, `staffy` and `staffordshire` were refused (they hold `staf`, `admin`,
-- `system`), while `dclulu`, `aclmin`, `adnnin`, `verifed`, `modrator` and `superadm` passed. Now,
-- mirroring validateHandle in packages/core (the shared table keeps them in agreement):
--   * Folds (core.handle_fold3): lower case, hyphens removed; under the "ligature" reading `rn`→m,
--     `cl`→d, `nn`→m, `vv`→w (in that order); then 0→o, 1/i/l→l, 3→e, 4→a, 5→s, 7→t, 8→b; runs of
--     one letter collapsed (except for the edit-distance check). Both readings are always tried;
--     a reading applies its pairs everywhere or nowhere, so a pair formed across the joint of two
--     words in a contrived spelling (`admin` + `nnod`) can still hide the second word.
--   * LONG protected words (core.handle_long_words(): delulumart, delulu, official, verified,
--     moderator, superadmin, administrator, support, security) are refused anywhere in the folded
--     handle, as before; and a hyphen-separated part or the whole handle (each also without its
--     leading and trailing digits) within ONE edit of one (insertion, deletion or substitution,
--     core.handle_within_one_edit), or a prefix of one missing at most two final letters (six
--     letters at least: `superadm`), is refused too.
--   * SHORT protected words (core.handle_short_words(): admin, staff, mod, system) are refused only
--     when a part or the whole handle (without leading and trailing digits) is, after folding, the
--     word, the word with a plural `s`, or the word joined to a protected, generic or adjacent word
--     (core.handle_adjacent_words(): team, desk, my, the, picks, ...): `admin1`, `adminteam`,
--     `staffsupport`, `official-admin`, `mysystem` — never an arbitrary substring.
--   * GENERIC words: unchanged (only the whole handle, leading and trailing digits ignored).
-- core.handle_protected_words() is now the LONG and SHORT words together; core.handle_lookalike
-- and core.handle_protected_lookalike (used by store and user handles and public coupon codes) keep
-- their signatures. The checks run with JIT off (their row estimates are large and their work
-- tiny: compiling cost far more than it saved).

CREATE FUNCTION core.handle_long_words() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT ARRAY['delulumart', 'delulu', 'official', 'verified', 'moderator', 'superadmin', 'administrator',
               'support', 'security']
$$;

CREATE FUNCTION core.handle_short_words() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT ARRAY['admin', 'staff', 'mod', 'system']
$$;

CREATE FUNCTION core.handle_adjacent_words() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT ARRAY['team', 'desk', 'crew', 'hq', 'ops', 'info', 'real', 'the', 'my', 'care', 'service', 'office',
               'pick', 'picks', 'news']
$$;

CREATE OR REPLACE FUNCTION core.handle_protected_words() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT core.handle_long_words() || core.handle_short_words()
$$;

CREATE FUNCTION core.handle_fold3(h text, ligatures boolean, runs boolean) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN runs THEN regexp_replace(x.f, '(.)\1+', '\1', 'g') ELSE x.f END
    FROM (SELECT translate(CASE WHEN ligatures
                                THEN replace(replace(replace(replace(replace(lower(h), '-', ''), 'rn', 'm'),
                                                             'cl', 'd'), 'nn', 'm'), 'vv', 'w')
                                ELSE replace(lower(h), '-', '') END,
                           '0134578i', 'oleastbl') AS f) x
$$;

CREATE FUNCTION core.handle_within_one_edit(a text, b text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp SET jit = off AS $$
  SELECT CASE
    WHEN a IS NULL OR b IS NULL THEN false
    WHEN a = b THEN true
    WHEN abs(length(a) - length(b)) > 1 THEN false
    WHEN length(a) = length(b) THEN EXISTS (
      SELECT 1 FROM generate_series(1, length(a)) i
       WHERE left(a, i - 1) = left(b, i - 1) AND substr(a, i + 1) = substr(b, i + 1))
    ELSE EXISTS (
      SELECT 1 FROM (SELECT CASE WHEN length(a) > length(b) THEN a ELSE b END AS t,
                            CASE WHEN length(a) > length(b) THEN b ELSE a END AS s) x,
                    generate_series(1, length(x.t)) i
       WHERE left(x.t, i - 1) || substr(x.t, i + 1) = x.s)
  END
$$;

-- Every hyphen-separated part and the whole handle without hyphens, each also without any number
-- of its leading and of its trailing digits (never empty).
CREATE FUNCTION core.handle_parts(h text) RETURNS SETOF text
LANGUAGE sql IMMUTABLE ROWS 16 SET search_path = pg_catalog, pg_temp SET jit = off AS $$
  SELECT DISTINCT substr(p.p, i + 1, length(p.p) - i - j)
    FROM unnest(string_to_array(h, '-') || replace(h, '-', '')) AS p(p),
         LATERAL (SELECT length(substring(p.p FROM '^[0-9]*')) AS lead,
                         length(substring(p.p FROM '[0-9]*$')) AS trail) e,
         generate_series(0, e.lead) i, generate_series(0, e.trail) j
   WHERE i + j < length(p.p)
$$;

-- The folded (runs collapsed) forms a part takes when it is a short word: alone, plural, or joined
-- before and/or after a protected, generic or adjacent word.
CREATE FUNCTION core.handle_short_forms(ligatures boolean) RETURNS SETOF text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp SET jit = off AS $$
  WITH adj AS (
    SELECT core.handle_fold3(x, ligatures, false) AS f
      FROM unnest(ARRAY[''] || core.handle_protected_words() || core.handle_generic_words()
                  || core.handle_adjacent_words()) x)
  SELECT DISTINCT regexp_replace(a.f || w.f || b.f, '(.)\1+', '\1', 'g')
    FROM (SELECT core.handle_fold3(x, ligatures, false) AS f FROM unnest(core.handle_short_words()) x) w,
         adj a,
         (SELECT adj.f FROM adj UNION SELECT 's') b
$$;

-- The same forms, kept in an owner-only table so that a check is an index lookup. Written here
-- from the word lists; a test keeps it equal to handle_short_forms and to packages/core.
CREATE TABLE core.handle_short_form (
  ligatures boolean NOT NULL,
  form      text NOT NULL,
  PRIMARY KEY (ligatures, form)
);
ALTER TABLE core.handle_short_form ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON core.handle_short_form USING (false) WITH CHECK (false);
REVOKE ALL ON core.handle_short_form FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;
INSERT INTO core.handle_short_form (ligatures, form)
SELECT l, f FROM unnest(ARRAY[true, false]) l, core.handle_short_forms(l) f;

-- One reading of the protected-word rules (see the header).
CREATE FUNCTION core.handle_protected_in(h text, ligatures boolean) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp SET jit = off AS $$
  WITH lw AS (
    SELECT core.handle_fold3(w, ligatures, true) AS runs, core.handle_fold3(w, ligatures, false) AS plain
      FROM unnest(core.handle_long_words()) w),
  parts AS (SELECT core.handle_fold3(p, ligatures, false) AS pf FROM core.handle_parts(h) p)
  SELECT EXISTS (SELECT 1 FROM lw WHERE strpos(core.handle_fold3(h, ligatures, true), lw.runs) > 0)
      OR EXISTS (SELECT 1 FROM parts JOIN core.handle_short_form s
                   ON s.ligatures = handle_protected_in.ligatures
                  AND s.form = regexp_replace(parts.pf, '(.)\1+', '\1', 'g'))
      OR EXISTS (SELECT 1 FROM parts, lw
                  WHERE (abs(length(parts.pf) - length(lw.plain)) <= 1 AND core.handle_within_one_edit(parts.pf, lw.plain))
                     OR (length(parts.pf) >= 6 AND length(parts.pf) >= length(lw.plain) - 2
                         AND left(lw.plain, length(parts.pf)) = parts.pf))
$$;

CREATE OR REPLACE FUNCTION core.handle_protected_lookalike(h text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp SET jit = off AS $$
  SELECT h IS NOT NULL
     AND (core.handle_protected_in(lower(h), true) OR core.handle_protected_in(lower(h), false))
$$;

CREATE OR REPLACE FUNCTION core.handle_lookalike(h text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp SET jit = off AS $$
  SELECT h IS NOT NULL AND (
    core.handle_protected_lookalike(h)
    OR EXISTS (
      SELECT 1
        FROM (SELECT char_length(substring(h FROM '^[0-9-]*')) AS lead,
                     char_length(substring(h FROM '[0-9-]*$')) AS trail) e,
             generate_series(0, e.lead) i, generate_series(0, e.trail) j,
             unnest(ARRAY[true, false]) lig, unnest(core.handle_generic_words()) w
       WHERE i + j <= char_length(h)
         AND core.handle_fold3(substr(h, i + 1, GREATEST(char_length(h) - i - j, 0)), lig, true)
             = core.handle_fold3(w, lig, true)))
$$;

-- the store-handle wrapper of 0049/0056 follows (no longer IMMUTABLE: the check reads a table)
CREATE OR REPLACE FUNCTION core.store_handle_lookalike(h text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT core.handle_lookalike(h)
$$;

REVOKE ALL ON FUNCTION core.handle_long_words(), core.handle_short_words(), core.handle_adjacent_words(),
  core.handle_fold3(text, boolean, boolean), core.handle_within_one_edit(text, text), core.handle_parts(text),
  core.handle_short_forms(boolean), core.handle_protected_in(text, boolean)
FROM PUBLIC;
