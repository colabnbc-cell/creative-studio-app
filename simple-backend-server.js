/*
 * Minimal backend proxy server using Node's built‑in modules.  This
 * implementation avoids third‑party dependencies such as Express or
 * CORS middleware, which cannot be installed in the current
 * environment.  The server acts as a proxy for calling external
 * Large Language Model (LLM) APIs (Gemini, Anthropic Claude and
 * OpenAI ChatGPT).  It also exposes simple in‑memory CRUD
 * endpoints for programmes and scripts.  API keys are loaded from
 * environment variables defined in a `.env` file if present.
 *
 * NOTE: This is not a production‑ready server.  It lacks user
 * authentication, persistent storage and proper input validation.
 * However it demonstrates how to run a secure proxy without
 * exposing your API keys to the browser.  See report.md for a full
 * implementation plan that includes authentication and database
 * integration.
 */

const http = require('http');
const { readFileSync, existsSync } = require('fs');
const { parse: parseUrl } = require('url');

/* ------------------------------------------------------------------
 * Environment loading
 *
 * Read key=value pairs from a `.env` file in the current working
 * directory and assign them to process.env.  Lines beginning with
 * `#` are treated as comments.  Values containing spaces must not
 * be quoted (quotes will be treated as part of the value).  Do not
 * commit the `.env` file to source control.  In production you
 * should configure environment variables in your hosting provider
 * instead.  See 【213852040894593†L199-L217】 for more details.
 */
function loadDotEnv() {
  const envPath = '.env';
  if (!existsSync(envPath)) return;
  try {
    const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!line || line.startsWith('#')) continue;
      const idx = line.indexOf('=');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
        process.env[key] = value;
      }
    }
  } catch (err) {
    console.error('Error loading .env file:', err);
  }
}

loadDotEnv();

/* ------------------------------------------------------------------
 * Helpers to call external LLM APIs
 *
 * Each helper returns a Promise that resolves with the parsed JSON
 * response from the upstream API or rejects with an Error.  They
 * rely on the native `fetch` API available in Node.js v22+.
 */
async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const body = {
    contents: [ { parts: [ { text: prompt } ] } ],
    generationConfig: { maxOutputTokens: 2048, temperature: 0.7 },
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

async function callClaude(prompt) {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) throw new Error('CLAUDE_API_KEY not configured');
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

async function callOpenAI(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');
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

/* ------------------------------------------------------------------
 * In‑memory data stores for programmes and scripts.  In a real
 * implementation you should persist these to Firestore, Supabase or
 * another database keyed by user ID.  The structure is an object
 * keyed by user ID mapping to arrays of programmes or scripts.
 */
const programmes = {};
const scripts = {};

/* ------------------------------------------------------------------
 * Utility functions
 */
// Generate a random ID using the current time and a random suffix.
function generateId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Send a JSON response with the given status code and object.
function sendJson(res, statusCode, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(payload);
}

// Parse the JSON body of a request.  Returns a Promise that
// resolves with the parsed object or rejects if parsing fails.
function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        const parsed = JSON.parse(data);
        resolve(parsed);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', (err) => reject(err));
  });
}

/*
 * Minimal authentication middleware.  In this demo server we do not
 * verify tokens; instead we accept any non‑empty Authorization header
 * of the form `Bearer <token>` and assign a fixed user ID.  In a
 * production server you must verify JWTs from Firebase, Supabase or
 * your auth provider and extract the user ID from the decoded
 * token.【876323371830981†L1404-L1460】
 */
function getUserId(req) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.slice('Bearer '.length);
  if (!token) return null;
  // In a real implementation, verify the token and return the UID.
  return 'demo-user';
}

/* ------------------------------------------------------------------
 * Request dispatcher
 *
 * Dispatch incoming requests based on method and URL.  Each handler
 * must call sendJson() to send a response.  Unhandled routes fall
 * through and respond with 404.
 */
async function handleRequest(req, res) {
  // Respond to preflight CORS requests quickly.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }
  const { pathname, query } = parseUrl(req.url, true);
  try {
    // Health check
    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { status: 'ok' });
    }
    // Generation proxy
    if (req.method === 'POST' && pathname === '/api/generate') {
      const userId = getUserId(req);
      if (!userId) return sendJson(res, 401, { error: 'Missing or invalid authorization token' });
      const body = await parseRequestBody(req);
      const { model, prompt } = body;
      if (!model || !prompt) return sendJson(res, 400, { error: 'Missing model or prompt' });
      let result;
      switch (String(model).toLowerCase()) {
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
          return sendJson(res, 400, { error: 'Unsupported model' });
      }
      return sendJson(res, 200, result);
    }
    // CRUD for programmes
    if (pathname === '/api/programmes') {
      const userId = getUserId(req);
      if (!userId) return sendJson(res, 401, { error: 'Missing or invalid authorization token' });
      if (req.method === 'GET') {
        const list = programmes[userId] || [];
        return sendJson(res, 200, list);
      }
      if (req.method === 'POST') {
        const body = await parseRequestBody(req);
        const { name, genre, targetAudience, episodeLength, styleReferences } = body;
        const programme = {
          id: generateId('programme'),
          name,
          genre,
          targetAudience,
          episodeLength,
          styleReferences: styleReferences || [],
          createdAt: new Date().toISOString(),
        };
        if (!programmes[userId]) programmes[userId] = [];
        programmes[userId].unshift(programme);
        return sendJson(res, 201, programme);
      }
    }
    // PUT/DELETE /api/programmes/:id
    if (pathname.startsWith('/api/programmes/')) {
      const userId = getUserId(req);
      if (!userId) return sendJson(res, 401, { error: 'Missing or invalid authorization token' });
      const id = pathname.split('/').pop();
      const list = programmes[userId] || [];
      const index = list.findIndex((p) => p.id === id);
      if (index === -1) return sendJson(res, 404, { error: 'Programme not found' });
      if (req.method === 'PUT') {
        const body = await parseRequestBody(req);
        const { name, genre, targetAudience, episodeLength, styleReferences } = body;
        const updated = {
          ...list[index],
          name,
          genre,
          targetAudience,
          episodeLength,
          styleReferences: styleReferences || [],
          updatedAt: new Date().toISOString(),
        };
        list[index] = updated;
        return sendJson(res, 200, updated);
      }
      if (req.method === 'DELETE') {
        list.splice(index, 1);
        return sendJson(res, 204, {});
      }
    }
    // CRUD for scripts
    if (pathname === '/api/scripts') {
      const userId = getUserId(req);
      if (!userId) return sendJson(res, 401, { error: 'Missing or invalid authorization token' });
      if (req.method === 'GET') {
        return sendJson(res, 200, scripts[userId] || []);
      }
      if (req.method === 'POST') {
        const body = await parseRequestBody(req);
        const { programmeId, topic, content, sources } = body;
        const script = {
          id: generateId('script'),
          programmeId,
          topic,
          content,
          sources,
          createdAt: new Date().toISOString(),
        };
        if (!scripts[userId]) scripts[userId] = [];
        scripts[userId].unshift(script);
        return sendJson(res, 201, script);
      }
    }
    // PUT/DELETE /api/scripts/:id
    if (pathname.startsWith('/api/scripts/')) {
      const userId = getUserId(req);
      if (!userId) return sendJson(res, 401, { error: 'Missing or invalid authorization token' });
      const id = pathname.split('/').pop();
      const list = scripts[userId] || [];
      const index = list.findIndex((s) => s.id === id);
      if (index === -1) return sendJson(res, 404, { error: 'Script not found' });
      if (req.method === 'PUT') {
        const body = await parseRequestBody(req);
        const { content, sources } = body;
        const updated = {
          ...list[index],
          content,
          sources,
          updatedAt: new Date().toISOString(),
        };
        list[index] = updated;
        return sendJson(res, 200, updated);
      }
      if (req.method === 'DELETE') {
        list.splice(index, 1);
        return sendJson(res, 204, {});
      }
    }
    // Unknown route
    return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('Unhandled error', err);
    return sendJson(res, 500, { error: err.message || 'Internal Server Error' });
  }
}

/* ------------------------------------------------------------------
 * Create and start the HTTP server
 */
const port = parseInt(process.env.PORT || '5000', 10);
const server = http.createServer(handleRequest);
server.listen(port, () => {
  console.log(`Simple backend proxy server listening on port ${port}`);
});
