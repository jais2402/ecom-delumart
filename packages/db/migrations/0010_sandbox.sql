-- LLD §3.9 (minimal): NPC simulation sandbox. Only npc_worker writes here; it has
-- no access to ledger, orders or inventory.

CREATE TABLE sandbox.npc_actor (
  id         uuid PRIMARY KEY,
  persona    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sandbox.simulation_run (
  id          uuid PRIMARY KEY,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  params      jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE sandbox.simulation_order (
  id                 uuid PRIMARY KEY,
  run_id             uuid NOT NULL REFERENCES sandbox.simulation_run(id),
  actor_id           uuid NOT NULL REFERENCES sandbox.npc_actor(id),
  product_version_id uuid NOT NULL,          -- read from core.product_version; no FK across the boundary
  simulated_paise    bigint NOT NULL,        -- simulated, never posted to the ledger
  created_at         timestamptz NOT NULL DEFAULT now()
);
