/**
 * Frappe Integration Module
 *
 * Exports all Frappe-related functionality for:
 * - Per-user connection management
 * - Dynamic schema fetching
 * - API client for CRUD operations
 * - Static action definitions (legacy)
 */

// Legacy static service (for backward compatibility)
const { FrappeService, FRAPPE_ACTIONS, FRAPPE_ACTION_NAMES } = require('./frappeService');

// New per-user connection management
const {
  FrappeConnectionManager,
  frappeConnectionManager,
  encrypt,
  decrypt
} = require('./FrappeConnectionManager');

// Dynamic schema service
const {
  FrappeSchemaService,
  frappeSchemaService,
  PRIORITY_DOCTYPES,
  FIELD_TYPE_MAP
} = require('./FrappeSchemaService');

// Per-user API client
const {
  FrappeClient,
  createFrappeClient,
  executeFrappeAction
} = require('./FrappeClient');
const { FrappeMcpProvider, frappeMcpProvider } = require('./FrappeMcpProvider');
const { FrappeProviderService, frappeProviderService } = require('./FrappeProviderService');

module.exports = {
  // Legacy exports (backward compatible)
  FrappeService,
  FRAPPE_ACTIONS,
  FRAPPE_ACTION_NAMES,

  // Connection management
  FrappeConnectionManager,
  frappeConnectionManager,

  // Schema service
  FrappeSchemaService,
  frappeSchemaService,
  PRIORITY_DOCTYPES,
  FIELD_TYPE_MAP,

  // API client
  FrappeClient,
  createFrappeClient,
  executeFrappeAction,

  // Provider-neutral execution (MCP preferred, native REST optional)
  FrappeMcpProvider,
  frappeMcpProvider,
  FrappeProviderService,
  frappeProviderService,

  // Utility exports
  encrypt,
  decrypt
};
