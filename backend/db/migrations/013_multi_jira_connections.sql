-- Allow one SwiftCollab organization to keep multiple native Jira sites.
ALTER TABLE organization_integrations
    ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE;

-- Preserve the original single Jira connection and promote it to the primary
-- site. New connections use a stable key derived from Atlassian's cloud ID.
UPDATE organization_integrations
SET integration_key = 'site:' || external_resource_id,
    is_primary = TRUE
WHERE provider = 'jira'
  AND integration_key = 'default'
  AND status = 'connected'
  AND external_resource_id IS NOT NULL;

-- A stale authorization awaiting site selection must not occupy the legacy
-- singleton key and block a new connection attempt.
UPDATE organization_integrations
SET integration_key = 'pending:' || id::text
WHERE provider = 'jira'
  AND integration_key = 'default'
  AND status = 'pending_selection';

CREATE UNIQUE INDEX IF NOT EXISTS uq_organization_integrations_primary_provider
    ON organization_integrations (organization_id, provider)
    WHERE is_primary = TRUE AND status = 'connected';

CREATE INDEX IF NOT EXISTS idx_organization_integrations_jira_sites
    ON organization_integrations (organization_id, provider, external_resource_id)
    WHERE status = 'connected';
