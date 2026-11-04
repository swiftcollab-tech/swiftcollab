-- SwiftCollab Orchestration Schema Extensions
-- Supports LangGraph planning, Temporal execution, and Automation rules

-- ============================================
-- USER CHAT HISTORY
-- ============================================
CREATE TABLE IF NOT EXISTS chat_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(160) NOT NULL DEFAULT 'New conversation',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sequence_number BIGSERIAL NOT NULL UNIQUE,
    conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_conversations_owner_updated
    ON chat_conversations (organization_id, user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_created
    ON chat_messages (conversation_id, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_sequence
    ON chat_messages (conversation_id, sequence_number ASC);

DROP TRIGGER IF EXISTS update_chat_conversations_updated_at ON chat_conversations;
CREATE TRIGGER update_chat_conversations_updated_at
    BEFORE UPDATE ON chat_conversations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- CONVERSATION STATE (for LangGraph dialog control)
-- ============================================
CREATE TABLE IF NOT EXISTS conversation_states (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL DEFAULT gen_random_uuid(),

    -- Message routing classification
    mode VARCHAR(20) NOT NULL DEFAULT 'CHAT_ONLY', -- CHAT_ONLY, TASK_ONLY, MIXED
    intent VARCHAR(100), -- High-level intent (CREATE_MEETING, SEARCH_JIRA, etc.)

    -- Slot filling state
    draft_params JSONB DEFAULT '{}', -- Accumulated parameters
    missing_fields JSONB DEFAULT '[]', -- List of missing required fields
    selected_actions JSONB DEFAULT '[]', -- Chosen Composio action(s)

    -- Context resolution
    resolved_context JSONB DEFAULT '{}', -- workspace, entities, etc.

    -- Plan state
    plan JSONB, -- The execution plan

    -- Status tracking
    status VARCHAR(20) DEFAULT 'collecting', -- collecting, executing, done, error
    workflow_id VARCHAR(255), -- Temporal workflow ID if executing

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '24 hours')
);

-- ============================================
-- EXECUTION PLANS (for reliable task execution)
-- ============================================
CREATE TABLE IF NOT EXISTS execution_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES conversation_states(id) ON DELETE SET NULL,

    -- Plan definition
    plan_type VARCHAR(50) NOT NULL, -- single_action, multi_action, read_summarize_write, batch_update
    steps JSONB NOT NULL, -- Array of step definitions

    -- Execution state
    status VARCHAR(20) DEFAULT 'pending', -- pending, running, paused, completed, failed
    current_step_index INTEGER DEFAULT 0,
    step_results JSONB DEFAULT '[]', -- Results from each step

    -- Idempotency
    idempotency_key VARCHAR(255) UNIQUE,

    -- Error handling
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,

    -- Timing
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- EXECUTION LOGS (audit trail)
-- ============================================
CREATE TABLE IF NOT EXISTS execution_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID REFERENCES execution_plans(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,

    -- Step info
    step_index INTEGER,
    step_type VARCHAR(50), -- tool, llm, transform
    action_name VARCHAR(100),

    -- Execution details
    input_params JSONB,
    output_result JSONB,

    -- Status
    status VARCHAR(20), -- started, success, failed, retrying
    error_message TEXT,
    duration_ms INTEGER,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- AUTOMATION RULES
-- ============================================
CREATE TABLE IF NOT EXISTS automation_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Rule definition
    name VARCHAR(255) NOT NULL,
    description TEXT,

    -- Trigger configuration
    trigger_type VARCHAR(50) NOT NULL, -- event, schedule, webhook
    trigger_config JSONB NOT NULL, -- {app, event_type, filters} or {cron, timezone}

    -- Action configuration
    action_type VARCHAR(50) NOT NULL, -- single_tool, multi_step, workflow
    action_config JSONB NOT NULL, -- Tool call(s) to execute

    -- Slot filling for action
    required_params JSONB DEFAULT '[]', -- Required parameters schema
    param_values JSONB DEFAULT '{}', -- User-provided parameter values
    param_mappings JSONB DEFAULT '{}', -- How to extract params from trigger event

    -- State
    status VARCHAR(20) DEFAULT 'active', -- active, paused, disabled, error
    last_triggered_at TIMESTAMP WITH TIME ZONE,
    trigger_count INTEGER DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    last_error TEXT,

    -- Timing
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- AUTOMATION EXECUTIONS (history)
-- ============================================
CREATE TABLE IF NOT EXISTS automation_executions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id UUID NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Trigger event
    trigger_event JSONB NOT NULL, -- The event that triggered this

    -- Execution
    status VARCHAR(20) DEFAULT 'pending', -- pending, running, success, failed
    result JSONB,
    error_message TEXT,

    -- Idempotency
    dedupe_key VARCHAR(255), -- rule_id + event_unique_id

    -- Timing
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- CONTEXT SNAPSHOTS (for proactive features)
-- ============================================
CREATE TABLE IF NOT EXISTS context_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Snapshot type
    snapshot_type VARCHAR(50) NOT NULL, -- calendar_today, assigned_issues, mentions, prs_waiting

    -- Data
    data JSONB NOT NULL,
    item_count INTEGER DEFAULT 0,

    -- Source tracking
    source_app VARCHAR(50),
    fetch_duration_ms INTEGER,

    -- Freshness
    fetched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '1 hour'),
    is_stale BOOLEAN DEFAULT false
);

-- ============================================
-- PROACTIVE RECOMMENDATIONS
-- ============================================
CREATE TABLE IF NOT EXISTS proactive_recommendations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Recommendation type
    rec_type VARCHAR(50) NOT NULL, -- priority, blocker, followup, time_block, risk

    -- Content
    title VARCHAR(255) NOT NULL,
    description TEXT,
    action_suggestion TEXT,
    urgency VARCHAR(20) DEFAULT 'normal', -- low, normal, high, urgent

    -- Related items
    related_items JSONB DEFAULT '[]', -- Links to Jira, Calendar, etc.

    -- Quick actions
    quick_actions JSONB DEFAULT '[]', -- Pre-configured actions user can trigger

    -- State
    status VARCHAR(20) DEFAULT 'pending', -- pending, shown, acted, dismissed
    shown_at TIMESTAMP WITH TIME ZONE,
    acted_at TIMESTAMP WITH TIME ZONE,

    -- Timing
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '24 hours')
);

-- ============================================
-- USER PREFERENCES (learning from behavior)
-- ============================================
CREATE TABLE IF NOT EXISTS user_preferences_learned (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- App preferences
    favorite_projects JSONB DEFAULT '[]', -- [{app, project_key, usage_count}]
    default_channels JSONB DEFAULT '{}', -- {slack: "C123", teams: "xyz"}
    preferred_meeting_duration INTEGER DEFAULT 30, -- minutes

    -- Notification preferences
    quiet_hours_start TIME DEFAULT '22:00',
    quiet_hours_end TIME DEFAULT '08:00',
    digest_time TIME DEFAULT '09:00',

    -- Tool selection hints
    tool_preferences JSONB DEFAULT '{}', -- Which tools to prefer for what tasks

    -- Behavior tracking
    actions_taken JSONB DEFAULT '[]', -- Recent actions for learning
    dismissed_suggestions JSONB DEFAULT '[]', -- What they don't want

    -- Timing
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- IDEMPOTENCY STORE (prevent duplicate writes)
-- ============================================
CREATE TABLE IF NOT EXISTS idempotency_store (
    key VARCHAR(255) PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,

    -- Result
    result JSONB,

    -- Tracking
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '24 hours')
);

-- ============================================
-- WEBHOOK EVENTS (incoming events from apps)
-- ============================================
CREATE TABLE IF NOT EXISTS webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Source
    source_app VARCHAR(50) NOT NULL,
    event_type VARCHAR(100) NOT NULL,

    -- Raw event
    raw_payload JSONB NOT NULL,
    headers JSONB,

    -- Processing
    status VARCHAR(20) DEFAULT 'pending', -- pending, processing, processed, failed
    processed_at TIMESTAMP WITH TIME ZONE,
    error_message TEXT,

    -- Matching rules
    matched_rule_ids JSONB DEFAULT '[]',

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_conversation_states_user_id ON conversation_states(user_id);
CREATE INDEX IF NOT EXISTS idx_conversation_states_status ON conversation_states(status);
CREATE INDEX IF NOT EXISTS idx_conversation_states_expires ON conversation_states(expires_at);

CREATE INDEX IF NOT EXISTS idx_execution_plans_user_id ON execution_plans(user_id);
CREATE INDEX IF NOT EXISTS idx_execution_plans_status ON execution_plans(status);
CREATE INDEX IF NOT EXISTS idx_execution_plans_idempotency ON execution_plans(idempotency_key);

CREATE INDEX IF NOT EXISTS idx_automation_rules_user_id ON automation_rules(user_id);
CREATE INDEX IF NOT EXISTS idx_automation_rules_status ON automation_rules(status);
CREATE INDEX IF NOT EXISTS idx_automation_rules_trigger_type ON automation_rules(trigger_type);

CREATE INDEX IF NOT EXISTS idx_automation_executions_rule_id ON automation_executions(rule_id);
CREATE INDEX IF NOT EXISTS idx_automation_executions_dedupe ON automation_executions(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_automation_executions_status ON automation_executions(status);

CREATE INDEX IF NOT EXISTS idx_context_snapshots_user_id ON context_snapshots(user_id);
CREATE INDEX IF NOT EXISTS idx_context_snapshots_type ON context_snapshots(snapshot_type);
CREATE INDEX IF NOT EXISTS idx_context_snapshots_expires ON context_snapshots(expires_at);

CREATE INDEX IF NOT EXISTS idx_proactive_recommendations_user_id ON proactive_recommendations(user_id);
CREATE INDEX IF NOT EXISTS idx_proactive_recommendations_status ON proactive_recommendations(status);

CREATE INDEX IF NOT EXISTS idx_webhook_events_status ON webhook_events(status);
CREATE INDEX IF NOT EXISTS idx_webhook_events_source ON webhook_events(source_app, event_type);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_store(expires_at);

-- ============================================
-- TRIGGERS
-- ============================================
DROP TRIGGER IF EXISTS update_conversation_states_updated_at ON conversation_states;
CREATE TRIGGER update_conversation_states_updated_at
    BEFORE UPDATE ON conversation_states
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_execution_plans_updated_at ON execution_plans;
CREATE TRIGGER update_execution_plans_updated_at
    BEFORE UPDATE ON execution_plans
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_automation_rules_updated_at ON automation_rules;
CREATE TRIGGER update_automation_rules_updated_at
    BEFORE UPDATE ON automation_rules
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_user_preferences_learned_updated_at ON user_preferences_learned;
CREATE TRIGGER update_user_preferences_learned_updated_at
    BEFORE UPDATE ON user_preferences_learned
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- EXECUTION DRAFTS (for draft generator template)
-- ============================================
CREATE TABLE IF NOT EXISTS execution_drafts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id UUID REFERENCES execution_plans(id) ON DELETE SET NULL,

    -- Draft content
    draft_type VARCHAR(50) NOT NULL, -- email, message, document, task, meeting
    content JSONB NOT NULL, -- The draft content ready for review
    preview TEXT, -- Human-readable preview

    -- Target action
    target_action VARCHAR(100) NOT NULL, -- Composio action to execute
    target_params JSONB NOT NULL, -- Parameters for the action

    -- Review state
    status VARCHAR(20) DEFAULT 'pending', -- pending, approved, rejected, modified, executed
    reviewer_notes TEXT,
    modified_content JSONB, -- If user made changes

    -- Timing
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    reviewed_at TIMESTAMP WITH TIME ZONE,
    executed_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '7 days')
);

-- ============================================
-- EXECUTION CHECKPOINTS (for long-running tasks)
-- ============================================
CREATE TABLE IF NOT EXISTS execution_checkpoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL, -- References long_running_tasks

    -- Checkpoint data
    checkpoint_index INTEGER NOT NULL,
    step_name VARCHAR(255),
    state_data JSONB NOT NULL, -- Serialized state for resumption

    -- Progress
    items_processed INTEGER DEFAULT 0,
    items_total INTEGER,

    -- Timing
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- LONG RUNNING TASKS (for progress tracking)
-- ============================================
CREATE TABLE IF NOT EXISTS long_running_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id UUID REFERENCES execution_plans(id) ON DELETE SET NULL,

    -- Task definition
    task_type VARCHAR(50) NOT NULL, -- batch_update, data_migration, bulk_export, etc.
    task_name VARCHAR(255) NOT NULL,
    task_config JSONB NOT NULL, -- Configuration for the task

    -- Progress tracking
    status VARCHAR(20) DEFAULT 'pending', -- pending, running, paused, completed, failed, cancelled
    progress_percent INTEGER DEFAULT 0,
    current_step VARCHAR(255),
    items_completed INTEGER DEFAULT 0,
    items_total INTEGER DEFAULT 0,

    -- Checkpointing
    last_checkpoint_id UUID,
    checkpoint_interval INTEGER DEFAULT 10, -- Save every N items

    -- Results
    result_summary JSONB, -- Summary of what was done
    errors JSONB DEFAULT '[]', -- List of errors encountered

    -- Timing
    started_at TIMESTAMP WITH TIME ZONE,
    paused_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    estimated_completion TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- DELAYED EXECUTIONS (for scheduled future actions)
-- ============================================
CREATE TABLE IF NOT EXISTS delayed_executions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rule_id UUID REFERENCES automation_rules(id) ON DELETE SET NULL,

    -- Execution definition
    action_type VARCHAR(50) NOT NULL, -- tool_call, workflow, notification
    action_config JSONB NOT NULL, -- What to execute

    -- Scheduling
    scheduled_for TIMESTAMP WITH TIME ZONE NOT NULL,
    timezone VARCHAR(50) DEFAULT 'UTC',

    -- Status
    status VARCHAR(20) DEFAULT 'pending', -- pending, running, completed, failed, cancelled

    -- Execution result
    result JSONB,
    error_message TEXT,
    executed_at TIMESTAMP WITH TIME ZONE,

    -- Retry
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,

    -- Metadata
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- NOTIFICATION QUEUE (for batching & rate limiting)
-- ============================================
CREATE TABLE IF NOT EXISTS notification_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Notification content
    notification_type VARCHAR(50) NOT NULL, -- alert, digest, reminder, follow_up
    channel VARCHAR(50) NOT NULL, -- slack, email, push, in_app
    priority VARCHAR(20) DEFAULT 'normal', -- low, normal, high, urgent

    -- Content
    title VARCHAR(255) NOT NULL,
    body TEXT,
    data JSONB, -- Additional structured data
    action_url TEXT, -- Deep link

    -- Batching
    batch_key VARCHAR(255), -- For grouping similar notifications
    can_batch BOOLEAN DEFAULT true,

    -- Status
    status VARCHAR(20) DEFAULT 'queued', -- queued, batched, sent, failed, cancelled

    -- Rate limiting
    sent_count_today INTEGER DEFAULT 0,

    -- Timing
    scheduled_for TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    sent_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- USER INTERACTIONS (for personalization learning)
-- ============================================
CREATE TABLE IF NOT EXISTS user_interactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Interaction type
    interaction_type VARCHAR(50) NOT NULL, -- suggestion_accepted, suggestion_dismissed, action_taken, feedback

    -- Context
    feature VARCHAR(50), -- daily_plan, focus_blocks, digest, blockers, followups, risks
    item_type VARCHAR(50), -- task, meeting, email, notification
    item_id VARCHAR(255), -- Reference to the specific item

    -- Details
    action_taken VARCHAR(100), -- What the user did
    metadata JSONB, -- Additional context

    -- Feedback
    rating INTEGER, -- 1-5 if provided
    feedback_text TEXT,

    -- Timing
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- DAILY DIGESTS (stored digests for reference)
-- ============================================
CREATE TABLE IF NOT EXISTS daily_digests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Digest content
    digest_date DATE NOT NULL,
    digest_type VARCHAR(50) DEFAULT 'morning', -- morning, evening, weekly

    -- Content sections
    summary TEXT,
    priorities JSONB DEFAULT '[]',
    calendar_changes JSONB DEFAULT '[]',
    task_updates JSONB DEFAULT '[]',
    email_highlights JSONB DEFAULT '[]',
    metrics JSONB DEFAULT '{}',

    -- Full content
    full_digest JSONB, -- Complete structured digest

    -- Delivery
    delivered_via VARCHAR(50), -- email, slack, in_app
    delivered_at TIMESTAMP WITH TIME ZONE,

    -- Engagement
    opened_at TIMESTAMP WITH TIME ZONE,
    actions_taken INTEGER DEFAULT 0,

    -- Timing
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Unique per user per date per type
    UNIQUE(user_id, digest_date, digest_type)
);

-- ============================================
-- FOCUS BLOCKS (suggested focus time periods)
-- ============================================
CREATE TABLE IF NOT EXISTS focus_blocks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Time block
    block_date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    duration_minutes INTEGER NOT NULL,

    -- Source
    source VARCHAR(50) DEFAULT 'suggested', -- suggested, scheduled, manual

    -- Matched task
    matched_task_id VARCHAR(255), -- Jira/Asana/Linear task ID
    matched_task_summary TEXT,
    matched_task_app VARCHAR(50),
    match_score FLOAT,

    -- Status
    status VARCHAR(20) DEFAULT 'suggested', -- suggested, accepted, declined, scheduled, completed
    calendar_event_id VARCHAR(255), -- If user created a calendar block

    -- Outcome
    actual_start TIMESTAMP WITH TIME ZONE,
    actual_end TIMESTAMP WITH TIME ZONE,
    productivity_rating INTEGER, -- 1-5 if user rates it

    -- Timing
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- RISK ALERTS (deadline and risk monitoring)
-- ============================================
CREATE TABLE IF NOT EXISTS risk_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Risk type
    risk_type VARCHAR(50) NOT NULL, -- deadline_approaching, deadline_missed, calendar_conflict, overdue_task, blocked_work
    severity VARCHAR(20) NOT NULL, -- low, medium, high, critical

    -- Affected items
    affected_item_type VARCHAR(50), -- task, meeting, deadline
    affected_item_id VARCHAR(255),
    affected_item_title VARCHAR(255),
    affected_app VARCHAR(50),

    -- Risk details
    description TEXT NOT NULL,
    deadline TIMESTAMP WITH TIME ZONE,
    days_until_due INTEGER,

    -- Recommendations
    recommendations JSONB DEFAULT '[]', -- Suggested actions

    -- Status
    status VARCHAR(20) DEFAULT 'active', -- active, acknowledged, resolved, dismissed
    acknowledged_at TIMESTAMP WITH TIME ZONE,
    resolved_at TIMESTAMP WITH TIME ZONE,
    resolution_notes TEXT,

    -- Timing
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- FOLLOWUP RECOMMENDATIONS (suggested follow-ups)
-- ============================================
CREATE TABLE IF NOT EXISTS followup_recommendations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Followup type
    followup_type VARCHAR(50) NOT NULL, -- email_reply, slack_reply, meeting_schedule, task_update
    priority VARCHAR(20) DEFAULT 'normal', -- low, normal, high, urgent

    -- Source item
    source_app VARCHAR(50) NOT NULL,
    source_type VARCHAR(50), -- email, message, pr, issue
    source_id VARCHAR(255),
    source_preview TEXT,

    -- Recommended action
    recommendation TEXT NOT NULL,
    suggested_action VARCHAR(100), -- Composio action to execute
    suggested_params JSONB, -- Pre-filled parameters

    -- Draft content (if applicable)
    draft_content TEXT,

    -- Status
    status VARCHAR(20) DEFAULT 'pending', -- pending, accepted, declined, completed
    completed_at TIMESTAMP WITH TIME ZONE,

    -- Timing
    last_activity TIMESTAMP WITH TIME ZONE, -- When was the source last active
    days_since_activity INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- RULE HEALTH (for automation self-healing)
-- ============================================
CREATE TABLE IF NOT EXISTS rule_health (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id UUID NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,

    -- Health metrics (rolling 24h window)
    executions_total INTEGER DEFAULT 0,
    executions_success INTEGER DEFAULT 0,
    executions_failed INTEGER DEFAULT 0,
    success_rate FLOAT DEFAULT 1.0,

    -- Timing metrics
    avg_duration_ms INTEGER,
    max_duration_ms INTEGER,

    -- Health status
    health_status VARCHAR(20) DEFAULT 'healthy', -- healthy, degraded, failing, paused
    consecutive_failures INTEGER DEFAULT 0,
    last_failure_reason TEXT,

    -- Auto-healing
    auto_paused BOOLEAN DEFAULT false,
    auto_paused_at TIMESTAMP WITH TIME ZONE,
    recovery_attempts INTEGER DEFAULT 0,
    last_recovery_attempt TIMESTAMP WITH TIME ZONE,

    -- Timing
    window_start TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    UNIQUE(rule_id)
);

-- ============================================
-- ADDITIONAL INDEXES FOR NEW TABLES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_execution_drafts_user_id ON execution_drafts(user_id);
CREATE INDEX IF NOT EXISTS idx_execution_drafts_status ON execution_drafts(status);
CREATE INDEX IF NOT EXISTS idx_execution_drafts_expires ON execution_drafts(expires_at);

CREATE INDEX IF NOT EXISTS idx_execution_checkpoints_task_id ON execution_checkpoints(task_id);

CREATE INDEX IF NOT EXISTS idx_long_running_tasks_user_id ON long_running_tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_long_running_tasks_status ON long_running_tasks(status);

CREATE INDEX IF NOT EXISTS idx_delayed_executions_user_id ON delayed_executions(user_id);
CREATE INDEX IF NOT EXISTS idx_delayed_executions_scheduled ON delayed_executions(scheduled_for);
CREATE INDEX IF NOT EXISTS idx_delayed_executions_status ON delayed_executions(status);

CREATE INDEX IF NOT EXISTS idx_notification_queue_user_id ON notification_queue(user_id);
CREATE INDEX IF NOT EXISTS idx_notification_queue_status ON notification_queue(status);
CREATE INDEX IF NOT EXISTS idx_notification_queue_scheduled ON notification_queue(scheduled_for);
CREATE INDEX IF NOT EXISTS idx_notification_queue_batch ON notification_queue(batch_key);

CREATE INDEX IF NOT EXISTS idx_user_interactions_user_id ON user_interactions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_interactions_type ON user_interactions(interaction_type);
CREATE INDEX IF NOT EXISTS idx_user_interactions_feature ON user_interactions(feature);
CREATE INDEX IF NOT EXISTS idx_user_interactions_created ON user_interactions(created_at);

CREATE INDEX IF NOT EXISTS idx_daily_digests_user_date ON daily_digests(user_id, digest_date);

CREATE INDEX IF NOT EXISTS idx_focus_blocks_user_date ON focus_blocks(user_id, block_date);
CREATE INDEX IF NOT EXISTS idx_focus_blocks_status ON focus_blocks(status);

CREATE INDEX IF NOT EXISTS idx_risk_alerts_user_id ON risk_alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_risk_alerts_status ON risk_alerts(status);
CREATE INDEX IF NOT EXISTS idx_risk_alerts_severity ON risk_alerts(severity);

CREATE INDEX IF NOT EXISTS idx_followup_recommendations_user_id ON followup_recommendations(user_id);
CREATE INDEX IF NOT EXISTS idx_followup_recommendations_status ON followup_recommendations(status);

CREATE INDEX IF NOT EXISTS idx_rule_health_rule_id ON rule_health(rule_id);
CREATE INDEX IF NOT EXISTS idx_rule_health_status ON rule_health(health_status);

-- ============================================
-- ADDITIONAL TRIGGERS FOR NEW TABLES
-- ============================================
DROP TRIGGER IF EXISTS update_long_running_tasks_updated_at ON long_running_tasks;
CREATE TRIGGER update_long_running_tasks_updated_at
    BEFORE UPDATE ON long_running_tasks
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_focus_blocks_updated_at ON focus_blocks;
CREATE TRIGGER update_focus_blocks_updated_at
    BEFORE UPDATE ON focus_blocks
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_risk_alerts_updated_at ON risk_alerts;
CREATE TRIGGER update_risk_alerts_updated_at
    BEFORE UPDATE ON risk_alerts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_rule_health_updated_at ON rule_health;
CREATE TRIGGER update_rule_health_updated_at
    BEFORE UPDATE ON rule_health
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- RECENT RECIPIENTS (for entity resolution)
-- ============================================
CREATE TABLE IF NOT EXISTS recent_recipients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Recipient info
    recipient_email VARCHAR(255) NOT NULL,
    recipient_name VARCHAR(255),

    -- Usage tracking
    send_count INTEGER DEFAULT 1,
    last_sent_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Timing
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Unique per user per email
    UNIQUE(user_id, recipient_email)
);

-- ============================================
-- USER CONTACTS (cached contact directory)
-- ============================================
CREATE TABLE IF NOT EXISTS user_contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Contact info
    email VARCHAR(255) NOT NULL,
    name VARCHAR(255),
    phone VARCHAR(50),

    -- Source
    source VARCHAR(50) DEFAULT 'manual', -- google_contacts, slack, manual, import

    -- Metadata
    metadata JSONB DEFAULT '{}',

    -- Timing
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    synced_at TIMESTAMP WITH TIME ZONE,

    -- Unique per user per email
    UNIQUE(user_id, email)
);

-- Indexes for entity resolution tables
CREATE INDEX IF NOT EXISTS idx_recent_recipients_user_id ON recent_recipients(user_id);
CREATE INDEX IF NOT EXISTS idx_recent_recipients_email ON recent_recipients(recipient_email);
CREATE INDEX IF NOT EXISTS idx_recent_recipients_name ON recent_recipients(recipient_name);
CREATE INDEX IF NOT EXISTS idx_recent_recipients_last_sent ON recent_recipients(last_sent_at);

CREATE INDEX IF NOT EXISTS idx_user_contacts_user_id ON user_contacts(user_id);
CREATE INDEX IF NOT EXISTS idx_user_contacts_email ON user_contacts(email);
CREATE INDEX IF NOT EXISTS idx_user_contacts_name ON user_contacts(name);

-- Triggers for entity resolution tables
DROP TRIGGER IF EXISTS update_recent_recipients_updated_at ON recent_recipients;
CREATE TRIGGER update_recent_recipients_updated_at
    BEFORE UPDATE ON recent_recipients
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_user_contacts_updated_at ON user_contacts;
CREATE TRIGGER update_user_contacts_updated_at
    BEFORE UPDATE ON user_contacts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- CLEANUP FUNCTION (run periodically)
-- ============================================
CREATE OR REPLACE FUNCTION cleanup_expired_data()
RETURNS void AS $$
BEGIN
    -- Delete expired conversation states
    DELETE FROM conversation_states WHERE expires_at < NOW();

    -- Delete expired context snapshots
    DELETE FROM context_snapshots WHERE expires_at < NOW();

    -- Delete expired recommendations
    DELETE FROM proactive_recommendations WHERE expires_at < NOW();

    -- Delete expired idempotency keys
    DELETE FROM idempotency_store WHERE expires_at < NOW();

    -- Delete expired execution drafts
    DELETE FROM execution_drafts WHERE expires_at < NOW();

    -- Delete old webhook events (keep 7 days)
    DELETE FROM webhook_events WHERE created_at < NOW() - INTERVAL '7 days';

    -- Delete old execution logs (keep 30 days)
    DELETE FROM execution_logs WHERE created_at < NOW() - INTERVAL '30 days';

    -- Delete old automation executions (keep 30 days)
    DELETE FROM automation_executions WHERE created_at < NOW() - INTERVAL '30 days';

    -- Delete old user interactions (keep 90 days)
    DELETE FROM user_interactions WHERE created_at < NOW() - INTERVAL '90 days';

    -- Delete old daily digests (keep 30 days)
    DELETE FROM daily_digests WHERE digest_date < CURRENT_DATE - INTERVAL '30 days';

    -- Delete old focus blocks (keep 14 days)
    DELETE FROM focus_blocks WHERE block_date < CURRENT_DATE - INTERVAL '14 days';

    -- Delete old risk alerts (keep 30 days for resolved)
    DELETE FROM risk_alerts WHERE status IN ('resolved', 'dismissed') AND updated_at < NOW() - INTERVAL '30 days';

    -- Delete old followup recommendations (keep 14 days)
    DELETE FROM followup_recommendations WHERE created_at < NOW() - INTERVAL '14 days';

    -- Delete old execution checkpoints (keep for tasks only 7 days after completion)
    DELETE FROM execution_checkpoints WHERE task_id IN (
        SELECT id FROM long_running_tasks
        WHERE status IN ('completed', 'failed', 'cancelled')
        AND completed_at < NOW() - INTERVAL '7 days'
    );

    -- Delete completed long running tasks older than 30 days
    DELETE FROM long_running_tasks
    WHERE status IN ('completed', 'failed', 'cancelled')
    AND completed_at < NOW() - INTERVAL '30 days';

    -- Delete completed delayed executions older than 7 days
    DELETE FROM delayed_executions
    WHERE status IN ('completed', 'failed', 'cancelled')
    AND executed_at < NOW() - INTERVAL '7 days';

    -- Delete sent notifications older than 7 days
    DELETE FROM notification_queue
    WHERE status = 'sent'
    AND sent_at < NOW() - INTERVAL '7 days';
END;
$$ LANGUAGE plpgsql;
