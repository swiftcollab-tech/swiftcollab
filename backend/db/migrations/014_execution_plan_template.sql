-- ExecutorV2 persists the plan execution strategy for audit and recovery.
-- IF EXISTS keeps fresh database initialization safe because migrations run
-- before orchestration-schema.sql creates this table for the first time.
ALTER TABLE IF EXISTS execution_plans
  ADD COLUMN IF NOT EXISTS template VARCHAR(50) NOT NULL DEFAULT 'DAG';
