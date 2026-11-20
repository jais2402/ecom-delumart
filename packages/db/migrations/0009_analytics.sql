-- LLD §3.8: analytics and experiments.

CREATE TABLE analytics.event (
  event_id          uuid NOT NULL,
  type              text NOT NULL,
  occurred_at       timestamptz NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  subject_pseudo_id bytea,
  session_id        uuid,
  source            text,
  props             jsonb NOT NULL,
  geo_country       text,
  geo_region        text,
  geo_city          text,
  PRIMARY KEY (occurred_at, event_id)
) PARTITION BY RANGE (occurred_at);                            -- daily partitions; dropped after retention
-- catch-all so inserts never fail before the partition job has created the day's partition
CREATE TABLE analytics.event_default PARTITION OF analytics.event DEFAULT;

CREATE TABLE analytics.metric_daily (
  metric            text NOT NULL,
  day               date NOT NULL,
  dims              jsonb NOT NULL,
  dims_hash         bytea NOT NULL,
  value             numeric NOT NULL,
  distinct_accounts int,
  def_version       int NOT NULL,
  computed_at       timestamptz NOT NULL,
  PRIMARY KEY (metric, day, dims_hash)
);

CREATE TABLE analytics.metric_hourly (
  metric            text NOT NULL,
  hour              timestamptz NOT NULL,
  dims              jsonb NOT NULL,
  dims_hash         bytea NOT NULL,
  value             numeric NOT NULL,
  distinct_accounts int,
  def_version       int NOT NULL,
  computed_at       timestamptz NOT NULL,
  PRIMARY KEY (metric, hour, dims_hash)
);

CREATE TABLE analytics.experiment (
  id         uuid PRIMARY KEY,
  key        text UNIQUE NOT NULL,
  salt       bytea NOT NULL,
  status     text NOT NULL CHECK (status IN ('DRAFT','RUNNING','STOPPED','ARCHIVED')),
  variants   jsonb NOT NULL,
  audience   jsonb NOT NULL,
  guardrails jsonb NOT NULL,
  starts_at  timestamptz,
  ends_at    timestamptz
);

CREATE TABLE analytics.experiment_exposure (
  experiment_id uuid NOT NULL REFERENCES analytics.experiment(id),
  subject_id    uuid NOT NULL,
  variant       text NOT NULL,
  exposed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (experiment_id, subject_id)
);
