-- LLD §2: privileges. Runs after every table exists (the LLD lists the grants
-- before the tables, which cannot execute).

-- core: application roles read and write; npc_worker reads published versions only
GRANT USAGE ON SCHEMA core TO app_web, app_jobs, npc_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core TO app_web, app_jobs;
-- configuration rows are immutable versions: new rows only
REVOKE UPDATE, DELETE ON core.config_version FROM app_web, app_jobs;
GRANT SELECT ON core.product_version TO npc_worker;

-- ledger: insert-only for the application
GRANT USAGE ON SCHEMA ledger TO app_web, app_jobs;
GRANT SELECT, INSERT ON ledger.journal, ledger.posting, ledger.grant_record TO app_web, app_jobs;
-- provisioning creates the user's ledger account (missing from the LLD grant list)
GRANT SELECT, INSERT ON ledger.ledger_account TO app_web, app_jobs;
GRANT SELECT, INSERT, UPDATE ON ledger.wallet TO app_web, app_jobs;
-- no UPDATE/DELETE on journal, posting, grant_record for anyone but the owner

-- private data: web only
GRANT USAGE ON SCHEMA private TO app_web;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA private TO app_web;

-- sandbox: NPC role only
GRANT USAGE ON SCHEMA sandbox TO npc_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA sandbox TO npc_worker;

-- analytics: web records events and exposures; jobs aggregate
GRANT USAGE ON SCHEMA analytics TO app_web, app_jobs;
GRANT INSERT ON analytics.event TO app_web;
GRANT SELECT ON analytics.experiment TO app_web;
GRANT SELECT, INSERT ON analytics.experiment_exposure TO app_web;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA analytics TO app_jobs;

-- audit: outbox and audit log are written by the application; audit_log is append-only
GRANT USAGE ON SCHEMA audit TO app_web, app_jobs;
GRANT SELECT, INSERT ON audit.outbox, audit.audit_log TO app_web, app_jobs;
GRANT UPDATE (relayed_at) ON audit.outbox TO app_jobs;
GRANT SELECT, INSERT ON audit.consumer_receipt TO app_jobs;
GRANT SELECT, INSERT, UPDATE ON audit.pending_action TO app_web, app_jobs;

-- research: read-only, including tables built later by the migration role
GRANT USAGE ON SCHEMA research TO research_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA research TO research_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA research GRANT SELECT ON TABLES TO research_ro;

-- managed-database built-in public roles must have nothing
REVOKE ALL ON ALL TABLES IN SCHEMA core, ledger, private, sandbox, analytics, audit, research FROM anon, authenticated, PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA core, ledger, private, sandbox, analytics, audit, research FROM anon, authenticated, PUBLIC;
REVOKE ALL ON SCHEMA core, ledger, private, sandbox, analytics, audit, research FROM anon, authenticated, PUBLIC;
