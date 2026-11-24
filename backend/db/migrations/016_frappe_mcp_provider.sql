DO $$
BEGIN
  IF to_regclass('public.frappe_connections') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE frappe_connections
    ADD COLUMN IF NOT EXISTS provider VARCHAR(20) NOT NULL DEFAULT 'native',
    ADD COLUMN IF NOT EXISTS mcp_endpoint VARCHAR(500),
    ADD COLUMN IF NOT EXISTS mcp_tools JSONB NOT NULL DEFAULT '[]'::jsonb;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'frappe_connections_provider_check'
  ) THEN
    ALTER TABLE frappe_connections
      ADD CONSTRAINT frappe_connections_provider_check
      CHECK (provider IN ('native', 'mcp'));
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.frappe_connections') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_frappe_connections_provider
      ON frappe_connections(provider);
  END IF;
END $$;
