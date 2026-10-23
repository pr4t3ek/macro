// Macro Red Team — web server.
//   * serves the war-room frontend (public/)
//   * starts runs by calling the n8n webhook
//   * exposes the blackboard/referee callbacks the n8n workflow uses
//   * streams every event to the browser over Server-Sent Events
// Zero dependencies: `node server.js`.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Run, RULES, AGENTS, httpError } = require('./referee');
const { simulate } = require('./simulator');

const PORT = Number(process.env.PORT || 3000);
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || '';
// Where n8n can reach this server. Inside docker-compose that is http://app:3000.
const PUBLIC_API_BASE = process.env.PUBLIC_API_BASE || `http://localhost:${PORT}`;
// The investigator webhook lives in the same n8n workflow, next to the orchestrator.
const N8N_INVESTIGATE_URL = process.env.N8N_INVESTIGATE_URL
  || N8N_WEBHOOK_URL.replace(/\/macro-red-team\/?$/, '/macro-red-team-investigate');
const PUBLIC_DIR = path.join(__dirname, 'public');

const runs = new Map();

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 5_000_000) throw httpError(413, 'body too large');
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw httpError(400, 'invalid JSON body'); }
}

function getRun(id, req, { requireToken = false } = {}) {
  const run = runs.get(id);
  if (!run) throw httpError(404, `run ${id} not found`);
  if (requireToken && req.headers['x-run-token'] !== run.token) throw httpError(401, 'bad x-run-token');
  return run;
}

async function startN8n(run) {
  try {
    const res = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        run_id: run.id,
        token: run.token,
        forecast: run.forecast,
        max_rounds: run.maxRounds,
        api_base: PUBLIC_API_BASE,
        investigate_url: N8N_INVESTIGATE_URL,
      }),
    });
    if (!res.ok) throw new Error(`n8n answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    run.emit('n8n_started', { webhook: N8N_WEBHOOK_URL });
  } catch (err) {
    run.fail(`Could not start the n8n workflow at ${N8N_WEBHOOK_URL}: ${err.message}. `
      + 'Is the workflow imported and active?');
  }
}

function stream(req, res, run) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const write = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const since = Number(req.headers['last-event-id'] || 0);
  run.events.filter((e) => e.seq > since).forEach(write);
  run.listeners.add(write);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(ping); run.listeners.delete(write); });
}

const routes = [
  ['GET', /^\/api\/config$/, async () => ({
    mode: N8N_WEBHOOK_URL ? 'n8n' : 'simulate',
    rules: RULES,
    agents: AGENTS,
  })],

  ['POST', /^\/api\/runs$/, async (req) => {
    const body = await readJson(req);
    if (!body.forecast || String(body.forecast).trim().length < 8) throw httpError(400, 'give me a forecast to attack');
    const mode = body.mode === 'simulate' || !N8N_WEBHOOK_URL ? 'simulate' : 'n8n';
    const run = new Run({ forecast: body.forecast, maxRounds: body.max_rounds, mode });
    runs.set(run.id, run);
    if (mode === 'n8n') startN8n(run);
    else simulate(run, { speed: Number(body.speed) || 1 });
    return { run_id: run.id, mode };
  }],

  ['GET', /^\/api\/runs\/(\w+)$/, async (req, id) => getRun(id, req).snapshot()],

  // --- callbacks used by the n8n workflow (authenticated with x-run-token) ---
  ['POST', /^\/api\/runs\/(\w+)\/plan$/, async (req, id) =>
    getRun(id, req, { requireToken: true }).applyPlan(await readJson(req))],

  ['POST', /^\/api\/runs\/(\w+)\/findings$/, async (req, id) =>
    getRun(id, req, { requireToken: true }).recordFinding(await readJson(req))],

  ['GET', /^\/api\/runs\/(\w+)\/blackboard$/, async (req, id) => {
    const run = getRun(id, req, { requireToken: true });
    return { round: run.round, max_rounds: run.maxRounds, stop_reason: run.stopReason, digest: run.digest() };
  }],

  ['POST', /^\/api\/runs\/(\w+)\/rounds\/close$/, async (req, id) =>
    getRun(id, req, { requireToken: true }).closeRound()],

  ['POST', /^\/api\/runs\/(\w+)\/rulings$/, async (req, id) =>
    getRun(id, req, { requireToken: true }).applyRulings(await readJson(req))],

  ['POST', /^\/api\/runs\/(\w+)\/verdict$/, async (req, id) =>
    getRun(id, req, { requireToken: true }).applyVerdict(await readJson(req))],

  ['POST', /^\/api\/runs\/(\w+)\/error$/, async (req, id) => {
    getRun(id, req, { requireToken: true }).fail((await readJson(req)).message);
    return { ok: true };
  }],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    const streamMatch = url.pathname.match(/^\/api\/runs\/(\w+)\/stream$/);
    if (req.method === 'GET' && streamMatch) return stream(req, res, getRun(streamMatch[1], req));

    for (const [method, pattern, handler] of routes) {
      const m = url.pathname.match(pattern);
      if (m && req.method === method) return send(res, 200, await handler(req, ...m.slice(1)));
    }

    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      const file = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
      if (file.startsWith(PUBLIC_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
        return fs.createReadStream(file).pipe(res);
      }
    }
    send(res, 404, { error: 'not found' });
  } catch (err) {
    if (!err.status) console.error(err);
    send(res, err.status || 500, { error: err.message });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Macro Red Team on http://localhost:${PORT}`);
    console.log(N8N_WEBHOOK_URL
      ? `n8n mode: runs start at ${N8N_WEBHOOK_URL}; n8n calls back to ${PUBLIC_API_BASE}`
      : 'simulation mode: set N8N_WEBHOOK_URL to drive runs with the n8n agents');
  });
}

module.exports = { server, runs };
