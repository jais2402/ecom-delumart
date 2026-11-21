-- No application role reads another person's user id (seventh security review, blocker 1).
--
-- core.product_version.author_user_id named the store owner of every published listing to anyone
-- who could read the listing (app_web, app_pay, npc_worker), so a store was linkable to its owner's
-- user id although core.company.owner_user_id is unreadable (0050). The column is now unreadable by
-- every application role (column privileges: every other column stays readable under the existing
-- row-level security). The listing commands that write it are SECURITY DEFINER and unchanged.
--
-- Found by the generated test (tests/seventh-review-user-ids.test.ts): core.config_version.created_by
-- (the Super Admin who wrote a configuration) was readable by app_web and app_pay with every row;
-- the application reads only `values` and the version id. Unreadable now as well.

REVOKE SELECT ON core.product_version FROM app_web, app_pay, npc_worker, app_jobs, research_ro;
GRANT SELECT (id, product_id, revision, name, hook, description, alt_text, template_id, price_paise, search, created_at)
  ON core.product_version TO app_web, app_pay, npc_worker;

REVOKE SELECT ON core.config_version FROM app_web, app_pay, app_jobs, npc_worker, research_ro;
GRANT SELECT (id, values, effective_from, note) ON core.config_version TO app_web, app_pay;
