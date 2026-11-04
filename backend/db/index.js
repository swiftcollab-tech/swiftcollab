// Database connection using pg (PostgreSQL)
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Allow self-signed certificates for Supabase pooler connections
if (process.env.NODE_ENV !== 'production') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const { Pool } = require('pg');

// Prefer explicit DATABASE_URL, otherwise fall back to common Supabase env names
const connectionString =
  process.env.DATABASE_URL ||
  process.env.SUPABASE_DATABASE_URL ||
  process.env.SUPABASE_POSTGRES_URL ||
  process.env.SUPABASE_DB_URL;

if (!connectionString) {
  console.warn('[DB] DATABASE_URL not set. Backend will run without DB.');
}

// Changes made to connect to my local posgressql db
const sslConfig = process.env.DB_SSL === 'true'
  ? { rejectUnauthorized: false }
  : false;

// Connection string format: postgresql://user:password@host:port/database
const pool = connectionString
  ? new Pool({
      connectionString,
      ssl: sslConfig,
      max: 20, // Maximum number of clients in the pool
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    })
  : null;

// Test connection
if (pool) {
  pool.on('connect', () => {
    try {
      const maskedHost = new URL(connectionString).hostname;
      console.log(`[DB] Connected to PostgreSQL (${maskedHost})`);
    } catch {
      console.log('[DB] Connected to PostgreSQL');
    }
  });

  pool.on('error', (err) => {
    console.error('[DB] Unexpected error on idle client', err);
  });
}

// Query helper with logging
async function query(text, params) {
  if (!pool) {
    throw new Error('Database is not configured (missing DATABASE_URL)');
  }
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    if (process.env.NODE_ENV !== 'production') {
      console.log('[DB] Query executed', { text: text.substring(0, 50), duration, rows: result.rowCount });
    }
    return result;
  } catch (error) {
    console.error('[DB] Query error', { text: text.substring(0, 50), error: error.message });
    throw error;
  }
}

// Get a client from the pool (for transactions)
async function getClient() {
  if (!pool) {
    throw new Error('Database is not configured (missing DATABASE_URL)');
  }
  const client = await pool.connect();
  const originalQuery = client.query.bind(client);
  const originalRelease = client.release.bind(client);

  // Timeout to release client if forgotten
  const timeout = setTimeout(() => {
    console.error('[DB] Client has been checked out for too long');
    client.release();
  }, 30000);

  client.query = (...args) => {
    return originalQuery(...args);
  };

  client.release = () => {
    clearTimeout(timeout);
    return originalRelease();
  };

  return client;
}

// Initialize database (create tables if not exist)
async function initializeDatabase() {
  const fs = require('fs');
  const path = require('path');

  try {
    // Initialize main schema
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    await pool.query(schema);
    console.log('[DB] Database schema initialized');

    // Apply organization and feature migrations before extension schemas that
    // reference those tables. Dynamic loading avoids a module cycle at startup.
    const { runMigrations } = require('./migrate');
    await runMigrations();

    // Initialize orchestration schema
    const orchestrationSchemaPath = path.join(__dirname, 'orchestration-schema.sql');
    if (fs.existsSync(orchestrationSchemaPath)) {
      const orchestrationSchema = fs.readFileSync(orchestrationSchemaPath, 'utf8');
      await pool.query(orchestrationSchema);
      console.log('[DB] Orchestration schema initialized');
    }

    // Initialize Frappe integration schema
    const frappeSchemaPath = path.join(__dirname, 'frappe-schema.sql');
    if (fs.existsSync(frappeSchemaPath)) {
      const frappeSchema = fs.readFileSync(frappeSchemaPath, 'utf8');
      await pool.query(frappeSchema);
      console.log('[DB] Frappe integration schema initialized');
    }
  } catch (error) {
    console.error('[DB] Failed to initialize database:', error.message);
    // Don't throw - tables might already exist
  }
}

module.exports = {
  pool,
  query,
  getClient,
  initializeDatabase,
};
