const express = require("express");
const path = require("path");
const session = require("express-session");
const SqliteStore = require("better-sqlite3-session-store")(session);
const Retell = require("retell-sdk").default;
const personas = require("./personas");
const { buildAgentPrompt } = require("./prompt-builder");
const {
  db,
  createUser,
  findUserByEmail,
  findUserById,
  verifyPassword,
  saveAttempt,
  getAttemptsByUser,
  getAttemptById,
  getAllAgentsSummary,
  getAgentStats,
  getAgentViolationBreakdown,
  getAgentPersonaProgress,
} = require("./db");

const app = express();
app.use(express.json());

// ── Sessions ──
app.use(
  session({
    store: new SqliteStore({ client: db, expired: { clear: true, intervalMs: 900000 } }),
    secret: process.env.SESSION_SECRET || "mohr-training-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      httpOnly: true,
      sameSite: "lax",
    },
  })
);

app.use(express.static(path.join(__dirname, "public")));

const retellClient = new Retell({
  apiKey: process.env.RETELL_API_KEY || "",
});

// In-memory cache: personaId -> { agentId, llmId }
const agentCache = {};

// ── Auth middleware ──
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  if (req.session.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

// ── Auth routes ──

// POST /api/register
app.post("/api/register", (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: "Name, email, and password are required" });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }
    const existing = findUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }
    const userId = createUser(name, email, password, "agent");
    req.session.userId = userId;
    req.session.role = "agent";
    res.json({ id: userId, name, email, role: "agent" });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: "Registration failed" });
  }
});

// POST /api/login
app.post("/api/login", (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }
    const user = findUserByEmail(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    req.session.userId = user.id;
    req.session.role = user.role;
    res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

// POST /api/logout
app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

// GET /api/me — current user
app.get("/api/me", (req, res) => {
  if (!req.session.userId) {
    return res.json({ user: null });
  }
  const user = findUserById(req.session.userId);
  if (!user) {
    return res.json({ user: null });
  }
  res.json({ user });
});

// ── Existing routes (now require auth) ──

// GET /api/personas — return persona list for frontend
app.get("/api/personas", requireAuth, (req, res) => {
  const list = personas.map((p) => ({
    id: p.id,
    name: p.name,
    age: p.age,
    tagline: p.tagline,
    description: p.description,
    avatar: p.avatar,
  }));
  res.json(list);
});

// POST /api/create-call — create a Retell web call for a persona
app.post("/api/create-call", requireAuth, async (req, res) => {
  try {
    const { personaId } = req.body;
    if (!personaId) {
      return res.status(400).json({ error: "personaId is required" });
    }

    const persona = personas.find((p) => p.id === personaId);
    if (!persona) {
      return res.status(404).json({ error: "Persona not found" });
    }

    let agentId = agentCache[personaId]?.agentId;

    // Create LLM + Agent if not cached
    if (!agentId) {
      const systemPrompt = buildAgentPrompt(persona);

      const llm = await retellClient.llm.create({
        model: "gpt-4o",
        general_prompt: systemPrompt,
        general_tools: [
          {
            type: "end_call",
            name: "end_call",
            description: "End the call. Use this after saying goodbye when you detect a structure violation, or after the call completes successfully.",
          },
        ],
        begin_message: null,
      });

      const agent = await retellClient.agent.create({
        response_engine: { type: "retell-llm", llm_id: llm.llm_id },
        voice_id: "11labs-Adrian",
        agent_name: `Training - ${persona.name}`,
        language: "en-US",
        enable_backchannel: true,
      });

      agentCache[personaId] = {
        agentId: agent.agent_id,
        llmId: llm.llm_id,
      };
      agentId = agent.agent_id;
    }

    // Create web call
    const webCall = await retellClient.call.createWebCall({
      agent_id: agentId,
    });

    res.json({
      access_token: webCall.access_token,
      call_id: webCall.call_id,
      persona_name: persona.name,
    });
  } catch (err) {
    console.error("Error creating call:", err);
    res.status(500).json({
      error: "Failed to create call",
      details: err.message,
    });
  }
});

// POST /api/clear-cache — clear agent cache so new prompts take effect
app.post("/api/clear-cache", (req, res) => {
  const count = Object.keys(agentCache).length;
  for (const key of Object.keys(agentCache)) {
    delete agentCache[key];
  }
  console.log(`Cleared agent cache (${count} entries)`);
  res.json({ cleared: count });
});

// GET /api/call/:callId — fetch call details for post-call feedback
app.get("/api/call/:callId", requireAuth, async (req, res) => {
  try {
    const call = await retellClient.call.retrieve(req.params.callId);
    res.json({
      call_id: call.call_id,
      call_status: call.call_status,
      transcript: call.transcript,
      duration_ms: call.end_timestamp && call.start_timestamp
        ? call.end_timestamp - call.start_timestamp
        : null,
      disconnection_reason: call.disconnection_reason,
    });
  } catch (err) {
    console.error("Error fetching call:", err);
    res.status(500).json({
      error: "Failed to fetch call details",
      details: err.message,
    });
  }
});

// ── Attempt tracking ──

// POST /api/attempts — save a call attempt result
app.post("/api/attempts", requireAuth, (req, res) => {
  try {
    const { personaId, personaName, result, violationType, sectionReached, expectedSection, description, durationSeconds, transcript } = req.body;
    if (!personaId || !result) {
      return res.status(400).json({ error: "personaId and result are required" });
    }
    const attemptId = saveAttempt({
      userId: req.session.userId,
      personaId,
      personaName: personaName || "Unknown",
      result,
      violationType,
      sectionReached,
      expectedSection,
      description,
      durationSeconds,
      transcript,
    });
    res.json({ id: attemptId });
  } catch (err) {
    console.error("Error saving attempt:", err);
    res.status(500).json({ error: "Failed to save attempt" });
  }
});

// GET /api/my-attempts — get current user's attempts
app.get("/api/my-attempts", requireAuth, (req, res) => {
  const attempts = getAttemptsByUser(req.session.userId);
  res.json(attempts);
});

// ── Auto-promote admin on startup ──
const ADMIN_EMAILS = ["sean@jmohrins.com"];
for (const email of ADMIN_EMAILS) {
  const user = findUserByEmail(email);
  if (user && user.role !== "admin") {
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    console.log(`Promoted ${email} to admin`);
  }
}

// ── Admin routes ──

// GET /api/admin/agents — all agents with summary stats
app.get("/api/admin/agents", requireAdmin, (req, res) => {
  const agents = getAllAgentsSummary();
  res.json(agents);
});

// GET /api/admin/agents/:id — detailed stats for one agent
app.get("/api/admin/agents/:id", requireAdmin, (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const user = findUserById(userId);
  if (!user) {
    return res.status(404).json({ error: "Agent not found" });
  }
  const stats = getAgentStats(userId);
  const violations = getAgentViolationBreakdown(userId);
  const personaProgress = getAgentPersonaProgress(userId);
  res.json({ user, stats, violations, personaProgress });
});

// GET /api/admin/agents/:id/attempts — all attempts for one agent
app.get("/api/admin/agents/:id/attempts", requireAdmin, (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const attempts = getAttemptsByUser(userId);
  res.json(attempts);
});

// ── Page routes ──

// Dashboard page (admin only — auth checked client-side)
app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

// Catchall — serve index.html
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Mohr Training Simulator running on port ${PORT}`);
});
