-- ============================================
-- FRAPPE/ERPNEXT CONNECTIONS (per-user custom integration)
-- ============================================
-- This table stores per-user Frappe/ERPNext connections
-- Credentials are encrypted at rest using AES-256-GCM

CREATE TABLE IF NOT EXISTS frappe_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Connection name (for multiple ERPNext instances)
    connection_name VARCHAR(255) NOT NULL DEFAULT 'Default ERPNext',

    -- ERPNext instance URL (e.g., https://acme.erpnext.com)
    base_url VARCHAR(500) NOT NULL,

    -- Execution provider. MCP is recommended for Frappe/ERPNext v16+;
    -- native uses the REST API directly.
    provider VARCHAR(20) NOT NULL DEFAULT 'native' CHECK (provider IN ('native', 'mcp')),
    mcp_endpoint VARCHAR(500),
    mcp_tools JSONB NOT NULL DEFAULT '[]'::jsonb,

    -- Encrypted credentials (AES-256-GCM)
    -- Format: iv:authTag:encryptedData (base64)
    api_key_encrypted TEXT NOT NULL,
    api_secret_encrypted TEXT NOT NULL,

    -- Connection status
    status VARCHAR(20) DEFAULT 'pending', -- pending, active, error, disconnected
    last_tested_at TIMESTAMP WITH TIME ZONE,
    last_error TEXT,

    -- Validated user info from ERPNext
    erp_user VARCHAR(255), -- Logged-in user in ERPNext
    erp_company VARCHAR(255), -- Primary company
    erp_version VARCHAR(50), -- ERPNext version

    -- Schema cache control
    schema_cached_at TIMESTAMP WITH TIME ZONE,
    schema_version VARCHAR(50), -- Hash of cached schema

    -- Rate limiting
    requests_today INTEGER DEFAULT 0,
    requests_reset_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Audit
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Unique connection per user (can have multiple with different names)
    UNIQUE(user_id, connection_name)
);

-- ============================================
-- FRAPPE DOCTYPE SCHEMAS (cached schemas from user's ERPNext)
-- ============================================
CREATE TABLE IF NOT EXISTS frappe_doctype_schemas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connection_id UUID NOT NULL REFERENCES frappe_connections(id) ON DELETE CASCADE,

    -- DocType info
    doctype_name VARCHAR(255) NOT NULL,
    module VARCHAR(255), -- e.g., "Selling", "Buying", "HR"

    -- Schema data
    schema JSONB NOT NULL, -- Full JSON schema for the DocType
    fields JSONB NOT NULL, -- Extracted field definitions
    required_fields JSONB DEFAULT '[]', -- List of required field names

    -- Metadata from ERPNext
    is_submittable BOOLEAN DEFAULT false,
    is_child_table BOOLEAN DEFAULT false,
    is_single BOOLEAN DEFAULT false,
    track_changes BOOLEAN DEFAULT false,

    -- Caching
    modified_at_erp TIMESTAMP WITH TIME ZONE, -- ERPNext's modified timestamp
    cached_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Unique per connection per doctype
    UNIQUE(connection_id, doctype_name)
);

-- ============================================
-- FRAPPE EXECUTION LOGS (audit trail for Frappe actions)
-- ============================================
CREATE TABLE IF NOT EXISTS frappe_execution_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connection_id UUID REFERENCES frappe_connections(id) ON DELETE SET NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Action info
    action_name VARCHAR(100) NOT NULL, -- e.g., FRAPPE_CREATE_CUSTOMER
    doctype VARCHAR(255),
    document_name VARCHAR(255), -- Created/updated document name

    -- Request/response
    request_params JSONB,
    response_data JSONB,

    -- Status
    status VARCHAR(20) NOT NULL, -- success, error
    error_message TEXT,
    duration_ms INTEGER,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_frappe_connections_user_id ON frappe_connections(user_id);
CREATE INDEX IF NOT EXISTS idx_frappe_connections_status ON frappe_connections(status);
CREATE INDEX IF NOT EXISTS idx_frappe_connections_provider ON frappe_connections(provider);

CREATE INDEX IF NOT EXISTS idx_frappe_doctype_schemas_connection_id ON frappe_doctype_schemas(connection_id);
CREATE INDEX IF NOT EXISTS idx_frappe_doctype_schemas_doctype ON frappe_doctype_schemas(doctype_name);

CREATE INDEX IF NOT EXISTS idx_frappe_execution_logs_connection_id ON frappe_execution_logs(connection_id);
CREATE INDEX IF NOT EXISTS idx_frappe_execution_logs_user_id ON frappe_execution_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_frappe_execution_logs_created ON frappe_execution_logs(created_at);

-- ============================================
-- TRIGGERS
-- ============================================
DROP TRIGGER IF EXISTS update_frappe_connections_updated_at ON frappe_connections;
CREATE TRIGGER update_frappe_connections_updated_at
    BEFORE UPDATE ON frappe_connections
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- HELPER FUNCTIONS
-- ============================================

-- Check if a user has an active Frappe connection
CREATE OR REPLACE FUNCTION has_active_frappe_connection(p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM frappe_connections
        WHERE user_id = p_user_id AND status = 'active'
    );
END;
$$ LANGUAGE plpgsql;

-- Get active Frappe connection for user
CREATE OR REPLACE FUNCTION get_frappe_connection(p_user_id UUID, p_connection_name VARCHAR DEFAULT 'Default ERPNext')
RETURNS TABLE (
    id UUID,
    base_url VARCHAR,
    api_key_encrypted TEXT,
    api_secret_encrypted TEXT,
    erp_user VARCHAR,
    erp_company VARCHAR
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        fc.id,
        fc.base_url,
        fc.api_key_encrypted,
        fc.api_secret_encrypted,
        fc.erp_user,
        fc.erp_company
    FROM frappe_connections fc
    WHERE fc.user_id = p_user_id
    AND fc.connection_name = p_connection_name
    AND fc.status = 'active';
END;
$$ LANGUAGE plpgsql;

-- Cleanup old execution logs (keep 30 days)
CREATE OR REPLACE FUNCTION cleanup_frappe_logs()
RETURNS void AS $$
BEGIN
    DELETE FROM frappe_execution_logs
    WHERE created_at < NOW() - INTERVAL '30 days';

    -- Reset daily request counters
    UPDATE frappe_connections
    SET requests_today = 0, requests_reset_at = NOW()
    WHERE requests_reset_at < NOW() - INTERVAL '24 hours';
END;
$$ LANGUAGE plpgsql;
