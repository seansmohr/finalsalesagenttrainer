const express = require("express");
const path = require("path");
const Retell = require("retell-sdk").default;
const personas = require("./personas");
const { buildAgentPrompt } = require("./prompt-builder");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const retellClient = new Retell({
  apiKey: process.env.RETELL_API_KEY || "",
});

// In-memory cache: personaId -> { agentId, llmId }
const agentCache = {};

// GET /api/personas — return persona list for frontend
app.get("/api/personas", (req, res) => {
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
app.post("/api/create-call", async (req, res) => {
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
        general_tools: [],
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

// GET /api/call/:callId — fetch call details for post-call feedback
app.get("/api/call/:callId", async (req, res) => {
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

// Catchall — serve index.html
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Mohr Training Simulator running on port ${PORT}`);
});
