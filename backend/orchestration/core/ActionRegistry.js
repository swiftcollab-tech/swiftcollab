/**
 * ActionRegistry - Action Resolution with Strict Allowlisting
 *
 * Architecture:
 * ┌─────────────────────────────────────────────────────────────┐
 * │                   ACTION RESOLVER                           │
 * │  ┌─────────────────┐                                       │
 * │  │   Allowlist     │  ← Only these actions can execute     │
 * │  │   Registry      │                                       │
 * │  └────────┬────────┘                                       │
 * │           ↓                                                 │
 * │  ┌─────────────────┐                                       │
 * │  │  Exact Match?   │──── Yes ──→ Return action             │
 * │  └────────┬────────┘                                       │
 * │           ↓ No                                              │
 * │  ┌─────────────────┐                                       │
 * │  │  Known Alias?   │──── Yes ──→ Log + Return canonical    │
 * │  └────────┬────────┘                                       │
 * │           ↓ No                                              │
 * │  ┌─────────────────┐                                       │
 * │  │  Close Match?   │──── Yes ──→ Return suggestions        │
 * │  │  (Similarity)   │            (NEVER auto-correct)       │
 * │  └────────┬────────┘                                       │
 * │           ↓ No                                              │
 * │  ┌─────────────────┐                                       │
 * │  │  Hard Error     │──→ "Unknown action" + capability list │
 * │  └─────────────────┘                                       │
 * └─────────────────────────────────────────────────────────────┘
 */

// ============================================
// SIDE EFFECT CLASSIFICATION CONSTANTS
// ============================================
const SIDE_EFFECT_TIERS = {
  PURE_READ: 0,       // No side effects at all
  IMPLICIT_WRITE: 1,  // Hidden side effects (read receipts, logs, etc.)
  EXPLICIT_WRITE: 2,  // Obvious mutations (create, update, delete, send)
};

const EXECUTION_PHASES = {
  PREFLIGHT: 'preflight',       // Only tier 0 actions allowed
  VALIDATION: 'validation',     // Tier 0-1 with parameter sanitization
  EXECUTION: 'execution',       // All tiers allowed with confirmation
  POST_EXECUTION: 'post_exec',  // Cleanup and logging only
};

// ============================================
// COMPONENT 1: ACTION ALLOWLIST REGISTRY
// Single source of truth for what the system can do
// Now includes side effect classification
// ============================================
const ACTION_ALLOWLIST = {
  version: '2.6.0',
  last_updated: '2026-11-07',
  actions: {
    // ========== SYSTEM (INTERNAL) ==========
    SYSTEM_CHECK_CONNECTIONS: {
      enabled: true,
      provider: 'system',
      composio_action: null,
      category: 'system',
      mutating: false,
      irreversible: false,
      description: 'Check which apps are connected and ready to use',
      required_scopes: [],
      user_facing_name: 'Check app connections',
      examples: ['check integrations', 'what is connected', 'connection status'],
      side_effect_tier: SIDE_EFFECT_TIERS.PURE_READ,
      side_effects: [],
      preflight_safe: true,
      preflight_alternative: null,
    },

    // ========== GOOGLE CALENDAR ==========
    GOOGLECALENDAR_CREATE_EVENT: {
      enabled: true,
      provider: 'composio',
      composio_action: 'GOOGLECALENDAR_CREATE_EVENT',
      category: 'calendar',
      mutating: true,
      irreversible: false,
      description: 'Create a new calendar event or meeting',
      required_scopes: ['calendar.events.write'],
      user_facing_name: 'Create calendar event',
      examples: ['schedule a meeting', 'create an event', 'book time', 'set up a call'],
      // Side effect classification
      side_effect_tier: SIDE_EFFECT_TIERS.EXPLICIT_WRITE,
      side_effects: [
        { type: 'calendar_entry', description: 'Creates visible calendar event' },
        { type: 'notification', description: 'May send invites to attendees' },
      ],
      preflight_safe: false,
      preflight_alternative: null, // No safe alternative, must confirm before execution
    },
    GOOGLECALENDAR_FIND_EVENT: {
      enabled: true,
      provider: 'composio',
      composio_action: 'GOOGLECALENDAR_FIND_EVENT',
      category: 'calendar',
      mutating: false,
      irreversible: false,
      description: 'Search for existing calendar events',
      required_scopes: ['calendar.events.readonly'],
      user_facing_name: 'Find calendar events',
      examples: ['find my meeting', 'when is my next call', 'search calendar', "what's on my calendar"],
      // Side effect classification - Pure read, safe for preflight
      side_effect_tier: SIDE_EFFECT_TIERS.PURE_READ,
      side_effects: [],
      preflight_safe: true,
      preflight_alternative: null, // Already safe
    },
    GOOGLECALENDAR_UPDATE_EVENT: {
      enabled: true,
      provider: 'composio',
      composio_action: 'GOOGLECALENDAR_UPDATE_EVENT',
      category: 'calendar',
      mutating: true,
      irreversible: false,
      description: 'Modify an existing calendar event',
      required_scopes: ['calendar.events.write'],
      user_facing_name: 'Update calendar event',
      examples: ['reschedule meeting', 'change event time', 'update meeting'],
      // Side effect classification
      side_effect_tier: SIDE_EFFECT_TIERS.EXPLICIT_WRITE,
      side_effects: [
        { type: 'calendar_modification', description: 'Modifies existing event' },
        { type: 'notification', description: 'May notify attendees of changes' },
      ],
      preflight_safe: false,
      preflight_alternative: null,
    },
    GOOGLECALENDAR_DELETE_EVENT: {
      enabled: true,
      provider: 'composio',
      composio_action: 'GOOGLECALENDAR_DELETE_EVENT',
      category: 'calendar',
      mutating: true,
      irreversible: true,
      description: 'Delete a calendar event',
      required_scopes: ['calendar.events.write'],
      user_facing_name: 'Delete calendar event',
      examples: ['cancel meeting', 'delete event', 'remove from calendar'],
      // Side effect classification
      side_effect_tier: SIDE_EFFECT_TIERS.EXPLICIT_WRITE,
      side_effects: [
        { type: 'calendar_deletion', description: 'Permanently removes event' },
        { type: 'notification', description: 'May notify attendees of cancellation' },
      ],
      preflight_safe: false,
      preflight_alternative: null,
      requires_confirmation: true, // Extra flag for irreversible actions
    },
    GOOGLECALENDAR_FIND_FREE_SLOTS: {
      enabled: true,
      provider: 'composio',
      composio_action: 'GOOGLECALENDAR_FIND_FREE_SLOTS',
      category: 'calendar',
      mutating: false,
      irreversible: false,
      description: 'Find available time slots',
      required_scopes: ['calendar.events.readonly'],
      user_facing_name: 'Find free time',
      examples: ['when am I free', 'find available time', 'check availability'],
      // Side effect classification - Pure read
      side_effect_tier: SIDE_EFFECT_TIERS.PURE_READ,
      side_effects: [],
      preflight_safe: true,
      preflight_alternative: null,
    },

    // ========== GMAIL ==========
    GMAIL_SEND_EMAIL: {
      enabled: true,
      provider: 'composio',
      composio_action: 'GMAIL_SEND_EMAIL',
      category: 'email',
      mutating: true,
      irreversible: true,
      description: 'Send an email immediately',
      required_scopes: ['gmail.send'],
      user_facing_name: 'Send email',
      examples: ['send an email', 'email someone', 'mail this to'],
      // Side effect classification
      side_effect_tier: SIDE_EFFECT_TIERS.EXPLICIT_WRITE,
      side_effects: [
        { type: 'email_sent', description: 'Sends email to recipient(s)' },
        { type: 'sent_folder', description: 'Appears in sent folder' },
      ],
      preflight_safe: false,
      preflight_alternative: {
        action: 'GMAIL_CREATE_EMAIL_DRAFT',
        description: 'Create draft instead of sending',
      },
      requires_confirmation: true,
    },
    GMAIL_CREATE_EMAIL_DRAFT: {
      enabled: true,
      provider: 'composio',
      composio_action: 'GMAIL_CREATE_EMAIL_DRAFT',
      category: 'email',
      mutating: true,
      irreversible: false,
      description: 'Create an email draft to edit later',
      required_scopes: ['gmail.compose'],
      user_facing_name: 'Create email draft',
      examples: ['draft an email', 'save as draft', 'compose email'],
      // Side effect classification - Creates draft but doesn't send
      side_effect_tier: SIDE_EFFECT_TIERS.EXPLICIT_WRITE,
      side_effects: [
        { type: 'draft_created', description: 'Creates draft in drafts folder' },
      ],
      preflight_safe: false, // Still creates something
      preflight_alternative: null,
    },
    GMAIL_FETCH_EMAILS: {
      enabled: true,
      provider: 'composio',
      composio_action: 'GMAIL_FETCH_EMAILS',
      category: 'email',
      mutating: false,
      irreversible: false,
      description: 'Search for or retrieve emails',
      required_scopes: ['gmail.readonly'],
      user_facing_name: 'Search emails',
      examples: ['check my email', 'find emails from', 'search inbox'],
      // Side effect classification - IMPLICIT_WRITE due to read receipts
      side_effect_tier: SIDE_EFFECT_TIERS.IMPLICIT_WRITE,
      side_effects: [
        { type: 'read_status', description: 'May mark messages as read depending on API params' },
        { type: 'access_log', description: 'Access is logged by Gmail' },
      ],
      preflight_safe: false, // Not safe due to implicit side effects
      preflight_alternative: {
        action: 'GMAIL_FETCH_EMAILS',
        forced_params: { format: 'metadata', maxResults: 10 },
        description: 'Fetch metadata only, limited results',
      },
      sanitization_rules: {
        preflight: {
          format: 'metadata', // Force metadata-only during preflight
          maxResults: 10,     // Limit results
        },
      },
    },
    GMAIL_REPLY_TO_THREAD: {
      enabled: true,
      provider: 'composio',
      composio_action: 'GMAIL_REPLY_TO_THREAD',
      category: 'email',
      mutating: true,
      irreversible: true,
      description: 'Reply to an existing email thread',
      required_scopes: ['gmail.send'],
      user_facing_name: 'Reply to email',
      examples: ['reply to email', 'respond to message'],
      // Side effect classification
      side_effect_tier: SIDE_EFFECT_TIERS.EXPLICIT_WRITE,
      side_effects: [
        { type: 'email_sent', description: 'Sends reply email' },
        { type: 'thread_update', description: 'Updates email thread' },
      ],
      preflight_safe: false,
      preflight_alternative: null,
      requires_confirmation: true,
    },

    // ========== SLACK ==========
    SLACK_SEND_MESSAGE: {
      enabled: true,
      provider: 'composio',
      composio_action: 'SLACK_SEND_MESSAGE',
      category: 'messaging',
      mutating: true,
      irreversible: true,
      description: 'Send a message to a Slack channel or person',
      required_scopes: ['chat:write'],
      user_facing_name: 'Send Slack message',
      examples: ['send slack message', 'post in channel', 'message on slack'],
      // Side effect classification
      side_effect_tier: SIDE_EFFECT_TIERS.EXPLICIT_WRITE,
      side_effects: [
        { type: 'message_sent', description: 'Posts visible message' },
        { type: 'notification', description: 'May trigger notifications to channel members' },
      ],
      preflight_safe: false,
      preflight_alternative: null,
      requires_confirmation: true,
    },
    SLACK_LIST_CHANNELS: {
      enabled: true,
      provider: 'composio',
      composio_action: 'SLACK_LIST_CHANNELS',
      category: 'messaging',
      mutating: false,
      irreversible: false,
      description: 'List available Slack channels',
      required_scopes: ['channels:read'],
      user_facing_name: 'List Slack channels',
      examples: ['show channels', 'list slack channels'],
      // Side effect classification - Pure read
      side_effect_tier: SIDE_EFFECT_TIERS.PURE_READ,
      side_effects: [],
      preflight_safe: true,
      preflight_alternative: null,
    },

    // ========== JIRA ==========
    JIRA_CREATE_ISSUE: {
      enabled: true,
      provider: 'composio',
      composio_action: 'JIRA_CREATE_ISSUE',
      category: 'project_management',
      mutating: true,
      irreversible: false,
      description: 'Create a new Jira ticket/issue',
      required_scopes: ['write:jira-work'],
      user_facing_name: 'Create Jira ticket',
      examples: ['create jira ticket', 'log a bug', 'add issue'],
      // Side effect classification
      side_effect_tier: SIDE_EFFECT_TIERS.EXPLICIT_WRITE,
      side_effects: [
        { type: 'issue_created', description: 'Creates new Jira issue' },
        { type: 'notification', description: 'May notify project watchers' },
      ],
      preflight_safe: false,
      preflight_alternative: null,
    },
    JIRA_SEARCH_ISSUES: {
      enabled: true,
      provider: 'composio',
      composio_action: 'JIRA_SEARCH_ISSUES',
      category: 'project_management',
      mutating: false,
      irreversible: false,
      description: 'Search for and list Jira tickets/issues',
      required_scopes: ['read:jira-work'],
      user_facing_name: 'Search Jira tickets',
      examples: ['show my jira tickets', 'find issues', 'search jira', 'get all jira tickets', 'list jira issues', 'all tickets from jira'],
      // Side effect classification - Implicit write due to recent activity tracking
      side_effect_tier: SIDE_EFFECT_TIERS.IMPLICIT_WRITE,
      side_effects: [
        { type: 'recent_activity', description: 'Updates "recently viewed" list' },
        { type: 'access_log', description: 'Access logged in Jira audit trail' },
      ],
      preflight_safe: false,
      preflight_alternative: {
        action: 'JIRA_SEARCH_ISSUES',
        forced_params: { maxResults: 5, fields: ['key', 'summary', 'status'] },
        description: 'Search with limited results and fields',
      },
      sanitization_rules: {
        preflight: {
          maxResults: 5,
          fields: ['key', 'summary', 'status'],
        },
      },
    },
    JIRA_GET_ISSUE: {
      enabled: true,
      provider: 'composio',
      composio_action: 'JIRA_GET_ISSUE',
      category: 'project_management',
      mutating: false,
      irreversible: false,
      description: 'Get one Jira ticket by issue ID or key',
      required_scopes: ['read:jira-work'],
      user_facing_name: 'Get Jira ticket',
      examples: ['show SCRUM-1', 'get Jira issue', 'open ticket details'],
      side_effect_tier: SIDE_EFFECT_TIERS.PURE_READ,
      side_effects: [],
      preflight_safe: true,
      preflight_alternative: null,
    },
    JIRA_UPDATE_ISSUE: {
      enabled: true,
      provider: 'composio',
      composio_action: 'JIRA_UPDATE_ISSUE',
      category: 'project_management',
      mutating: true,
      irreversible: false,
      description: 'Update an existing Jira ticket',
      required_scopes: ['write:jira-work'],
      user_facing_name: 'Update Jira ticket',
      examples: ['update ticket', 'change issue status'],
      // Side effect classification
      side_effect_tier: SIDE_EFFECT_TIERS.EXPLICIT_WRITE,
      side_effects: [
        { type: 'issue_modified', description: 'Modifies existing issue' },
        { type: 'notification', description: 'May notify watchers of changes' },
        { type: 'history', description: 'Creates change history entry' },
      ],
      preflight_safe: false,
      preflight_alternative: null,
    },

    // ========== FRAPPE/ERPNEXT (Dynamic per-user) ==========
    // Note: Frappe actions are dynamically loaded from user's ERPNext instance
    // These are generic fallbacks for unconnected users or generic operations

    FRAPPE_LIST_DOCUMENTS: {
      enabled: true,
      provider: 'frappe',
      composio_action: null,
      category: 'erp',
      mutating: false,
      irreversible: false,
      description: 'List documents of any DocType from ERPNext',
      required_scopes: [],
      user_facing_name: 'List ERPNext documents',
      examples: ['list customers', 'show sales orders', 'get items'],
      side_effect_tier: SIDE_EFFECT_TIERS.PURE_READ,
      side_effects: [],
      preflight_safe: true,
      preflight_alternative: null,
    },
    FRAPPE_GET_DOCUMENT: {
      enabled: true,
      provider: 'frappe',
      composio_action: null,
      category: 'erp',
      mutating: false,
      irreversible: false,
      description: 'Get a specific document from ERPNext',
      required_scopes: [],
      user_facing_name: 'Get ERPNext document',
      examples: ['get customer details', 'show order'],
      side_effect_tier: SIDE_EFFECT_TIERS.PURE_READ,
      side_effects: [],
      preflight_safe: true,
      preflight_alternative: null,
    },
    FRAPPE_CREATE_DOCUMENT: {
      enabled: true,
      provider: 'frappe',
      composio_action: null,
      category: 'erp',
      mutating: true,
      irreversible: false,
      description: 'Create a new document in ERPNext',
      required_scopes: [],
      user_facing_name: 'Create ERPNext document',
      examples: ['create customer', 'add new item', 'create sales order'],
      side_effect_tier: SIDE_EFFECT_TIERS.EXPLICIT_WRITE,
      side_effects: [
        { type: 'document_created', description: 'Creates a new document in ERPNext' },
      ],
      preflight_safe: false,
      preflight_alternative: null,
    },
    FRAPPE_UPDATE_DOCUMENT: {
      enabled: true,
      provider: 'frappe',
      composio_action: null,
      category: 'erp',
      mutating: true,
      irreversible: false,
      description: 'Update an existing document in ERPNext',
      required_scopes: [],
      user_facing_name: 'Update ERPNext document',
      examples: ['update customer', 'change order status'],
      side_effect_tier: SIDE_EFFECT_TIERS.EXPLICIT_WRITE,
      side_effects: [
        { type: 'document_modified', description: 'Modifies existing document' },
      ],
      preflight_safe: false,
      preflight_alternative: null,
    },
    FRAPPE_DELETE_DOCUMENT: {
      enabled: true,
      provider: 'frappe',
      composio_action: null,
      category: 'erp',
      mutating: true,
      irreversible: true,
      description: 'Delete a document from ERPNext',
      required_scopes: [],
      user_facing_name: 'Delete ERPNext document',
      examples: ['delete customer', 'remove item'],
      side_effect_tier: SIDE_EFFECT_TIERS.EXPLICIT_WRITE,
      side_effects: [
        { type: 'document_deleted', description: 'Permanently removes document' },
      ],
      preflight_safe: false,
      preflight_alternative: null,
    },
    FRAPPE_LIST_CUSTOMERS: {
      enabled: true,
      provider: 'frappe',
      composio_action: null,
      category: 'erp',
      mutating: false,
      irreversible: false,
      description: 'List customers from ERPNext',
      required_scopes: [],
      user_facing_name: 'List customers',
      examples: ['show customers', 'list all customers', 'get customer list'],
      side_effect_tier: SIDE_EFFECT_TIERS.PURE_READ,
      side_effects: [],
      preflight_safe: true,
      preflight_alternative: null,
    },
    FRAPPE_CREATE_CUSTOMER: {
      enabled: true,
      provider: 'frappe',
      composio_action: null,
      category: 'erp',
      mutating: true,
      irreversible: false,
      description: 'Create a new customer in ERPNext',
      required_scopes: [],
      user_facing_name: 'Create customer',
      examples: ['add customer', 'create new customer', 'register customer'],
      side_effect_tier: SIDE_EFFECT_TIERS.EXPLICIT_WRITE,
      side_effects: [
        { type: 'customer_created', description: 'Creates a new customer record' },
      ],
      preflight_safe: false,
      preflight_alternative: null,
    },
    FRAPPE_LIST_ITEMS: {
      enabled: true,
      provider: 'frappe',
      composio_action: null,
      category: 'erp',
      mutating: false,
      irreversible: false,
      description: 'List items/products from ERPNext',
      required_scopes: [],
      user_facing_name: 'List items',
      examples: ['show items', 'list products', 'get inventory'],
      side_effect_tier: SIDE_EFFECT_TIERS.PURE_READ,
      side_effects: [],
      preflight_safe: true,
      preflight_alternative: null,
    },
    FRAPPE_LIST_SALES_ORDERS: {
      enabled: true,
      provider: 'frappe',
      composio_action: null,
      category: 'erp',
      mutating: false,
      irreversible: false,
      description: 'List sales orders from ERPNext',
      required_scopes: [],
      user_facing_name: 'List sales orders',
      examples: ['show orders', 'list sales', 'get pending orders'],
      side_effect_tier: SIDE_EFFECT_TIERS.PURE_READ,
      side_effects: [],
      preflight_safe: true,
      preflight_alternative: null,
    },
    FRAPPE_CREATE_SALES_ORDER: {
      enabled: true,
      provider: 'frappe',
      composio_action: null,
      category: 'erp',
      mutating: true,
      irreversible: false,
      description: 'Create a sales order in ERPNext',
      required_scopes: [],
      user_facing_name: 'Create sales order',
      examples: ['create order', 'new sales order', 'place order'],
      side_effect_tier: SIDE_EFFECT_TIERS.EXPLICIT_WRITE,
      side_effects: [
        { type: 'order_created', description: 'Creates a new sales order' },
      ],
      preflight_safe: false,
      preflight_alternative: null,
    },
    FRAPPE_LIST_EMPLOYEES: {
      enabled: true,
      provider: 'frappe',
      composio_action: null,
      category: 'erp',
      mutating: false,
      irreversible: false,
      description: 'List employees from ERPNext HR module',
      required_scopes: [],
      user_facing_name: 'List employees',
      examples: ['show employees', 'list staff', 'get team members'],
      side_effect_tier: SIDE_EFFECT_TIERS.PURE_READ,
      side_effects: [],
      preflight_safe: true,
      preflight_alternative: null,
    },
    FRAPPE_LIST_TASKS: {
      enabled: true,
      provider: 'frappe',
      composio_action: null,
      category: 'erp',
      mutating: false,
      irreversible: false,
      description: 'List tasks from ERPNext Projects module',
      required_scopes: [],
      user_facing_name: 'List tasks',
      examples: ['show tasks', 'list project tasks', 'get my tasks'],
      side_effect_tier: SIDE_EFFECT_TIERS.PURE_READ,
      side_effects: [],
      preflight_safe: true,
      preflight_alternative: null,
    },
    FRAPPE_CREATE_TASK: {
      enabled: true,
      provider: 'frappe',
      composio_action: null,
      category: 'erp',
      mutating: true,
      irreversible: false,
      description: 'Create a task in ERPNext',
      required_scopes: [],
      user_facing_name: 'Create task',
      examples: ['add task', 'create new task', 'assign task'],
      side_effect_tier: SIDE_EFFECT_TIERS.EXPLICIT_WRITE,
      side_effects: [
        { type: 'task_created', description: 'Creates a new task' },
      ],
      preflight_safe: false,
      preflight_alternative: null,
    },
    FRAPPE_CREATE_ITEM: {
      enabled: true,
      provider: 'frappe',
      composio_action: null,
      category: 'erp',
      mutating: true,
      irreversible: false,
      description: 'Create a new item/product in ERPNext inventory',
      required_scopes: [],
      user_facing_name: 'Create item',
      examples: ['add item', 'create product', 'add to inventory'],
      side_effect_tier: SIDE_EFFECT_TIERS.EXPLICIT_WRITE,
      side_effects: [
        { type: 'item_created', description: 'Creates a new item in inventory' },
      ],
      preflight_safe: false,
      preflight_alternative: null,
      requires_confirmation: true,
    },
    FRAPPE_GET_CUSTOMER: {
      enabled: true,
      provider: 'frappe',
      composio_action: null,
      category: 'erp',
      mutating: false,
      irreversible: false,
      description: 'Get details of a specific customer from ERPNext',
      required_scopes: [],
      user_facing_name: 'Get customer details',
      examples: ['show customer', 'get customer info', 'customer details'],
      side_effect_tier: SIDE_EFFECT_TIERS.PURE_READ,
      side_effects: [],
      preflight_safe: true,
      preflight_alternative: null,
    },
    FRAPPE_GET_STOCK: {
      enabled: true,
      provider: 'frappe',
      composio_action: null,
      category: 'erp',
      mutating: false,
      irreversible: false,
      description: 'Get stock levels for items in ERPNext',
      required_scopes: [],
      user_facing_name: 'Check stock levels',
      examples: ['check stock', 'inventory levels', 'how much stock'],
      side_effect_tier: SIDE_EFFECT_TIERS.PURE_READ,
      side_effects: [],
      preflight_safe: true,
      preflight_alternative: null,
    },
    FRAPPE_LIST_SALES_INVOICES: {
      enabled: true,
      provider: 'frappe',
      composio_action: null,
      category: 'erp',
      mutating: false,
      irreversible: false,
      description: 'List sales invoices from ERPNext',
      required_scopes: [],
      user_facing_name: 'List sales invoices',
      examples: ['show invoices', 'list billing', 'get invoices'],
      side_effect_tier: SIDE_EFFECT_TIERS.PURE_READ,
      side_effects: [],
      preflight_safe: true,
      preflight_alternative: null,
    },
    FRAPPE_CREATE_SALES_INVOICE: {
      enabled: true,
      provider: 'frappe',
      composio_action: null,
      category: 'erp',
      mutating: true,
      irreversible: false,
      description: 'Create a sales invoice in ERPNext',
      required_scopes: [],
      user_facing_name: 'Create sales invoice',
      examples: ['create invoice', 'generate bill', 'new invoice'],
      side_effect_tier: SIDE_EFFECT_TIERS.EXPLICIT_WRITE,
      side_effects: [
        { type: 'invoice_created', description: 'Creates a financial transaction' },
        { type: 'accounting_entry', description: 'Creates ledger entries' },
      ],
      preflight_safe: false,
      preflight_alternative: null,
      requires_confirmation: true,
    },
    FRAPPE_LIST_SUPPLIERS: {
      enabled: true,
      provider: 'frappe',
      composio_action: null,
      category: 'erp',
      mutating: false,
      irreversible: false,
      description: 'List suppliers from ERPNext',
      required_scopes: [],
      user_facing_name: 'List suppliers',
      examples: ['show suppliers', 'list vendors', 'get suppliers'],
      side_effect_tier: SIDE_EFFECT_TIERS.PURE_READ,
      side_effects: [],
      preflight_safe: true,
      preflight_alternative: null,
    },
    FRAPPE_CREATE_SUPPLIER: {
      enabled: true,
      provider: 'frappe',
      composio_action: null,
      category: 'erp',
      mutating: true,
      irreversible: false,
      description: 'Create a new supplier in ERPNext',
      required_scopes: [],
      user_facing_name: 'Create supplier',
      examples: ['add supplier', 'create vendor', 'new supplier'],
      side_effect_tier: SIDE_EFFECT_TIERS.EXPLICIT_WRITE,
      side_effects: [
        { type: 'supplier_created', description: 'Creates a new supplier record' },
      ],
      preflight_safe: false,
      preflight_alternative: null,
      requires_confirmation: true,
    },
    FRAPPE_LIST_PROJECTS: {
      enabled: true,
      provider: 'frappe',
      composio_action: null,
      category: 'erp',
      mutating: false,
      irreversible: false,
      description: 'List projects from ERPNext',
      required_scopes: [],
      user_facing_name: 'List projects',
      examples: ['show projects', 'list all projects', 'get projects'],
      side_effect_tier: SIDE_EFFECT_TIERS.PURE_READ,
      side_effects: [],
      preflight_safe: true,
      preflight_alternative: null,
    },
    FRAPPE_CREATE_PROJECT: {
      enabled: true,
      provider: 'frappe',
      composio_action: null,
      category: 'erp',
      mutating: true,
      irreversible: false,
      description: 'Create a new project in ERPNext',
      required_scopes: [],
      user_facing_name: 'Create project',
      examples: ['add project', 'create new project', 'start project'],
      side_effect_tier: SIDE_EFFECT_TIERS.EXPLICIT_WRITE,
      side_effects: [
        { type: 'project_created', description: 'Creates a new project' },
      ],
      preflight_safe: false,
      preflight_alternative: null,
      requires_confirmation: true,
    },
    FRAPPE_UPDATE_TASK: {
      enabled: true,
      provider: 'frappe',
      composio_action: null,
      category: 'erp',
      mutating: true,
      irreversible: false,
      description: 'Update an existing task in ERPNext',
      required_scopes: [],
      user_facing_name: 'Update task',
      examples: ['update task', 'change task status', 'modify task'],
      side_effect_tier: SIDE_EFFECT_TIERS.EXPLICIT_WRITE,
      side_effects: [
        { type: 'task_modified', description: 'Modifies existing task' },
      ],
      preflight_safe: false,
      preflight_alternative: null,
    },
    FRAPPE_LIST_LEAVE_APPLICATIONS: {
      enabled: true,
      provider: 'frappe',
      composio_action: null,
      category: 'erp',
      mutating: false,
      irreversible: false,
      description: 'List leave applications from ERPNext HR',
      required_scopes: [],
      user_facing_name: 'List leave applications',
      examples: ['show leave requests', 'list time off', 'pending leaves'],
      side_effect_tier: SIDE_EFFECT_TIERS.PURE_READ,
      side_effects: [],
      preflight_safe: true,
      preflight_alternative: null,
    },
    FRAPPE_CREATE_LEAVE_APPLICATION: {
      enabled: true,
      provider: 'frappe',
      composio_action: null,
      category: 'erp',
      mutating: true,
      irreversible: false,
      description: 'Create a leave application in ERPNext',
      required_scopes: [],
      user_facing_name: 'Request leave',
      examples: ['apply for leave', 'request time off', 'book vacation'],
      side_effect_tier: SIDE_EFFECT_TIERS.EXPLICIT_WRITE,
      side_effects: [
        { type: 'leave_requested', description: 'Creates leave application for approval' },
      ],
      preflight_safe: false,
      preflight_alternative: null,
      requires_confirmation: true,
    },
    FRAPPE_LIST_PURCHASE_ORDERS: {
      enabled: true,
      provider: 'frappe',
      composio_action: null,
      category: 'erp',
      mutating: false,
      irreversible: false,
      description: 'List purchase orders from ERPNext',
      required_scopes: [],
      user_facing_name: 'List purchase orders',
      examples: ['show purchase orders', 'list POs', 'pending purchases'],
      side_effect_tier: SIDE_EFFECT_TIERS.PURE_READ,
      side_effects: [],
      preflight_safe: true,
      preflight_alternative: null,
    },
    FRAPPE_CALL_METHOD: {
      enabled: true,
      provider: 'frappe',
      composio_action: null,
      category: 'erp',
      mutating: true,
      irreversible: false,
      description: 'Call a custom Frappe/ERPNext API method',
      required_scopes: [],
      user_facing_name: 'Call ERPNext method',
      examples: ['run frappe method', 'execute API'],
      side_effect_tier: SIDE_EFFECT_TIERS.EXPLICIT_WRITE,
      side_effects: [
        { type: 'custom_action', description: 'Executes custom server-side method' },
      ],
      preflight_safe: false,
      preflight_alternative: null,
    },
  },
};

// Native Google Workspace actions use the same safety policy as Composio
// actions. Keeping them in the central registry ensures writes are confirmed
// and read-only operations remain safe for preflight execution.
const NATIVE_GOOGLE_ACTIONS = {
  GOOGLEDRIVE_SEARCH_FILES: ['Search Google Drive files', false],
  GOOGLEDRIVE_GET_FILE: ['Get Google Drive file metadata', false],
  GOOGLEDRIVE_CREATE_FOLDER: ['Create Google Drive folder', true],
  GOOGLEDRIVE_CREATE_FILE: ['Create Google Drive file', true],
  GOOGLEDOCS_CREATE_DOCUMENT: ['Create Google document', true],
  GOOGLEDOCS_GET_DOCUMENT: ['Read Google document', false],
  GOOGLEDOCS_APPEND_TEXT: ['Append text to Google document', true],
  GOOGLESHEETS_CREATE_SPREADSHEET: ['Create Google spreadsheet', true],
  GOOGLESHEETS_GET_VALUES: ['Read Google Sheet values', false],
  GOOGLESHEETS_APPEND_VALUES: ['Append Google Sheet values', true],
  GOOGLESHEETS_UPDATE_VALUES: ['Update Google Sheet values', true],
};

for (const [action, [name, mutating]] of Object.entries(NATIVE_GOOGLE_ACTIONS)) {
  ACTION_ALLOWLIST.actions[action] = {
    enabled: true,
    provider: 'google_workspace',
    composio_action: action,
    category: action.startsWith('GOOGLEDRIVE_') ? 'storage' : 'document',
    mutating,
    irreversible: false,
    description: name,
    required_scopes: [],
    user_facing_name: name,
    examples: [],
    side_effect_tier: mutating ? SIDE_EFFECT_TIERS.EXPLICIT_WRITE : SIDE_EFFECT_TIERS.PURE_READ,
    side_effects: mutating ? [{ type: 'google_workspace_change', description: name }] : [],
    preflight_safe: !mutating,
    preflight_alternative: null,
    requires_confirmation: mutating,
  };
}

// ============================================
// COMPONENT 2: VERSIONED ALIAS MAP
// Handle deprecated or renamed actions safely
// ============================================
const ALIAS_MAP = {
  schema_version: '1.0',
  aliases: {
    // Calendar aliases
    GOOGLECALENDAR_LIST_EVENTS: {
      canonical: 'GOOGLECALENDAR_FIND_EVENT',
      type: 'deprecated',
      since: '2025-01-15',
      until: null,
      reason: 'Composio unified list/search into FIND_EVENT in v2.3',
      breaking_change: false,
      migration_notes: 'Parameters are compatible, no changes needed',
    },
    GOOGLECALENDAR_GET_EVENTS: {
      canonical: 'GOOGLECALENDAR_FIND_EVENT',
      type: 'alias',
      since: '2024-06-01',
      until: null,
      reason: 'Internal naming convention',
      breaking_change: false,
    },
    GOOGLECALENDAR_SCHEDULE_MEETING: {
      canonical: 'GOOGLECALENDAR_CREATE_EVENT',
      type: 'alias',
      since: '2024-06-01',
      until: null,
      reason: 'Internal naming - both refer to same Composio action',
      breaking_change: false,
    },
    GOOGLE_CALENDAR_CREATE_EVENT: {
      canonical: 'GOOGLECALENDAR_CREATE_EVENT',
      type: 'alias',
      since: '2024-01-01',
      until: null,
      reason: 'Wrong underscore placement',
      breaking_change: false,
    },

    // Gmail aliases
    GMAIL_LIST_EMAILS: {
      canonical: 'GMAIL_FETCH_EMAILS',
      type: 'alias',
      since: '2024-06-01',
      until: null,
      reason: 'Composio uses FETCH not LIST',
      breaking_change: false,
    },
    GMAIL_GET_EMAILS: {
      canonical: 'GMAIL_FETCH_EMAILS',
      type: 'alias',
      since: '2024-06-01',
      until: null,
      reason: 'Composio uses FETCH not GET',
      breaking_change: false,
    },
    GMAIL_SEARCH_EMAILS: {
      canonical: 'GMAIL_FETCH_EMAILS',
      type: 'alias',
      since: '2024-06-01',
      until: null,
      reason: 'FETCH supports search via query param',
      breaking_change: false,
    },
    GMAIL_REPLY_TO_EMAIL: {
      canonical: 'GMAIL_REPLY_TO_THREAD',
      type: 'deprecated',
      since: '2026-10-25',
      until: null,
      reason: 'Installed Composio Gmail toolkit uses REPLY_TO_THREAD',
      breaking_change: false,
      migration_notes: 'Provide thread_id, recipient_email, and message_body.',
    },

    // Slack aliases
    SLACK_SEND_CHANNEL_MESSAGE: {
      canonical: 'SLACK_SEND_MESSAGE',
      type: 'deprecated',
      since: '2025-01-01',
      until: '2025-06-01',
      reason: 'Unified into SEND_MESSAGE which handles both channel and DM',
      breaking_change: false,
    },
    SLACK_POST_MESSAGE: {
      canonical: 'SLACK_SEND_MESSAGE',
      type: 'alias',
      since: '2024-06-01',
      until: null,
      reason: 'Internal naming convention',
      breaking_change: false,
    },

    // Jira aliases
    JIRA_LIST_ISSUES: {
      canonical: 'JIRA_SEARCH_ISSUES',
      type: 'alias',
      since: '2024-06-01',
      until: null,
      reason: 'Composio uses SEARCH not LIST',
      breaking_change: false,
    },
    JIRA_FIND_ISSUES: {
      canonical: 'JIRA_SEARCH_ISSUES',
      type: 'alias',
      since: '2024-06-01',
      until: null,
      reason: 'Composio uses SEARCH not FIND',
      breaking_change: false,
    },
  },

  removed: {
    GOOGLECALENDAR_QUICK_ADD: {
      removed_on: '2025-02-01',
      reason: 'Composio removed this action',
      replacement: 'GOOGLECALENDAR_CREATE_EVENT',
      migration_notes: 'Use CREATE_EVENT with natural language in description field',
    },
  },
};

// ============================================
// COMPONENT 3: SIMILARITY MATCHER
// For suggestions on typos (NEVER auto-correct)
// ============================================

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(str1, str2) {
  const m = str1.length;
  const n = str2.length;
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }

  return dp[m][n];
}

/**
 * Calculate Jaro-Winkler similarity (better for prefix matches)
 */
function jaroWinklerSimilarity(s1, s2) {
  if (s1 === s2) return 1.0;

  const len1 = s1.length;
  const len2 = s2.length;

  if (len1 === 0 || len2 === 0) return 0.0;

  const matchDistance = Math.floor(Math.max(len1, len2) / 2) - 1;
  const s1Matches = new Array(len1).fill(false);
  const s2Matches = new Array(len2).fill(false);

  let matches = 0;
  let transpositions = 0;

  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, len2);

    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0.0;

  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  const jaro = (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3;

  // Winkler modification for common prefix
  let prefix = 0;
  for (let i = 0; i < Math.min(4, Math.min(len1, len2)); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }

  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * Find similar actions for suggestions
 */
function findSimilarActions(input, allowlist) {
  const normalized = input.toUpperCase().replace(/\s+/g, '_');
  const suggestions = [];

  for (const action of Object.keys(allowlist)) {
    if (!allowlist[action].enabled) continue;

    const similarity = jaroWinklerSimilarity(normalized, action);
    const distance = levenshteinDistance(normalized, action);

    // Also check for common typo patterns
    let bonusScore = 0;

    // Missing underscore: GMAILSENDEMAIL vs GMAIL_SEND_EMAIL
    if (normalized.replace(/_/g, '') === action.replace(/_/g, '')) {
      bonusScore = 0.3;
    }

    // Wrong provider separator: GOOGLE_CALENDAR vs GOOGLECALENDAR
    if (normalized.replace(/GOOGLE_/, 'GOOGLE') === action.replace(/GOOGLE_/, 'GOOGLE')) {
      bonusScore = 0.2;
    }

    // Plural/singular: EVENTS vs EVENT
    if (normalized.replace(/S$/, '') === action.replace(/S$/, '')) {
      bonusScore = 0.15;
    }

    const finalScore = Math.min(1.0, similarity + bonusScore);

    if (finalScore > 0.5) {
      suggestions.push({
        action,
        similarity: finalScore,
        distance,
        description: allowlist[action].description,
        user_facing_name: allowlist[action].user_facing_name,
      });
    }
  }

  // Sort by similarity descending
  return suggestions.sort((a, b) => b.similarity - a.similarity).slice(0, 3);
}

// ============================================
// COMPONENT 4: RESOLUTION PIPELINE
// ============================================

class ActionRegistry {
  /**
   * Resolve an action slug through the full pipeline
   * @param {string} inputSlug - The action name to resolve
   * @returns {Object} Resolution result
   */
  static resolve(inputSlug) {
    if (!inputSlug) {
      return {
        success: false,
        error: {
          type: 'ACTION_REQUIRED',
          message: 'Action slug is required',
        },
      };
    }

    // Step 1: Normalize input
    const normalized = inputSlug.toUpperCase().trim();

    // Step 2: Check exact match in allowlist
    if (ACTION_ALLOWLIST.actions[normalized]) {
      const action = ACTION_ALLOWLIST.actions[normalized];

      if (action.enabled) {
        return {
          success: true,
          action: normalized,
          metadata: {
            category: action.category,
            mutating: action.mutating,
            irreversible: action.irreversible,
            user_facing_name: action.user_facing_name,
          },
        };
      } else {
        return {
          success: false,
          error: {
            type: 'ACTION_DISABLED',
            message: `'${action.user_facing_name}' is currently disabled`,
            action: normalized,
          },
        };
      }
    }

    // Step 3: Check alias map
    if (ALIAS_MAP.aliases[normalized]) {
      const alias = ALIAS_MAP.aliases[normalized];
      const canonical = alias.canonical;

      // Log based on alias type
      if (alias.type === 'deprecated') {
        console.warn(`[ActionRegistry] DEPRECATED: '${normalized}' → '${canonical}'. Reason: ${alias.reason}`);
      } else {
        console.log(`[ActionRegistry] Alias resolved: '${normalized}' → '${canonical}'`);
      }

      // Verify canonical exists and is enabled
      if (ACTION_ALLOWLIST.actions[canonical]?.enabled) {
        const action = ACTION_ALLOWLIST.actions[canonical];

        return {
          success: true,
          action: canonical,
          resolved_from: normalized,
          alias_type: alias.type,
          deprecation_warning: alias.type === 'deprecated' ? {
            message: `'${normalized}' is deprecated, using '${canonical}'`,
            reason: alias.reason,
            since: alias.since,
            until: alias.until,
          } : null,
          metadata: {
            category: action.category,
            mutating: action.mutating,
            irreversible: action.irreversible,
            user_facing_name: action.user_facing_name,
          },
        };
      } else {
        return {
          success: false,
          error: {
            type: 'ALIAS_TARGET_INVALID',
            message: `Alias '${normalized}' points to '${canonical}' which is not available`,
          },
        };
      }
    }

    // Step 4: Check removed actions
    if (ALIAS_MAP.removed[normalized]) {
      const removed = ALIAS_MAP.removed[normalized];

      return {
        success: false,
        error: {
          type: 'ACTION_REMOVED',
          message: `'${normalized}' was removed on ${removed.removed_on}`,
          reason: removed.reason,
          replacement: removed.replacement,
          migration_notes: removed.migration_notes,
        },
      };
    }

    // Step 5: Find similar actions (suggestions)
    const suggestions = findSimilarActions(normalized, ACTION_ALLOWLIST.actions);

    if (suggestions.length > 0 && suggestions[0].similarity > 0.6) {
      return {
        success: false,
        error: {
          type: 'ACTION_NOT_FOUND_WITH_SUGGESTIONS',
          message: `Unknown action '${normalized}'`,
          input: inputSlug,
          suggestions: suggestions.map(s => ({
            action: s.action,
            similarity: Math.round(s.similarity * 100) + '%',
            name: s.user_facing_name,
            description: s.description,
          })),
          hint: 'Did you mean one of these?',
        },
      };
    }

    // Step 6: No match, no suggestions - return capability list
    return {
      success: false,
      error: {
        type: 'ACTION_NOT_FOUND',
        message: `Unknown action '${normalized}'`,
        input: inputSlug,
        available_actions: this.getCapabilitySummary(),
        hint: "Here's what I can do:",
      },
    };
  }

  /**
   * Simple resolution - returns canonical action or null
   * For backward compatibility
   */
  static resolveAction(actionName) {
    const result = this.resolve(actionName);

    if (result.success) {
      return result.action;
    }

    // Log the error for debugging
    if (result.error.type === 'ACTION_NOT_FOUND_WITH_SUGGESTIONS') {
      console.warn(`[ActionRegistry] Unknown action '${actionName}'. Suggestions:`,
        result.error.suggestions.map(s => s.action));
    }

    return actionName; // Return as-is for backward compatibility
  }

  /**
   * Resolve multiple actions
   */
  static resolveActions(actions) {
    if (!Array.isArray(actions)) return [];
    return actions.map(a => this.resolveAction(a)).filter(Boolean);
  }

  /**
   * Check if an action is valid (exists and enabled)
   */
  static isValidAction(actionName) {
    const result = this.resolve(actionName);
    return result.success;
  }

  /**
   * Get action metadata
   */
  static getActionMetadata(actionName) {
    const result = this.resolve(actionName);
    if (result.success) {
      return ACTION_ALLOWLIST.actions[result.action];
    }
    return null;
  }

  /**
   * Check if action is mutating (write operation)
   */
  static isMutating(actionName) {
    const metadata = this.getActionMetadata(actionName);
    return metadata?.mutating ?? true; // Default to true for safety
  }

  /**
   * Check if action is irreversible
   */
  static isIrreversible(actionName) {
    const metadata = this.getActionMetadata(actionName);
    return metadata?.irreversible ?? false;
  }

  /**
   * Get all enabled actions for a category
   */
  static getActionsByCategory(category) {
    return Object.entries(ACTION_ALLOWLIST.actions)
      .filter(([_, action]) => action.enabled && action.category === category)
      .map(([name, action]) => ({
        action: name,
        name: action.user_facing_name,
        description: action.description,
      }));
  }

  /**
   * Get capability summary for error messages
   */
  static getCapabilitySummary() {
    const categories = {};

    for (const [name, action] of Object.entries(ACTION_ALLOWLIST.actions)) {
      if (!action.enabled) continue;

      if (!categories[action.category]) {
        categories[action.category] = [];
      }

      categories[action.category].push({
        action: name,
        name: action.user_facing_name,
      });
    }

    return categories;
  }

  /**
   * Get user-friendly capability list
   */
  static getCapabilityListForUser() {
    const summary = this.getCapabilitySummary();
    const categoryEmojis = {
      calendar: '📅',
      email: '📧',
      messaging: '💬',
      project_management: '📋',
    };

    let message = '';
    for (const [category, actions] of Object.entries(summary)) {
      const emoji = categoryEmojis[category] || '🔧';
      const categoryName = category.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      message += `\n${emoji} **${categoryName}:**\n`;

      for (const action of actions) {
        message += `  • ${action.name}\n`;
      }
    }

    return message;
  }

  /**
   * Validate parameters for an action
   */
  static validateActionParams(actionName, params) {
    const result = this.resolve(actionName);
    if (!result.success) {
      return { valid: false, errors: [result.error.message] };
    }

    const errors = [];
    const action = result.action;

    // Action-specific validations
    if (action.includes('CREATE_EVENT') || action.includes('FIND_EVENT')) {
      if (params.start_datetime && !this.isValidISO(params.start_datetime)) {
        errors.push(`start_datetime must be ISO format, got: ${params.start_datetime}`);
      }
      if (params.end_datetime && !this.isValidISO(params.end_datetime)) {
        errors.push(`end_datetime must be ISO format, got: ${params.end_datetime}`);
      }
    }

    if (action.includes('SEND_EMAIL')) {
      if (params.to && !this.isValidEmail(params.to)) {
        errors.push(`to must be a valid email address, got: ${params.to}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      resolvedAction: action,
    };
  }

  static isValidISO(str) {
    if (!str) return false;
    const date = new Date(str);
    return !isNaN(date.getTime()) && str.includes('T');
  }

  static isValidEmail(str) {
    if (!str) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str);
  }

  /**
   * Get allowlist version info
   */
  static getVersion() {
    return {
      allowlist_version: ACTION_ALLOWLIST.version,
      alias_schema_version: ALIAS_MAP.schema_version,
      last_updated: ACTION_ALLOWLIST.last_updated,
    };
  }
}

module.exports = {
  ActionRegistry,
  ACTION_ALLOWLIST,
  ALIAS_MAP,
  SIDE_EFFECT_TIERS,
  EXECUTION_PHASES,
  findSimilarActions,
  jaroWinklerSimilarity,
  levenshteinDistance,
};
