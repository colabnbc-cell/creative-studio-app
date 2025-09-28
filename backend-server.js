/*
 * Simple Express-based backend proxy and API server for a multi‑user
 * creative scripting application.  This server exposes endpoints that
 * proxy requests to third‑party Large Language Model (LLM) APIs
 * (Gemini, Anthropic Claude and OpenAI ChatGPT) and persists user data
 * such as programmes and generated scripts.  API keys are loaded
 * securely from environment variables and are never sent to the client.
 *
 * IMPORTANT: Do not commit your `.env` file to version control.  Use a
 * `.gitignore` entry to exclude it and configure your hosting provider
 * (e.g. Vercel, Netlify, Cloud Run or Heroku) to inject the same
 * variables in production as recommended by Smashing Magazine’s guide
 * on hiding API keys in React【213852040894593†L199-L217】.
 */

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
require('dotenv').config();

// Optional: if using Firebase Auth and Firestore for storage.
// Uncomment the following lines and add your service account
// credentials (or use Application Default Credentials on Cloud Run).
// const admin = require('firebase-admin');
// admin.initializeApp({ credential: admin.credential.applicationDefault() });
// const db = admin.firestore();

// Optional: if using Supabase for storage and authentication.
// const { createClient } = require('@supabase/supabase-js');
// const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const app = express();
app.use(cors());
app.use(express.json());

/*
 * Middleware to authenticate incoming requests.  In a production
 * environment you should verify the user’s identity token from
 * Firebase, Supabase or another auth provider and attach the decoded
 * user information to `req.user`.  Without authentication, any
 * anonymous client could read or write data.
 */
async function authenticateUser(req, res, next) {
  // Expect an Authorization header: `Bearer <idToken>`.
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length)
    : null;
  if (!token) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }
  try {
    /*
     * Example using Firebase Auth – uncomment if using Firebase:
     * const decodedToken = await admin.auth().verifyIdToken(token);
     * req.user = decodedToken;
     */
    /*
     * Example using Supabase – verify a JWT manually or via your own
     * Supabase function.  See the Supabase docs for details.
     */
    // Placeholder: trust all tokens in development.  You MUST
    // implement proper verification before deploying to production.
    req.user = { uid: 'demo-user' };
    next();
  } catch (err) {
    console.error('Authentication error', err);
    return res.status(401).json({ error: 'Invalid authorization token' });
  }
}

/**
 * Helper to call the Gemini API using a REST endpoint.  See
 * https://cloud.google.com/ai/generative-ai/docs/model-quickstart for
 * details.  You can also use the @google/generative-ai SDK
 * directly, but the REST call keeps dependencies minimal.
 *
 * @param {string} prompt - The user prompt.
 * @returns {Promise<object>} The API response JSON.
 */
async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not configured');
  }
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const body = {
    contents: [ { parts: [ { text: prompt } ] } ],
    generationConfig: {
      maxOutputTokens: 2048,
      temperature: 0.7,
    },
  };
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini API error: ${response.status} – ${text}`);
  }
  return await response.json();
}

/**
 * Helper to call Anthropic’s Claude API.  See
 * https://docs.anthropic.com/claude/docs/api-reference for details.
 *
 * @param {string} prompt - The user prompt.
 * @returns {Promise<object>} The API response JSON.
 */
async function callClaude(prompt) {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    throw new Error('CLAUDE_API_KEY not configured');
  }
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-3-opus-20240229',
      max_tokens: 2048,
      messages: [ { role: 'user', content: prompt } ],
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Claude API error: ${response.status} – ${text}`);
  }
  return await response.json();
}

/**
 * Helper to call OpenAI’s ChatGPT API.  See
 * https://platform.openai.com/docs/api-reference/chat for details.
 *
 * @param {string} prompt - The user prompt.
 * @returns {Promise<object>} The API response JSON.
 */
async function callOpenAI(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not configured');
  }
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4-turbo',
      messages: [ { role: 'user', content: prompt } ],
      max_tokens: 2048,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI API error: ${response.status} – ${text}`);
  }
  return await response.json();
}

/**
 * Generic endpoint for generating content.  The client sends a
 * prompt and selects which model to use.  The response is
 * forwarded as received.  Authentication is optional here but can
 * be enabled by adding `authenticateUser` as middleware.
 */
app.post('/api/generate', authenticateUser, async (req, res) => {
  const { model, prompt } = req.body;
  try {
    let result;
    switch ((model || '').toLowerCase()) {
      case 'gemini':
        result = await callGemini(prompt);
        break;
      case 'claude':
        result = await callClaude(prompt);
        break;
      case 'openai':
      case 'chatgpt':
        result = await callOpenAI(prompt);
        break;
      default:
        return res.status(400).json({ error: 'Unsupported model' });
    }
    res.json(result);
  } catch (err) {
    console.error('Generation error', err);
    res.status(500).json({ error: err.message });
  }
});

/*
 * CRUD endpoints for programmes.  These demonstrate how you might
 * persist user data in a database.  Replace the in‑memory store
 * with Firestore, Supabase or another database.  When using
 * Firestore, you would call db.collection('programmes').doc(...).set(...)
 * after verifying the user’s identity.  When using Supabase, call
 * supabase.from('programmes').insert(...) with row level security
 * enabled for `user_id = auth.uid()`.
 */
const programmes = {}; // In‑memory store keyed by user ID

// Get all programmes for the authenticated user.
app.get('/api/programmes', authenticateUser, async (req, res) => {
  const userId = req.user.uid;
  // TODO: Replace with Firestore or Supabase query
  res.json(programmes[userId] || []);
});

// Create a new programme
app.post('/api/programmes', authenticateUser, async (req, res) => {
  const userId = req.user.uid;
  const { name, genre, targetAudience, episodeLength, styleReferences } = req.body;
  const programme = {
    id: `programme-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    name,
    genre,
    targetAudience,
    episodeLength,
    styleReferences: styleReferences || [],
    createdAt: new Date().toISOString(),
  };
  if (!programmes[userId]) programmes[userId] = [];
  programmes[userId].unshift(programme);
  res.status(201).json(programme);
});

// Update an existing programme
app.put('/api/programmes/:id', authenticateUser, async (req, res) => {
  const userId = req.user.uid;
  const { id } = req.params;
  const { name, genre, targetAudience, episodeLength, styleReferences } = req.body;
  const userProgrammes = programmes[userId] || [];
  const index = userProgrammes.findIndex((p) => p.id === id);
  if (index === -1) return res.status(404).json({ error: 'Programme not found' });
  const updated = {
    ...userProgrammes[index],
    name,
    genre,
    targetAudience,
    episodeLength,
    styleReferences,
    updatedAt: new Date().toISOString(),
  };
  userProgrammes[index] = updated;
  res.json(updated);
});

// Delete a programme
app.delete('/api/programmes/:id', authenticateUser, async (req, res) => {
  const userId = req.user.uid;
  const { id } = req.params;
  const userProgrammes = programmes[userId] || [];
  const index = userProgrammes.findIndex((p) => p.id === id);
  if (index === -1) return res.status(404).json({ error: 'Programme not found' });
  userProgrammes.splice(index, 1);
  res.status(204).end();
});

/*
 * CRUD endpoints for saved scripts.  Structure is similar to the
 * programme endpoints.  In a real implementation you would write
 * these entries to a database table/collection keyed by the user’s
 * unique ID.  Ensure row‑level or document‑level security so users
 * can only access their own data – Firestore security rules and
 * Supabase Row Level Security policies make this straightforward【876323371830981†L1404-L1460】.
 */
const scripts = {};

app.get('/api/scripts', authenticateUser, async (req, res) => {
  const userId = req.user.uid;
  res.json(scripts[userId] || []);
});

app.post('/api/scripts', authenticateUser, async (req, res) => {
  const userId = req.user.uid;
  const { programmeId, topic, content, sources } = req.body;
  const script = {
    id: `script-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    programmeId,
    topic,
    content,
    sources,
    createdAt: new Date().toISOString(),
  };
  if (!scripts[userId]) scripts[userId] = [];
  scripts[userId].unshift(script);
  res.status(201).json(script);
});

// Update a script
app.put('/api/scripts/:id', authenticateUser, async (req, res) => {
  const userId = req.user.uid;
  const { id } = req.params;
  const { content, sources } = req.body;
  const userScripts = scripts[userId] || [];
  const index = userScripts.findIndex((s) => s.id === id);
  if (index === -1) return res.status(404).json({ error: 'Script not found' });
  const updated = { ...userScripts[index], content, sources, updatedAt: new Date().toISOString() };
  userScripts[index] = updated;
  res.json(updated);
});

// Delete a script
app.delete('/api/scripts/:id', authenticateUser, async (req, res) => {
  const userId = req.user.uid;
  const { id } = req.params;
  const userScripts = scripts[userId] || [];
  const index = userScripts.findIndex((s) => s.id === id);
  if (index === -1) return res.status(404).json({ error: 'Script not found' });
  userScripts.splice(index, 1);
  res.status(204).end();
});

// Health check endpoint
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend proxy server listening on port ${PORT}`);
});
