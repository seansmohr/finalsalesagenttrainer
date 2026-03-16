const Database = require("better-sqlite3");
const path = require("path");
const bcrypt = require("bcrypt");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "training.db");
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ── Schema ──
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'agent' CHECK(role IN ('agent', 'admin')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS call_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    persona_id TEXT NOT NULL,
    persona_name TEXT NOT NULL,
    result TEXT NOT NULL CHECK(result IN ('violation', 'success', 'incomplete')),
    violation_type TEXT,
    section_reached INTEGER,
    expected_section INTEGER,
    description TEXT,
    duration_seconds INTEGER,
    transcript TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_attempts_user ON call_attempts(user_id);
  CREATE INDEX IF NOT EXISTS idx_attempts_persona ON call_attempts(persona_id);
`);

// ── User helpers ──

const SALT_ROUNDS = 10;

function createUser(name, email, password, role = "agent") {
  const hash = bcrypt.hashSync(password, SALT_ROUNDS);
  const stmt = db.prepare(
    "INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)"
  );
  const result = stmt.run(name, email.toLowerCase(), hash, role);
  return result.lastInsertRowid;
}

function findUserByEmail(email) {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase());
}

function findUserById(id) {
  return db.prepare("SELECT id, name, email, role, created_at FROM users WHERE id = ?").get(id);
}

function verifyPassword(plaintext, hash) {
  return bcrypt.compareSync(plaintext, hash);
}

// ── Attempt helpers ──

function saveAttempt({ userId, personaId, personaName, result, violationType, sectionReached, expectedSection, description, durationSeconds, transcript }) {
  const stmt = db.prepare(`
    INSERT INTO call_attempts (user_id, persona_id, persona_name, result, violation_type, section_reached, expected_section, description, duration_seconds, transcript)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const res = stmt.run(userId, personaId, personaName, result, violationType || null, sectionReached || null, expectedSection || null, description || null, durationSeconds || null, transcript || null);
  return res.lastInsertRowid;
}

function getAttemptsByUser(userId) {
  return db.prepare(
    "SELECT * FROM call_attempts WHERE user_id = ? ORDER BY created_at DESC"
  ).all(userId);
}

function getAttemptById(id) {
  return db.prepare("SELECT * FROM call_attempts WHERE id = ?").get(id);
}

// ── Admin helpers ──

function getAllAgents() {
  return db.prepare(
    "SELECT id, name, email, created_at FROM users WHERE role = 'agent' ORDER BY created_at DESC"
  ).all();
}

function getAgentStats(userId) {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total_attempts,
      SUM(CASE WHEN result = 'success' THEN 1 ELSE 0 END) AS successes,
      SUM(CASE WHEN result = 'violation' THEN 1 ELSE 0 END) AS violations,
      MAX(section_reached) AS furthest_section
    FROM call_attempts
    WHERE user_id = ?
  `).get(userId);
  return row;
}

function getAgentViolationBreakdown(userId) {
  return db.prepare(`
    SELECT violation_type, COUNT(*) AS count
    FROM call_attempts
    WHERE user_id = ? AND violation_type IS NOT NULL
    GROUP BY violation_type
    ORDER BY count DESC
  `).all(userId);
}

function getAgentPersonaProgress(userId) {
  return db.prepare(`
    SELECT
      persona_id,
      persona_name,
      COUNT(*) AS attempts,
      SUM(CASE WHEN result = 'success' THEN 1 ELSE 0 END) AS successes,
      MAX(section_reached) AS furthest_section
    FROM call_attempts
    WHERE user_id = ?
    GROUP BY persona_id
    ORDER BY persona_name
  `).all(userId);
}

function getAllAgentsSummary() {
  return db.prepare(`
    SELECT
      u.id,
      u.name,
      u.email,
      u.created_at,
      COUNT(ca.id) AS total_attempts,
      SUM(CASE WHEN ca.result = 'success' THEN 1 ELSE 0 END) AS successes,
      SUM(CASE WHEN ca.result = 'violation' THEN 1 ELSE 0 END) AS violations
    FROM users u
    LEFT JOIN call_attempts ca ON ca.user_id = u.id
    WHERE u.role = 'agent'
    GROUP BY u.id
    ORDER BY u.name
  `).all();
}

module.exports = {
  db,
  createUser,
  findUserByEmail,
  findUserById,
  verifyPassword,
  saveAttempt,
  getAttemptsByUser,
  getAttemptById,
  getAllAgents,
  getAgentStats,
  getAgentViolationBreakdown,
  getAgentPersonaProgress,
  getAllAgentsSummary,
};
