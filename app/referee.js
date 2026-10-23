// The referee owns the shared blackboard and the investigation-credit ledger.
// n8n agents make every decision (what to investigate, whom to delegate to,
// when to stop); the referee only enforces the rules of the game so that no
// agent can overspend, loop forever, or rewrite history.

const crypto = require('node:crypto');

const RULES = {
  creditsPerAgent: 10,
  maxRounds: 4,
  minRounds: 2,
  maxTasksPerRound: 8,
  maxCreditsPerTask: 4,
  maxFollowUpsPerFinding: 2,
};

// Scope verdicts that stop a run before any agent spends a credit. Anything
// else, including a missing or unrecognised verdict, lets the run proceed:
// the gate fails open so a genuine forecast is never blocked by a glitch.
const REJECTIONS = {
  too_vague: 'Too vague to test',
  not_a_forecast: 'Not a forecast',
  out_of_scope: 'Outside economics',
};

const AGENTS = [
  { id: 'demand', name: 'Demand Economist', side: 'bear', glyph: 'D',
    mission: 'Is domestic demand really strong enough?' },
  { id: 'supply', name: 'Supply Economist', side: 'bear', glyph: 'S',
    mission: 'Break the forecast from the supply side.' },
  { id: 'global', name: 'Global Shock Agent', side: 'bear', glyph: 'G',
    mission: 'Find the external event that invalidates it.' },
  { id: 'data', name: 'Data Detective', side: 'bear', glyph: '?',
    mission: 'Attack the data, not the economics.' },
  { id: 'historian', name: 'Historical Analog Agent', side: 'bear', glyph: 'H',
    mission: 'When have we seen this configuration before?' },
  { id: 'blackswan', name: 'Black Swan Agent', side: 'bear', glyph: 'B',
    mission: 'The plausible event nobody else considered.' },
  { id: 'bull', name: 'Bull Defender', side: 'bull', glyph: '+',
    mission: 'Prove the forecast is robust. Rebut every attack.' },
];
const AGENT_IDS = AGENTS.map((a) => a.id);

const ALIASES = {
  demand: 'demand', 'demand economist': 'demand', 'demand agent': 'demand',
  supply: 'supply', 'supply economist': 'supply', 'supply agent': 'supply',
  global: 'global', 'global shock': 'global', 'global shock agent': 'global', globalshock: 'global',
  data: 'data', 'data detective': 'data', datadetective: 'data',
  historian: 'historian', 'historical analog': 'historian', 'historical analog agent': 'historian', history: 'historian',
  blackswan: 'blackswan', 'black swan': 'blackswan', 'black swan agent': 'blackswan', black_swan: 'blackswan',
  bull: 'bull', 'bull defender': 'bull', 'bull agent': 'bull', defender: 'bull',
};

function normalizeAgent(value) {
  if (!value) return null;
  const key = String(value).toLowerCase().trim().replace(/[-_]+/g, ' ');
  return ALIASES[key] || ALIASES[key.replace(/\s+/g, '')] || null;
}

function clampInt(value, lo, hi, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function clamp01(value, fallback = 0.5) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n > 1 ? n / 100 : n));
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

// LLM output arrives as an object, a JSON string, or occasionally a JSON
// string wrapped in prose / markdown fences. Recover what we can.
function parseLoose(value) {
  if (value && typeof value === 'object') {
    if (value.output !== undefined && Object.keys(value).length === 1) return parseLoose(value.output);
    return value;
  }
  if (typeof value !== 'string') return {};
  const text = value.trim();
  try { return JSON.parse(text); } catch { /* fall through */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* fall through */ }
  }
  return { argument: text };
}

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

class Run {
  constructor({ forecast, maxRounds, mode, force = false }) {
    this.id = crypto.randomUUID().slice(0, 8);
    this.token = crypto.randomBytes(16).toString('hex');
    this.forecast = String(forecast || '').trim();
    this.mode = mode;
    this.force = Boolean(force);
    this.maxRounds = clampInt(maxRounds, RULES.minRounds, 8, RULES.maxRounds);
    this.createdAt = new Date().toISOString();
    this.status = 'running';
    this.stopReason = null;
    this.round = 0;
    this.forecastLabel = null;
    this.forecastValue = null;
    this.assumptions = [];
    this.agents = Object.fromEntries(AGENT_IDS.map((id) => [id, { spent: 0, reserved: 0 }]));
    this.tasks = [];
    this.queue = [];
    this.claims = [];
    this.rulings = [];
    this.contradictions = [];
    this.robustness = [];
    this.verdict = null;
    this.events = [];
    this.listeners = new Set();
    this.seq = { task: 0, claim: 0 };
    this.emit('run_started', { forecast: this.forecast, max_rounds: this.maxRounds, mode, force: this.force });
  }

  remaining(agentId) {
    const a = this.agents[agentId];
    return RULES.creditsPerAgent - a.spent - a.reserved;
  }

  summary() {
    const agents = {};
    for (const id of AGENT_IDS) {
      const a = this.agents[id];
      const active = this.tasks.find((t) => t.agent === id && t.status === 'assigned');
      agents[id] = {
        spent: a.spent,
        reserved: a.reserved,
        remaining: this.remaining(id),
        status: active ? 'investigating' : this.remaining(id) <= 0 ? 'exhausted' : 'idle',
        current: active ? active.question : null,
      };
    }
    return {
      round: this.round,
      max_rounds: this.maxRounds,
      status: this.status,
      robustness: this.robustness.length ? this.robustness[this.robustness.length - 1].value : null,
      agents,
    };
  }

  emit(type, data) {
    const event = { seq: this.events.length + 1, ts: new Date().toISOString(), type, data };
    event.summary = this.summary();
    this.events.push(event);
    for (const fn of this.listeners) fn(event);
    return event;
  }

  // --- Investigation queue -------------------------------------------------

  enqueue(proposal, { origin, requestedBy = null, parent = null }) {
    const agent = normalizeAgent(proposal.agent);
    const question = String(proposal.question || '').trim();
    if (!agent || !question) {
      this.emit('task_rejected', { proposal, reason: !agent ? `unknown agent "${proposal.agent}"` : 'empty question' });
      return null;
    }
    const duplicate = [...this.queue, ...this.tasks].some(
      (t) => t.agent === agent && t.question.toLowerCase() === question.toLowerCase(),
    );
    if (duplicate) return null;
    const task = {
      id: `T${++this.seq.task}`,
      agent,
      question,
      type: proposal.type === 'challenge' ? 'challenge' : 'investigate',
      target_claim_id: proposal.target_claim_id || null,
      reason: proposal.reason || null,
      requested_credits: clampInt(proposal.credits, 1, RULES.maxCreditsPerTask, 2),
      origin,
      requested_by: requestedBy,
      parent,
      status: 'queued',
      round: null,
      credits: 0,
    };
    this.queue.push(task);
    this.emit('task_queued', { task });
    return task;
  }

  // Pull the next round's work from the queue. Judge orders go first, then
  // challenges of existing claims, then agents' self-directed follow-ups.
  openRound() {
    const priority = { judge: 0, delegation: 2, agent: 3 };
    this.queue.sort((a, b) =>
      (priority[a.origin] ?? 9) - (priority[b.origin] ?? 9)
      || (a.type === 'challenge' ? -1 : 0) - (b.type === 'challenge' ? -1 : 0));

    const picked = [];
    const kept = [];
    for (const task of this.queue) {
      if (picked.length >= RULES.maxTasksPerRound) { kept.push(task); continue; }
      const available = this.remaining(task.agent);
      if (available <= 0) {
        task.status = 'rejected';
        this.tasks.push(task);
        this.emit('task_rejected', { task, reason: `${task.agent} has no investigation credits left` });
        continue;
      }
      task.credits = Math.min(task.requested_credits, available);
      task.status = 'assigned';
      this.agents[task.agent].reserved += task.credits;
      picked.push(task);
    }
    this.queue = kept;
    if (!picked.length) return [];

    this.round += 1;
    for (const task of picked) {
      task.round = this.round;
      this.tasks.push(task);
    }
    this.emit('round_started', { round: this.round, tasks: picked });
    const blackboard = this.digest();
    return picked.map((task) => ({
      task_id: task.id,
      agent: task.agent,
      question: task.question,
      type: task.type,
      target_claim_id: task.target_claim_id,
      reason: task.reason,
      origin: task.origin,
      requested_by: task.requested_by,
      credits: task.credits,
      credits_left_after: this.remaining(task.agent),
      round: this.round,
      max_rounds: this.maxRounds,
      forecast: this.forecast,
      blackboard,
    }));
  }

  // --- n8n callbacks -------------------------------------------------------

  applyPlan(raw) {
    const plan = parseLoose(raw);
    const scope = typeof plan.scope === 'string' ? plan.scope.trim().toLowerCase() : 'forecast';
    if (REJECTIONS[scope] && !this.force) {
      this.status = 'rejected';
      this.stopReason = REJECTIONS[scope];
      this.emit('rejected', {
        scope,
        title: REJECTIONS[scope],
        reason: plan.scope_reason || '',
        suggested_forecast: plan.suggested_forecast || null,
      });
      return { continue: false, round: 0, rejected: true, tasks: [] };
    }
    if (REJECTIONS[scope]) this.emit('scope_overridden', { scope, reason: plan.scope_reason || '' });
    this.forecastLabel = plan.forecast_label || null;
    this.forecastValue = plan.forecast_value || null;
    this.assumptions = asArray(plan.assumptions).slice(0, 8).map((a, i) => ({
      id: a.id || `A${i + 1}`,
      text: String(a.text || a.assumption || a).trim(),
      load: clamp01(a.load_bearing ?? a.load, 0.5),
      status: 'untested',
    }));
    this.emit('plan', {
      forecast_label: this.forecastLabel,
      forecast_value: this.forecastValue,
      horizon: plan.horizon || null,
      assumptions: this.assumptions,
    });
    for (const t of asArray(plan.tasks)) this.enqueue(t, { origin: 'judge', requestedBy: 'judge' });
    // Every adversary gets at least an opening move, even if the judge forgot it.
    for (const agent of AGENT_IDS) {
      if (!this.queue.some((t) => t.agent === agent)) {
        this.enqueue({ agent, question: `Opening attack: ${AGENTS.find((a) => a.id === agent).mission}`, credits: 2 },
          { origin: 'judge', requestedBy: 'judge' });
      }
    }
    const tasks = this.openRound();
    return { continue: tasks.length > 0, round: this.round, tasks };
  }

  recordFinding({ task_id, output, steps }) {
    const task = this.tasks.find((t) => t.id === task_id);
    if (!task) throw httpError(404, `unknown task ${task_id}`);
    if (task.status !== 'assigned') throw httpError(409, `task ${task_id} already ${task.status}`);

    const out = parseLoose(output);
    const failed = Boolean(out.error && !out.headline);
    if (failed) {
      Object.assign(out, { headline: 'Investigation failed', stance: 'neutral', confidence: 0, argument: String(out.error), done: true });
    }
    const toolCalls = asArray(steps)
      .map((s) => s?.action?.tool || s?.tool)
      .filter((name) => name && name !== 'format_final_json_response');
    // Agents pay for every tool call, even beyond this task's allocation; a run
    // that blew through its iteration cap forfeits the whole allocation.
    const billed = failed ? task.credits : Math.max(1, toolCalls.length);
    const charged = Math.min(billed, task.credits + Math.max(0, this.remaining(task.agent)));

    const agent = this.agents[task.agent];
    agent.reserved -= task.credits;
    agent.spent += charged;
    task.status = 'done';
    task.charged = charged;

    const evidence = asArray(out.evidence).slice(0, 8).map((e) => (typeof e === 'string' ? { fact: e } : {
      fact: String(e.fact || e.claim || '').trim(),
      source: e.source || null,
      url: e.url || null,
      date: e.date || null,
      domain: domainOf(e.url) || (e.source ? String(e.source).toLowerCase() : null),
    })).filter((e) => e.fact);

    const stance = ['attacks', 'supports', 'neutral'].includes(out.stance) ? out.stance
      : task.agent === 'bull' ? 'supports' : 'attacks';
    const claim = {
      id: `C${++this.seq.claim}`,
      task_id: task.id,
      agent: task.agent,
      round: task.round,
      stance,
      headline: String(out.headline || out.claim || 'No headline').trim(),
      argument: String(out.argument || '').trim(),
      mechanism: String(out.causal_mechanism || out.mechanism || '').trim(),
      target_assumption: out.target_assumption || null,
      challenges_claim: out.challenges_claim || task.target_claim_id || null,
      confidence: clamp01(out.confidence, 0.5),
      evidence,
      scenario: out.scenario && typeof out.scenario === 'object' ? out.scenario : null,
      indicators: asArray(out.indicators_to_watch).slice(0, 5),
      tools: toolCalls,
      credits_spent: charged,
      status: 'unresolved',
    };
    this.claims.push(claim);
    this.emit('finding', { claim, task });

    if (out.done !== true) {
      for (const f of asArray(out.follow_ups).slice(0, RULES.maxFollowUpsPerFinding)) {
        const target = normalizeAgent(f.agent) || task.agent;
        this.enqueue(f, {
          origin: target === task.agent ? 'agent' : 'delegation',
          requestedBy: task.agent,
          parent: task.id,
        });
      }
    }
    return { claim_id: claim.id, charged, credits_left: this.remaining(task.agent) };
  }

  // Called once every investigator of the round has returned (or timed out).
  // Anything still assigned never reported back: release its credits.
  closeRound() {
    for (const task of this.tasks.filter((t) => t.status === 'assigned')) {
      task.status = 'lost';
      this.agents[task.agent].reserved -= task.credits;
      this.emit('task_rejected', { task, reason: 'investigation never reported back (crashed or timed out)' });
    }
    return { round: this.round, max_rounds: this.maxRounds, digest: this.digest() };
  }

  applyRulings(raw) {
    const r = parseLoose(raw);
    const rulings = asArray(r.rulings).map((x) => ({
      claim_id: x.claim_id,
      status: ['survives', 'falls', 'unresolved'].includes(x.status) ? x.status : 'unresolved',
      reason: x.reason || '',
      flags: asArray(x.flags),
    }));
    for (const ruling of rulings) {
      const claim = this.claims.find((c) => c.id === ruling.claim_id);
      if (claim) claim.status = ruling.status;
    }
    for (const a of asArray(r.assumption_status)) {
      const assumption = this.assumptions.find((x) => x.id === a.id);
      if (assumption && a.status) assumption.status = a.status;
    }
    const contradictions = asArray(r.contradictions);
    this.contradictions.push(...contradictions.map((c) => ({ ...c, round: this.round })));
    const robustness = clampInt(r.robustness_estimate, 0, 100, null);
    if (robustness !== null) this.robustness.push({ round: this.round, value: robustness });
    this.rulings.push({ round: this.round, summary: r.round_summary || '', rulings, sufficient: !!r.sufficient });

    this.emit('ruling', {
      round: this.round,
      summary: r.round_summary || '',
      rulings,
      contradictions,
      missing_information: asArray(r.missing_information),
      robustness,
      sufficient: !!r.sufficient,
      assumptions: this.assumptions,
    });

    for (const t of asArray(r.new_investigations)) this.enqueue(t, { origin: 'judge', requestedBy: 'judge' });

    let reason = null;
    if (r.sufficient && this.round >= RULES.minRounds) reason = 'judge ruled the evidence sufficient';
    else if (this.round >= this.maxRounds) reason = `round limit (${this.maxRounds}) reached`;
    const tasks = reason ? [] : this.openRound();
    if (!reason && !tasks.length) {
      reason = AGENT_IDS.every((id) => this.remaining(id) <= 0)
        ? 'every agent is out of credits'
        : 'no open investigations left';
    }
    if (reason) {
      this.stopReason = reason;
      this.emit('deliberation_closed', { reason, round: this.round });
    }
    return { continue: !reason, round: this.round, reason, tasks };
  }

  applyVerdict(raw) {
    const v = parseLoose(raw);
    v.robustness = clampInt(v.robustness, 0, 100, this.robustness.at(-1)?.value ?? 50);
    v.confidence = clampInt(v.confidence, 0, 100, null);
    v.leaderboard = this.leaderboard(asArray(v.agent_scores));
    this.verdict = v;
    this.status = 'done';
    this.emit('verdict', { verdict: v });
    return { ok: true };
  }

  fail(message) {
    this.status = 'error';
    this.emit('error', { message: String(message || 'unknown error') });
  }

  // Agents are rewarded for arguments that survive cross-examination: the
  // bear side for attacks that stand, the bull for defences that stand.
  leaderboard(judgeScores) {
    return AGENTS.map((a) => {
      const mine = this.claims.filter((c) => c.agent === a.id);
      const points = mine.reduce((sum, c) => sum + (c.status === 'survives' ? 3 : c.status === 'falls' ? -1 : 1), 0);
      const judged = judgeScores.find((s) => normalizeAgent(s.agent) === a.id);
      return {
        agent: a.id,
        points,
        claims: mine.length,
        survived: mine.filter((c) => c.status === 'survives').length,
        credits_spent: this.agents[a.id].spent,
        judge_note: judged?.reason || null,
      };
    }).sort((x, y) => y.points - x.points);
  }

  // --- What the agents and the judge see ------------------------------------

  digest() {
    const lines = [];
    lines.push(`FORECAST UNDER ATTACK: ${this.forecast}`);
    lines.push(`ROUND: ${this.round} of max ${this.maxRounds}`);
    lines.push('', 'LOAD-BEARING ASSUMPTIONS:');
    for (const a of this.assumptions) lines.push(`${a.id} [load ${a.load.toFixed(2)}] [${a.status}] ${a.text}`);

    lines.push('', 'CLAIMS ON THE BLACKBOARD:');
    if (!this.claims.length) lines.push('(none yet)');
    for (const c of this.claims) {
      lines.push(`${c.id} | ${c.agent} | round ${c.round} | ${c.stance.toUpperCase()}${c.target_assumption ? ` ${c.target_assumption}` : ''}`
        + `${c.challenges_claim ? ` | challenges ${c.challenges_claim}` : ''} | confidence ${c.confidence.toFixed(2)} | status ${c.status}`);
      lines.push(`   headline: ${c.headline}`);
      if (c.mechanism) lines.push(`   mechanism: ${c.mechanism}`);
      if (c.argument) lines.push(`   argument: ${c.argument.slice(0, 600)}`);
      for (const e of c.evidence) {
        lines.push(`   evidence: ${e.fact}${e.source ? ` — ${e.source}` : ''}${e.date ? ` (${e.date})` : ''}${e.url ? ` <${e.url}>` : ''}`);
      }
      if (c.scenario) lines.push(`   scenario: ${JSON.stringify(c.scenario)}`);
      lines.push(`   tools used: ${c.tools.join(', ') || 'none (reasoning only)'}`);
    }

    const sources = {};
    for (const c of this.claims) {
      for (const d of new Set(c.evidence.map((e) => e.domain).filter(Boolean))) (sources[d] ||= []).push(c.id);
    }
    const shared = Object.entries(sources).filter(([, ids]) => ids.length > 1);
    lines.push('', 'SOURCE CONCENTRATION (claims citing the same source are not independent):');
    lines.push(shared.length ? shared.map(([d, ids]) => `${d}: ${ids.join(', ')}`).join('\n') : '(no shared sources)');

    if (this.rulings.length) {
      lines.push('', 'PREVIOUS JUDGE RULINGS:');
      for (const r of this.rulings) lines.push(`round ${r.round}: ${r.summary}`);
    }
    if (this.contradictions.length) {
      lines.push('', 'OPEN CONTRADICTIONS:');
      for (const c of this.contradictions) lines.push(`- ${asArray(c.between).join(' vs ')}: ${c.issue || ''}${c.resolving_data ? ` (resolve with: ${c.resolving_data})` : ''}`);
    }
    lines.push('', 'INVESTIGATION CREDITS LEFT:');
    lines.push(AGENT_IDS.map((id) => `${id} ${this.remaining(id)}/${RULES.creditsPerAgent}`).join(', '));
    if (this.queue.length) {
      lines.push('', 'ALREADY QUEUED FOR NEXT ROUND:');
      for (const t of this.queue) lines.push(`- ${t.agent}: ${t.question}`);
    }
    return lines.join('\n');
  }

  snapshot() {
    return {
      id: this.id,
      forecast: this.forecast,
      forecast_label: this.forecastLabel,
      forecast_value: this.forecastValue,
      mode: this.mode,
      status: this.status,
      stop_reason: this.stopReason,
      round: this.round,
      max_rounds: this.maxRounds,
      assumptions: this.assumptions,
      agents: this.summary().agents,
      tasks: this.tasks,
      queue: this.queue,
      claims: this.claims,
      rulings: this.rulings,
      contradictions: this.contradictions,
      robustness: this.robustness,
      verdict: this.verdict,
    };
  }
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

module.exports = { Run, RULES, REJECTIONS, AGENTS, AGENT_IDS, normalizeAgent, parseLoose, httpError };
