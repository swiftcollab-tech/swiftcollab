-- Provider-neutral metadata needed by native OAuth connectors such as Jira.
ALTER TABLE organization_integrations
    ADD COLUMN IF NOT EXISTS external_account_id TEXT,
    ADD COLUMN IF NOT EXISTS external_resource_id TEXT,
    ADD COLUMN IF NOT EXISTS external_resource_name TEXT,
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_organization_integrations_resource
    ON organization_integrations (organization_id, provider, external_resource_id);
