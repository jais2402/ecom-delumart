-- Catalog categories (LLD §3.9 `category`): public reference data, written only by the owner
-- (the seed loader, packages/db/src/seed.ts, and future console migrations). core.product.category
-- holds the slug; no foreign key yet, because user products created before a category row exists
-- must keep working.

CREATE TABLE core.category (
  slug  text PRIMARY KEY CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) <= 40),
  name  text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  blurb text NOT NULL DEFAULT '' CHECK (char_length(blurb) <= 300)
);

ALTER TABLE core.category ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.category FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;
GRANT SELECT ON core.category TO app_web, app_pay, app_jobs;
CREATE POLICY web_read ON core.category FOR SELECT TO app_web USING (true);
CREATE POLICY pay_read ON core.category FOR SELECT TO app_pay USING (true);
CREATE POLICY jobs_read ON core.category FOR SELECT TO app_jobs USING (true);
