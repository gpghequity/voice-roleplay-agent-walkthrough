require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-haiku-4-5-20251001';

app.use(cors());
app.use(express.json({ limit: '200kb' }));
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// ─── helpers ──────────────────────────────────────────────────────────────────

function loadScenario(id) {
  const dir = path.join(__dirname, 'scenarios');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (s.id === id) return s;
  }
  return null;
}

function allScenarios() {
  const dir = path.join(__dirname, 'scenarios');
  return fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      return {
        id: s.id, title: s.title, difficulty: s.difficulty,
        representation_label: s.representation_label,
        property_type: s.property.type,
        client_name: s.client_persona.name,
        client_role: s.client_persona.role
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function propertyBlock(s) {
  const p = s.property;
  const lines = [`${p.type} — ${p.address}`];
  if (p.beds) lines.push(`${p.beds} bed / ${p.baths} bath / ${p.sqft} sqft / Built ${p.year_built}`);
  if (p.units) lines.push(`${p.units} units / ${p.sqft_building} sqft building / Built ${p.year_built}`);
  if (p.asking_price) lines.push(`Asking: $${p.asking_price.toLocaleString()}`);
  if (p.monthly_rent) lines.push(`Monthly Rent: $${p.monthly_rent}`);
  if (p.annual_noi) lines.push(`Annual NOI: $${p.annual_noi.toLocaleString()}`);
  if (p.occupancy_pct) lines.push(`Occupancy: ${p.occupancy_pct}%`);
  return lines.join('\n');
}

function issuesSummary(s, includeClassification) {
  return s.issues.map(i => {
    const line = `• ${i.item}`;
    if (!includeClassification) return line;
    const cls = i.classification === 'material_fact' ? '[MATERIAL FACT]' : '[MINOR ISSUE]';
    const action = s.representation_side === 'seller' ? i.seller_agent_action
      : s.representation_side === 'landlord' ? (i.landlord_agent_action || i.buyer_agent_action || '')
      : i.buyer_agent_action;
    return `${line}\n  ${cls} — ${i.pa_basis}\n  Action: ${action}`;
  }).join('\n\n');
}

// ─── auth ──────────────────────────────────────────────────────────────────────

app.post('/validate-password', (req, res) => {
  res.json({ valid: true });
});

// ─── scenarios ─────────────────────────────────────────────────────────────────

app.get('/scenarios', (req, res) => res.json(allScenarios()));

app.get('/scenario/:id', (req, res) => {
  const s = loadScenario(req.params.id);
  if (!s) return res.status(404).json({ error: 'Scenario not found' });
  res.json(s);
});

// ─── chat (practice | testing | shadow) ────────────────────────────────────────

app.post('/chat', async (req, res) => {
  const { scenarioId, mode, agentName, userMessage, history = [], sessionState = {} } = req.body;
  if (!scenarioId || !mode || !userMessage) return res.status(400).json({ error: 'scenarioId, mode, userMessage required' });

  const s = loadScenario(scenarioId);
  if (!s) return res.status(404).json({ error: 'Scenario not found' });

  const updated = { ...sessionState, turns_taken: (sessionState.turns_taken || 0) + 1 };

  let systemPrompt = '';

  if (mode === 'practice') {
    // AI = client persona. Student = agent. Scored on disclosure behavior.
    systemPrompt = `You are ${s.client_persona.name}, ${s.client_persona.role}.

SCENE: ${s.client_persona.framing}

YOUR RULES:
${s.client_persona.behavioral_rules.map(r => '- ' + r).join('\n')}

The agent's name is ${agentName || 'the agent'}.

RESPONSE RULES:
- Stay fully in character. Never break character or give coaching.
- React authentically to what the agent says. If they disclose a problem honestly, react appropriately. If they evade, push.
- Maximum 2-3 sentences. This is an in-person walkthrough.
- Use curveballs naturally when appropriate: ${s.client_persona.curveballs.slice(0, 2).join(' | ')}
- Do not volunteer information the agent has not addressed.`;
    updated.mode = 'practice';

  } else if (mode === 'testing') {
    // AI = PA law examiner. Student being tested on legal knowledge.
    const currentIndex = sessionState.current_issue_index || 0;
    const currentIssue = s.issues[currentIndex];
    const totalIssues = s.issues.length;

    if (currentIssue) {
      systemPrompt = `You are a PA real estate law examiner administering a disclosure compliance test.

SCENARIO: ${s.title} — ${s.representation_label}
PROPERTY: ${propertyBlock(s)}

YOU ARE TESTING THE STUDENT ON THIS ISSUE (${currentIndex + 1} of ${totalIssues}):
"${currentIssue.item}"

YOUR RULES:
- Ask the student to classify this issue as a material fact or minor issue under PA law, AND state their specific disclosure obligation as a ${s.representation_label}.
- Do NOT confirm or deny the student's classification until they have fully committed to an answer with a reason.
- If the student gives a partial answer, push them to complete it: "What specifically makes you say that?" or "What is the disclosure obligation — be specific."
- Once the student has fully committed: confirm or correct with the PA law basis.
- Correct answer: Classification = ${currentIssue.classification.replace('_', ' ')}. PA Basis: ${currentIssue.pa_basis}. Action: ${s.representation_side === 'seller' ? currentIssue.seller_agent_action : s.representation_side === 'landlord' ? (currentIssue.landlord_agent_action || currentIssue.buyer_agent_action) : currentIssue.buyer_agent_action}
- After confirming/correcting, say "Ready for the next issue when you are."
- Tone: professional and instructional, not conversational. This is a compliance examination.
- Maximum 3-4 sentences per response.`;

      // Advance issue index if student gave committed answer (heuristic: turns on this issue)
      const turnsOnIssue = sessionState.turns_on_current_issue || 0;
      if (turnsOnIssue >= 2) {
        updated.current_issue_index = Math.min(currentIndex + 1, totalIssues - 1);
        updated.turns_on_current_issue = 0;
      } else {
        updated.turns_on_current_issue = turnsOnIssue + 1;
      }
    } else {
      systemPrompt = `You are a PA real estate law examiner. The student has completed all ${totalIssues} issues. Tell them to click "Get Scorecard" to see their results.`;
    }
    updated.mode = 'testing';

  } else if (mode === 'shadow') {
    // AI = model agent demonstrating correct technique. Student = client.
    systemPrompt = `You are an expert real estate agent demonstrating correct disclosure and walkthrough technique.

SCENARIO: ${s.title}
PROPERTY: ${propertyBlock(s)}
YOUR ROLE: ${s.representation_label}
CLIENT YOU ARE SERVING: The student is playing ${s.client_persona.role}.

FULL PROPERTY ISSUES (handle each correctly per PA law and your representation side):
${issuesSummary(s, true)}

YOUR RULES:
- Demonstrate exemplary professional technique — proactive disclosure of all material facts, appropriate handling of minor issues, strong rapport, confident answers.
- You are the model. Show the student what correct behavior looks like from the inside.
- Never break character to explain what you are doing — the debrief happens after the session.
- Respond naturally and realistically as a skilled agent would in this walkthrough.
- 2-3 sentences per turn maximum.`;
    updated.mode = 'shadow';
  }

  const messages = [...history, { role: 'user', content: userMessage }];

  try {
    const response = await client.messages.create({ model: MODEL, max_tokens: 350, system: systemPrompt, messages });
    res.json({ reply: response.content[0].text, updatedState: updated });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'AI service error: ' + err.message });
  }
});

// ─── observation watch — generate full autonomous conversation ──────────────────

app.post('/observation/generate', async (req, res) => {
  const { scenarioId } = req.body;
  if (!scenarioId) return res.status(400).json({ error: 'scenarioId required' });

  const s = loadScenario(scenarioId);
  if (!s) return res.status(404).json({ error: 'Scenario not found' });

  const action = s.representation_side === 'seller' ? s.issues.map(i => i.seller_agent_action)
    : s.representation_side === 'landlord' ? s.issues.map(i => i.landlord_agent_action || i.buyer_agent_action)
    : s.issues.map(i => i.buyer_agent_action);

  const prompt = `Generate a complete realistic property walkthrough conversation between a professional real estate agent and their client for the following scenario.

SCENARIO: ${s.title}
PROPERTY: ${propertyBlock(s)}
AGENT ROLE: ${s.representation_label}
CLIENT: ${s.client_persona.name} — ${s.client_persona.role}
CLIENT OPENING: "${s.client_persona.opening_lines[0]}"

PROPERTY ISSUES THE AGENT MUST HANDLE (correctly, per PA law):
${s.issues.map((i, idx) => `${idx + 1}. ${i.item} [${i.classification.replace('_', ' ')}] — Correct action: ${action[idx]}`).join('\n')}

PROPERTY FEATURES TO HIGHLIGHT:
${s.features.map(f => '• ' + f).join('\n')}

REQUIREMENTS:
- Agent must disclose ALL material facts proactively, not defensively
- Client reacts authentically — concern where warranted, appreciation for honest disclosure
- 10-14 turns total (agent and client alternate)
- Agent demonstrates: rapport opening, proactive disclosure, issue framing, objection handling, next step setting
- Make it realistic — the client asks follow-up questions, the agent answers confidently

Return ONLY valid JSON array with no other text:
[
  {
    "speaker": "Agent",
    "content": "...",
    "technique": "rapport_opening",
    "technique_note": "One sentence explaining what technique the agent used and why it works"
  },
  {
    "speaker": "${s.client_persona.name}",
    "content": "...",
    "technique": null,
    "technique_note": null
  }
]

Technique labels to use (agent turns only): rapport_opening, proactive_disclosure, issue_framing, objection_handling, soft_redirect, question_anchoring, rapport_reinforcement, feature_highlight, next_step_setting`;

  try {
    const response = await client.messages.create({
      model: MODEL, max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });
    const raw = response.content[0].text;
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return res.status(500).json({ error: 'Observation generation failed — invalid format' });
    const turns = JSON.parse(match[0]);
    res.json({ turns, scenario: { title: s.title, representation_label: s.representation_label, client_name: s.client_persona.name } });
  } catch (err) {
    console.error('Observation generate error:', err.message);
    res.status(500).json({ error: 'Generation error: ' + err.message });
  }
});

// ─── score (practice mode) ─────────────────────────────────────────────────────

app.post('/score', async (req, res) => {
  const { scenarioId, history, sessionState, agentName } = req.body;
  if (!scenarioId || !history) return res.status(400).json({ error: 'scenarioId and history required' });

  const s = loadScenario(scenarioId);
  if (!s) return res.status(404).json({ error: 'Scenario not found' });

  const transcript = history.map(m =>
    `${m.role === 'user' ? (agentName || 'Agent') : s.client_persona.name}: ${m.content}`
  ).join('\n');

  const materialFacts = s.issues.filter(i => i.classification === 'material_fact');
  const minorIssues = s.issues.filter(i => i.classification === 'minor_issue');

  const scorePrompt = `You are a PA real estate law and professional conduct coach evaluating a property walkthrough practice session.

SCENARIO: ${s.title} — ${s.representation_label}
PROPERTY: ${propertyBlock(s)}

MATERIAL FACTS THAT MUST BE DISCLOSED:
${materialFacts.map((i, idx) => `${idx + 1}. ${i.item}`).join('\n')}

MINOR ISSUES AND CORRECT HANDLING:
${minorIssues.map((i, idx) => `${idx + 1}. ${i.item} — ${s.representation_side === 'seller' ? i.seller_agent_action : s.representation_side === 'landlord' ? (i.landlord_agent_action || i.buyer_agent_action) : i.buyer_agent_action}`).join('\n')}

TRANSCRIPT:
${transcript}

Score the agent on these 5 pillars (0-10 each):
1. material_facts_disclosed — Did the agent proactively disclose every material fact above? -3 points for each material fact omitted.
2. representation_appropriate — Did the agent handle minor issues correctly per their representation side? Did they serve their client's interests appropriately?
3. rapport — Was the walkthrough natural, professional, and did it build trust with the client?
4. question_handling — Did the agent answer the client's questions accurately and confidently? Did they avoid evasion?
5. professionalism — Overall tone, accuracy, pacing, appropriate use of disclosure language.

For EACH missed material fact, list it explicitly by name in missed_material_facts.

Return ONLY valid JSON:
{
  "pillars": {
    "material_facts_disclosed": { "score": 0, "feedback": "..." },
    "representation_appropriate": { "score": 0, "feedback": "..." },
    "rapport": { "score": 0, "feedback": "..." },
    "question_handling": { "score": 0, "feedback": "..." },
    "professionalism": { "score": 0, "feedback": "..." }
  },
  "missed_material_facts": [],
  "overall_score": 0,
  "top_strength": "...",
  "priority_improvement": "..."
}`;

  try {
    const response = await client.messages.create({
      model: MODEL, max_tokens: 800,
      messages: [{ role: 'user', content: scorePrompt }]
    });
    const match = response.content[0].text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: 'Score parse failed' });
    res.json(JSON.parse(match[0]));
  } catch (err) {
    console.error('Score error:', err.message);
    res.status(500).json({ error: 'Score error: ' + err.message });
  }
});

// ─── test-score (testing mode) ──────────────────────────────────────────────────

app.post('/test-score', async (req, res) => {
  const { scenarioId, history, agentName } = req.body;
  if (!scenarioId || !history) return res.status(400).json({ error: 'scenarioId and history required' });

  const s = loadScenario(scenarioId);
  if (!s) return res.status(404).json({ error: 'Scenario not found' });

  const transcript = history.map(m =>
    `${m.role === 'user' ? (agentName || 'Student') : 'Examiner'}: ${m.content}`
  ).join('\n');

  const testScorePrompt = `You are evaluating a PA real estate licensing and disclosure compliance exam session.

SCENARIO: ${s.title} — ${s.representation_label}
ISSUES EXAMINED:
${s.issues.map((i, idx) => `${idx + 1}. "${i.item}"\n   Correct classification: ${i.classification.replace('_', ' ')}\n   PA basis: ${i.pa_basis}`).join('\n\n')}

EXAM TRANSCRIPT:
${transcript}

Score the student on 4 pillars (0-10 each):
1. pa_classification — Did the student correctly classify each issue as material fact or minor issue under PA law?
2. disclosure_action — Did the student correctly state the disclosure obligation for their representation side?
3. consequence_awareness — Did the student demonstrate understanding of what happens if disclosure is omitted (rescission, liability, license jeopardy)?
4. law_basis — Could the student explain WHY an item is or isn't a material fact under PA law?

List any issues the student misclassified in misclassified_issues (by item name).

Return ONLY valid JSON:
{
  "pillars": {
    "pa_classification": { "score": 0, "feedback": "..." },
    "disclosure_action": { "score": 0, "feedback": "..." },
    "consequence_awareness": { "score": 0, "feedback": "..." },
    "law_basis": { "score": 0, "feedback": "..." }
  },
  "misclassified_issues": [],
  "overall_score": 0,
  "top_strength": "...",
  "priority_improvement": "..."
}`;

  try {
    const response = await client.messages.create({
      model: MODEL, max_tokens: 800,
      messages: [{ role: 'user', content: testScorePrompt }]
    });
    const match = response.content[0].text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: 'Test score parse failed' });
    res.json(JSON.parse(match[0]));
  } catch (err) {
    console.error('Test score error:', err.message);
    res.status(500).json({ error: 'Test score error: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AgentWalkthrough running on http://localhost:${PORT}`));
