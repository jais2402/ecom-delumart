-- LLD §3.7: outbox, audit, pending admin actions (configuration is in 0002).

CREATE TABLE audit.outbox (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id        uuid NOT NULL UNIQUE,
  type            text NOT NULL,
  aggregate_id    uuid,
  payload         jsonb NOT NULL,
  payload_version int NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  relayed_at      timestamptz
);
CREATE INDEX outbox_unrelayed ON audit.outbox (id) WHERE relayed_at IS NULL;

CREATE TABLE audit.consumer_receipt (
  consumer text NOT NULL,
  event_id uuid NOT NULL,
  PRIMARY KEY (consumer, event_id)
);

CREATE TABLE audit.audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id    uuid,
  actor_kind  text NOT NULL CHECK (actor_kind IN ('SUPER_ADMIN','SYSTEM')),
  action      text NOT NULL,
  target_type text,
  target_id   text,
  reason      text,
  detail      jsonb,
  prev_hash   bytea,
  row_hash    bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER no_change BEFORE UPDATE OR DELETE ON audit.audit_log
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON audit.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_change();

CREATE TABLE audit.pending_action (
  id           uuid PRIMARY KEY,
  action       text NOT NULL,
  payload      jsonb NOT NULL,
  payload_hash bytea NOT NULL,
  requested_by uuid NOT NULL,
  not_before   timestamptz NOT NULL,
  state        text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED','CANCELLED','EXECUTED','FAILED')),
  executed_at  timestamptz
);
