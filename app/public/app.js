// War-room UI: starts a run, subscribes to its event stream and renders the
// adversarial debate as it happens. All agent text is untrusted LLM output,
// so everything goes through textContent (see el()).

const $ = (sel) => document.querySelector(sel);
const state = { agents: [], byId: {}, mode: 'simulate', source: null, robustness: [], tasks: new Map() };

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'href') { if (/^https?:\/\//i.test(v)) node.href = v; }
    else node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const agentName = (id) => (id === 'judge' ? 'Judge' : state.byId[id]?.name || id);
const ORIGIN_LABEL = { judge: 'judge ordered', agent: 'self-directed', delegation: 'delegated' };

// --- boot -------------------------------------------------------------------------
async function boot() {
  const config = await fetch('/api/config').then((r) => r.json());
  state.agents = config.agents;
  state.byId = Object.fromEntries(config.agents.map((a) => [a.id, a]));
  state.mode = config.mode;
  const badge = $('#mode-badge');
  if (config.mode === 'n8n') {
    badge.textContent = 'n8n agents connected';
    badge.classList.add('live');
    $('#engine-field').hidden = false;
  } else {
    badge.textContent = 'Simulation · scripted demo';
    badge.classList.add('sim');
  }
  renderAgents(null);
  $('#attack').addEventListener('click', () => attack());
}

// force=true skips the judge's scope check ("Run anyway").
async function attack({ force = false } = {}) {
  const forecast = $('#forecast').value.trim();
  const engine = state.mode === 'n8n' ? $('#engine').value : 'simulate';
  $('#attack').disabled = true;
  resetBoard();
  try {
    const res = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // ?speed=4 replays the scripted demo four times faster.
      body: JSON.stringify({ forecast, max_rounds: Number($('#rounds').value), mode: engine, force, speed: Number(new URLSearchParams(location.search).get('speed')) || 1 }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.statusText);
    if (body.mode === 'simulate') showBanner('Scripted demo: the debate below is illustrative, not live evidence. Connect n8n for real agent runs.');
    listen(body.run_id);
  } catch (err) {
    showBanner(err.message, true);
    $('#attack').disabled = false;
  }
}

function listen(runId) {
  state.source?.close();
  const source = new EventSource(`/api/runs/${runId}/stream`);
  state.source = source;
  source.onmessage = (msg) => {
    const event = JSON.parse(msg.data);
    renderAgents(event.summary);
    const handler = HANDLERS[event.type];
    if (handler) handler(event.data, event);
    if (event.summary.round) $('#round-label').textContent = `round ${event.summary.round} of ${event.summary.max_rounds}`;
    if (['verdict', 'error', 'rejected'].includes(event.type)) {
      source.close();
      $('#attack').disabled = false;
    }
  };
}

function resetBoard() {
  $('#log').replaceChildren();
  $('#verdict').hidden = true;
  $('#verdict').replaceChildren();
  $('#banner').hidden = true;
  $('#round-label').textContent = '';
  $('#robustness').textContent = '—';
  $('#spark').replaceChildren();
  $('#assumptions').replaceChildren(el('li', { class: 'hint' }, 'Waiting for the judge\'s decomposition'));
  $('#tree').replaceChildren();
  state.robustness = [];
  state.tasks.clear();
}

function showBanner(text, isError = false) {
  const b = $('#banner');
  b.textContent = text;
  b.className = `banner${isError ? ' error' : ''}`;
  b.hidden = false;
}

function log(node) {
  $('#log').append(node);
  if (window.scrollY + window.innerHeight > document.body.scrollHeight - 400) node.scrollIntoView({ block: 'end', behavior: 'smooth' });
}

// --- agents column --------------------------------------------------------------------
function renderAgents(summary) {
  const wrap = $('#agents');
  wrap.replaceChildren(...state.agents.map((a) => {
    const s = summary?.agents?.[a.id] || { spent: 0, reserved: 0, remaining: 10, status: 'idle' };
    const total = s.spent + s.reserved + s.remaining;
    const pips = Array.from({ length: total }, (_, i) =>
      el('span', { class: `pip ${i < s.spent ? 'spent' : i < s.spent + s.reserved ? 'reserved' : ''}` }));
    return el('div', { class: `agent ${a.side} ${s.status}` },
      el('div', { class: 'agent-head' },
        el('span', { class: 'glyph' }, a.glyph),
        el('div', {}, el('div', { class: 'agent-name' }, a.name), el('div', { class: 'agent-mission' }, a.mission)),
        el('span', { class: 'state' }, s.status)),
      el('div', { class: 'credits', title: `${s.spent} spent · ${s.reserved} committed · ${s.remaining} free` },
        pips, el('span', { class: 'credit-count' }, `${s.remaining}`)),
      s.current && el('div', { class: 'current' }, s.current));
  }), el('div', { class: 'agent judge' },
    el('div', { class: 'agent-head' },
      el('span', { class: 'glyph' }, '§'),
      el('div', {}, el('div', { class: 'agent-name' }, 'Judge'),
        el('div', { class: 'agent-mission' }, 'Cross-examines. Cannot search — can only order investigations.')))));
}

// --- event handlers -----------------------------------------------------------------------
const HANDLERS = {
  run_started(d) {
    log(el('div', { class: 'row' }, el('span', { class: 'tag judge' }, 'filed'), el('span', {}, 'Forecast submitted: ', el('b', {}, d.forecast))));
  },

  n8n_started() {
    log(el('div', { class: 'row' }, el('span', { class: 'tag' }, 'n8n'), 'Workflow started. The judge is decomposing the forecast…'));
  },

  plan(d) {
    renderAssumptions(d.assumptions);
    log(el('article', { class: 'card ruling' },
      el('div', { class: 'ruling-head' }, 'Judge · decomposition'),
      el('p', {}, `${d.forecast_label || 'Forecast'}: `, el('b', {}, d.forecast_value || ''), d.horizon ? ` (${d.horizon})` : ''),
      el('dl', { class: 'sub' }, el('dt', {}, 'Load-bearing assumptions'),
        d.assumptions.map((a) => el('dd', {}, `${a.id} · ${a.text}`)))));
  },

  task_queued(d) {
    const t = d.task;
    state.tasks.set(t.id, t);
    renderTree();
    if (t.origin === 'judge') return; // shown when the round opens
    const verb = t.origin === 'delegation'
      ? [el('b', {}, agentName(t.requested_by)), ' delegated to ', el('b', {}, agentName(t.agent)), ': ']
      : [el('b', {}, agentName(t.agent)), ' wants to dig further: '];
    log(el('div', { class: 'row' }, el('span', { class: `tag ${t.origin}` }, ORIGIN_LABEL[t.origin]), el('span', {}, ...verb, t.question)));
  },

  task_rejected(d) {
    if (d.task) { state.tasks.set(d.task.id, d.task); renderTree(); }
    log(el('div', { class: 'row' }, el('span', { class: 'tag rejected' }, 'rejected'),
      el('span', {}, d.task ? `${agentName(d.task.agent)}: ${d.task.question} — ` : '', d.reason)));
  },

  round_started(d) {
    for (const t of d.tasks) state.tasks.set(t.id, { ...state.tasks.get(t.id), ...t, status: 'assigned' });
    renderTree();
    log(el('div', { class: 'round-head' }, `Round ${d.round}`));
    for (const t of d.tasks) {
      log(el('div', { class: 'row' },
        el('span', { class: `tag ${t.origin}` }, `${t.id} · ${t.credits}cr`),
        el('span', {}, el('b', {}, agentName(t.agent)), t.type === 'challenge' ? ` challenges ${t.target_claim_id || ''}: ` : ' investigates: ', t.question)));
    }
  },

  finding(d) {
    const c = d.claim;
    const t = state.tasks.get(d.task.id);
    if (t) { t.status = 'done'; renderTree(); }
    const stanceText = `${c.stance}${c.target_assumption ? ` ${c.target_assumption}` : ''}`;
    log(el('article', { class: `card claim ${c.stance}`, 'data-claim': c.id },
      el('header', { class: 'claim-head' },
        el('span', { class: 'cid' }, c.id),
        el('span', { class: 'who' }, agentName(c.agent)),
        el('span', { class: 'stance' }, stanceText),
        c.challenges_claim && el('span', { class: 'tag' }, `vs ${c.challenges_claim}`),
        el('span', { class: 'status' }, c.status)),
      el('h3', {}, c.headline),
      c.argument && el('p', {}, c.argument),
      c.mechanism && el('p', { class: 'mech' }, `→ ${c.mechanism}`),
      c.scenario && el('dl', { class: 'scenario' },
        ['event', 'transmission', 'impact', 'probability'].filter((k) => c.scenario[k]).flatMap((k) => [el('dt', {}, k), el('dd', {}, c.scenario[k])]),
        c.scenario.indicators && [el('dt', {}, 'watch'), el('dd', {}, [].concat(c.scenario.indicators).join(' · '))]),
      c.evidence.length > 0 && el('ul', { class: 'evidence' }, c.evidence.map((e) => el('li', {},
        e.fact, ' ',
        el('span', { class: 'src' }, '— ', e.url ? el('a', { href: e.url, target: '_blank', rel: 'noopener' }, e.source || e.domain || 'source') : (e.source || ''), e.date ? `, ${e.date}` : '')))),
      el('footer', { class: 'claim-foot' },
        el('span', { class: 'conf' }, 'confidence', el('span', { class: 'conf-bar' }, el('span', { style: `width:${Math.round(c.confidence * 100)}%` })), `${Math.round(c.confidence * 100)}%`),
        el('span', {}, `−${c.credits_spent} credit${c.credits_spent === 1 ? '' : 's'}`),
        el('span', {}, c.tools.length ? `tools: ${c.tools.join(', ')}` : 'no tools used'))));
  },

  ruling(d) {
    renderAssumptions(d.assumptions);
    for (const r of d.rulings) {
      const card = document.querySelector(`[data-claim="${CSS.escape(r.claim_id)}"]`);
      if (!card) continue;
      const badge = card.querySelector('.status');
      badge.textContent = r.status;
      badge.className = `status ${r.status}`;
      card.classList.toggle('fell', r.status === 'falls');
    }
    if (d.robustness !== null && d.robustness !== undefined) {
      state.robustness.push(d.robustness);
      $('#robustness').textContent = d.robustness;
      renderSpark();
    }
    log(el('article', { class: 'card ruling' },
      el('div', { class: 'ruling-head' }, `Judge · round ${d.round} ruling`, d.robustness !== null && el('span', { class: 'score' }, `robustness ${d.robustness}`)),
      el('p', {}, d.summary),
      d.rulings.length > 0 && el('div', { class: 'chips' }, d.rulings.map((r) =>
        el('span', { class: `chip ${r.status}`, title: `${r.reason}${r.flags?.length ? ` [${r.flags.join(', ')}]` : ''}` }, `${r.claim_id} ${r.status}`))),
      (d.contradictions.length > 0 || d.missing_information.length > 0) && el('dl', { class: 'sub' },
        d.contradictions.length > 0 && [el('dt', {}, 'Contradictions'),
          d.contradictions.map((c) => el('dd', {}, `${[].concat(c.between || []).join(' vs ')}: ${c.issue}${c.resolving_data ? ` → resolve with ${c.resolving_data}` : ''}`))],
        d.missing_information.length > 0 && [el('dt', {}, 'Missing information'), d.missing_information.map((m) => el('dd', {}, m))])));
  },

  rejected(d) {
    const actions = el('div', { class: 'actions' });
    if (d.suggested_forecast) {
      const use = el('button', { type: 'button', class: 'btn primary' }, 'Attack the suggested forecast');
      use.addEventListener('click', () => { $('#forecast').value = d.suggested_forecast; attack(); });
      actions.append(use);
    }
    const anyway = el('button', { type: 'button', class: 'btn' }, 'Run anyway');
    anyway.addEventListener('click', () => attack({ force: true }));
    actions.append(anyway);
    log(el('article', { class: 'card ruling gate' },
      el('div', { class: 'ruling-head' }, `Judge · scope check · ${d.title}`),
      el('p', {}, d.reason || 'The judge could not find a testable economic forecast in this text.'),
      d.suggested_forecast && el('p', { class: 'suggestion' }, 'Did you mean: ', el('b', {}, d.suggested_forecast)),
      el('p', { class: 'hint' }, 'No agents were dispatched and no credits were spent. Macro Red Team reviews economic, market and business forecasts.'),
      actions));
  },

  scope_overridden(d) {
    log(el('div', { class: 'row' }, el('span', { class: 'tag judge' }, 'override'),
      el('span', {}, `Scope check said "${d.scope}"; running anyway as requested.`)));
  },

  deliberation_closed(d) {
    log(el('div', { class: 'closed' }, `Deliberation closed — ${d.reason}. Judge is writing the verdict…`));
  },

  verdict(d) { renderVerdict(d.verdict); },

  error(d) { showBanner(d.message, true); },
};

// --- side panels ------------------------------------------------------------------------
function renderAssumptions(list) {
  if (!list?.length) return;
  const tone = (s) => (/fragile|broken|weak|attack/i.test(s) ? 'bad' : /holding|robust/i.test(s) ? 'good' : '');
  $('#assumptions').replaceChildren(...list.map((a) => el('li', {},
    el('div', { class: 'a-head' }, el('span', { class: 'a-id' }, a.id), el('span', { class: `a-status ${tone(a.status)}` }, a.status)),
    el('div', {}, a.text),
    el('div', { class: 'load', title: `load-bearing ${Math.round(a.load * 100)}%` }, el('span', { style: `width:${Math.round(a.load * 100)}%` })))));
}

function renderTree() {
  const tasks = [...state.tasks.values()];
  const children = (parent) => tasks.filter((t) => (t.parent || null) === parent);
  const items = [];
  const walk = (parent, depth) => {
    for (const t of children(parent)) {
      items.push(el('li', { class: t.status, style: `padding-left:${depth * 14}px`, title: t.question },
        el('span', { class: 'tid' }, `${depth ? '↳ ' : ''}${t.id}`),
        el('span', { class: 'q' }, `${agentName(t.agent)} · ${t.question}`)));
      walk(t.id, depth + 1);
    }
  };
  walk(null, 0);
  $('#tree').replaceChildren(...(items.length ? items : [el('li', { class: 'hint' }, 'No investigations yet')]));
}

function renderSpark() {
  const values = state.robustness;
  const svg = $('#spark');
  const ns = 'http://www.w3.org/2000/svg';
  const x = (i) => (values.length === 1 ? 100 : (i / (values.length - 1)) * 200);
  // Zoom the y-axis around the observed range so a 72 -> 58 slide is visible.
  const lo = Math.max(0, Math.min(...values) - 10);
  const hi = Math.min(100, Math.max(...values) + 10);
  const y = (v) => 46 - ((v - lo) / (hi - lo || 1)) * 44;
  const line = document.createElementNS(ns, 'polyline');
  line.setAttribute('points', values.map((v, i) => `${x(i)},${y(v)}`).join(' '));
  const dots = values.map((v, i) => {
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', x(i)); c.setAttribute('cy', y(v)); c.setAttribute('r', 2.5);
    return c;
  });
  svg.replaceChildren(line, ...dots);
}

// --- verdict ---------------------------------------------------------------------------------
function renderVerdict(v) {
  const filled = Math.round((v.robustness ?? 0) / 10);
  const bar = el('div', { class: 'bar' },
    el('span', { class: 'segments', 'aria-hidden': 'true' }, Array.from({ length: 10 }, (_, i) => el('i', { class: i < filled ? 'on' : '' }))),
    `${v.robustness}%`);
  const list = (items, ordered = false) => el(ordered ? 'ol' : 'ul', {}, [].concat(items || []).map((i) => el('li', {}, i)));
  const section = (title, ...body) => el('div', { class: 'vsec' }, el('h3', {}, title), ...body);
  const breaks = [].concat(v.break_conditions || []);
  const logic = v.break_logic || 'AND';

  const box = el('div', { class: 'verdict-box' },
    el('div', { class: 'verdict-title' }, 'Forecast red team'),
    el('div', { class: 'verdict-top' },
      el('div', { class: 'vstat' }, el('h3', { class: 'eyebrow' }, v.forecast_label || 'Forecast'), el('div', { class: 'big' }, v.forecast_value || '—')),
      el('div', { class: 'vstat' }, el('h3', { class: 'eyebrow' }, 'Robustness'), bar,
        el('div', { class: 'hint' }, `Judge confidence ${v.confidence ?? '—'}% · vulnerability ${v.vulnerability || '—'}`)),
      el('div', { class: 'vstat' }, el('h3', { class: 'eyebrow' }, 'Verdict'), el('div', { class: `big verdict-word ${v.verdict}` }, v.verdict || '—'))),
    el('div', { class: 'verdict-body' },
      section('Primary vulnerability', el('p', {}, v.primary_vulnerability || '—')),
      section('Secondary vulnerability', el('p', {}, v.secondary_vulnerability || '—')),
      section('Strongest opposing evidence', el('p', {}, v.strongest_opposing_evidence || '—')),
      section('Strongest supporting evidence', el('p', {}, v.strongest_supporting_evidence || '—')),
      section('Critical unknown', el('p', {}, v.critical_unknown || '—')),
      section('Most dangerous scenario', el('p', {}, v.most_dangerous_scenario || '—')),
      section('What would break the forecast?', ...breaks.flatMap((b, i) => [
        i > 0 && el('div', { class: 'logic' }, logic), el('div', { class: 'cond' }, b)])),
      section('What would validate it?', el('div', { class: 'cond' }, list(v.validate_conditions))),
      section('Next data to watch', el('ol', {}, [].concat(v.watchlist || []).map((w) =>
        el('li', {}, el('b', {}, w.indicator || w), w.why ? ` — ${w.why}` : '', w.threshold ? ` (${w.threshold})` : '')))),
      section('Agent leaderboard', el('table', { class: 'board' }, (v.leaderboard || []).map((r) => el('tr', { title: r.judge_note || '' },
        el('td', {}, agentName(r.agent), r.judge_note ? ' ★' : ''),
        el('td', { class: 'n' }, `${r.survived}/${r.claims} survived`),
        el('td', { class: 'n' }, `${r.points} pts`)))))));

  const wrap = $('#verdict');
  wrap.replaceChildren(box);
  wrap.hidden = false;
  wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

boot();
