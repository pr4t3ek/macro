const test = require('node:test');
const assert = require('node:assert/strict');
const { Run, RULES, AGENT_IDS, normalizeAgent, parseLoose } = require('../referee');
const { simulate } = require('../simulator');

const newRun = (maxRounds = 4) => new Run({ forecast: 'India GDP growth will be 7% in FY28', maxRounds, mode: 'test' });
const toolSteps = (n) => Array.from({ length: n }, () => ({ action: { tool: 'Web_Search' } }));

test('plan opens round 1 with an opening task for every agent', () => {
  const run = newRun();
  const res = run.applyPlan({ assumptions: [{ id: 'A1', text: 'x', load_bearing: 0.8 }], tasks: [{ agent: 'Data Detective', question: 'Back-solve the forecast', credits: 3 }] });
  assert.equal(res.continue, true);
  assert.equal(res.round, 1);
  assert.deepEqual(new Set(res.tasks.map((t) => t.agent)), new Set(AGENT_IDS));
  const data = res.tasks.find((t) => t.agent === 'data');
  assert.equal(data.credits, 3);
  assert.equal(run.remaining('data'), RULES.creditsPerAgent - 3, 'credits are reserved while the task runs');
  assert.match(data.blackboard, /LOAD-BEARING ASSUMPTIONS/);
});

test('agents pay for actual tool calls, including overspend, but never below zero', () => {
  const run = newRun();
  const { tasks } = run.applyPlan({ tasks: [{ agent: 'demand', question: 'q', credits: 2 }] });
  const demand = tasks.find((t) => t.agent === 'demand');
  const r = run.recordFinding({ task_id: demand.task_id, output: { headline: 'h', stance: 'attacks', done: true }, steps: toolSteps(5) });
  assert.equal(r.charged, 5);
  assert.equal(run.remaining('demand'), 5);

  const huge = run.enqueue({ agent: 'demand', question: 'again', credits: 4 }, { origin: 'agent' });
  run.openRound();
  run.recordFinding({ task_id: huge.id, output: { headline: 'h', done: true }, steps: toolSteps(20) });
  assert.equal(run.remaining('demand'), 0);
});

test('reasoning-only answers cost one credit; failed runs forfeit the allocation', () => {
  const run = newRun();
  const { tasks } = run.applyPlan({ tasks: [{ agent: 'bull', question: 'q', credits: 3 }, { agent: 'global', question: 'q', credits: 3 }] });
  const bull = tasks.find((t) => t.agent === 'bull');
  const global = tasks.find((t) => t.agent === 'global');
  assert.equal(run.recordFinding({ task_id: bull.task_id, output: { headline: 'h', done: true }, steps: [] }).charged, 1);
  assert.equal(run.recordFinding({ task_id: global.task_id, output: { error: 'Max iterations (5) reached' }, steps: [] }).charged, 3);
  assert.equal(run.claims.at(-1).headline, 'Investigation failed');
});

test('follow-ups become self-directed or delegated tasks for the next round', () => {
  const run = newRun();
  const { tasks } = run.applyPlan({ tasks: [] });
  const data = tasks.find((t) => t.agent === 'data');
  run.recordFinding({
    task_id: data.task_id,
    output: {
      headline: 'h', done: false,
      follow_ups: [
        { agent: 'data', question: 'Who forecasts capex?', credits: 2 },
        { agent: 'Global Shock Agent', question: 'Check the oil channel', credits: 2 },
        { agent: 'bull', question: 'third one is dropped', credits: 1 },
      ],
    },
    steps: toolSteps(1),
  });
  const origins = run.queue.map((t) => [t.agent, t.origin, t.requested_by, t.parent]);
  assert.deepEqual(origins, [['data', 'agent', 'data', data.task_id], ['global', 'delegation', 'data', data.task_id]]);
});

test('task with no credits left is rejected when the round opens', () => {
  const run = newRun();
  run.agents.bull.spent = RULES.creditsPerAgent;
  const { tasks } = run.applyPlan({ tasks: [] });
  assert.ok(!tasks.some((t) => t.agent === 'bull'));
  assert.ok(run.events.some((e) => e.type === 'task_rejected' && e.data.task?.agent === 'bull'));
});

function finishRound(run, tasks) {
  for (const t of tasks) run.recordFinding({ task_id: t.task_id, output: { headline: 'h', done: true }, steps: toolSteps(1) });
}

test('judge cannot stop before the minimum rounds; round limit stops the loop', () => {
  const run = newRun(3);
  let res = run.applyPlan({ tasks: [] });
  finishRound(run, res.tasks);
  res = run.applyRulings({ sufficient: true, robustness_estimate: 70, new_investigations: [{ agent: 'bull', question: 'Rebut C1', credits: 1, type: 'challenge', target_claim_id: 'C1' }] });
  assert.equal(res.continue, true, 'sufficient in round 1 is overridden');
  assert.equal(res.tasks[0].type, 'challenge');
  finishRound(run, res.tasks);
  res = run.applyRulings({ sufficient: false, new_investigations: [{ agent: 'data', question: 'More', credits: 1 }] });
  assert.equal(res.continue, true);
  finishRound(run, res.tasks);
  res = run.applyRulings({ sufficient: false, new_investigations: [{ agent: 'data', question: 'Even more', credits: 1 }] });
  assert.equal(res.continue, false);
  assert.match(res.reason, /round limit/);
});

test('rulings update claim status and drive the leaderboard', () => {
  const run = newRun();
  const { tasks } = run.applyPlan({ tasks: [] });
  finishRound(run, tasks);
  run.applyRulings({ rulings: [{ claim_id: 'C1', status: 'survives' }, { claim_id: 'C2', status: 'falls' }], sufficient: false });
  assert.equal(run.claims[0].status, 'survives');
  run.applyVerdict({ robustness: 58, verdict: 'Fragile' });
  const board = run.verdict.leaderboard;
  assert.equal(board[0].agent, run.claims[0].agent);
  assert.equal(board.at(-1).agent, run.claims[1].agent);
});

test('helpers tolerate messy LLM output', () => {
  assert.equal(normalizeAgent('Bull Defender'), 'bull');
  assert.equal(normalizeAgent('Black Swan'), null, 'removed agents are rejected, not silently remapped');
  assert.equal(normalizeAgent('global-shock'), 'global');
  assert.equal(normalizeAgent('nobody'), null);
  assert.deepEqual(parseLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseLoose({ output: '{"a":2}' }), { a: 2 });
  assert.deepEqual(parseLoose('plain prose'), { argument: 'plain prose' });
});

test('scripted demo runs to a verdict through the same referee calls', async () => {
  const run = newRun();
  await simulate(run, { speed: 1000 });
  assert.equal(run.status, 'done');
  assert.equal(run.round, 4);
  assert.equal(run.verdict.verdict, 'Fragile');
  assert.ok(run.events.some((e) => e.type === 'task_queued' && e.data.task.origin === 'delegation'));
  for (const id of AGENT_IDS) assert.ok(run.remaining(id) >= 0);
});

test('closing a round releases credits of investigators that never reported back', () => {
  const run = newRun();
  const { tasks } = run.applyPlan({ tasks: [{ agent: 'global', question: 'q', credits: 3 }] });
  for (const t of tasks.filter((x) => x.agent !== 'global')) run.recordFinding({ task_id: t.task_id, output: { headline: 'h', done: true }, steps: [] });
  assert.equal(run.remaining('global'), 7);
  const res = run.closeRound();
  assert.equal(run.remaining('global'), 10);
  assert.equal(run.tasks.find((t) => t.agent === 'global').status, 'lost');
  assert.match(res.digest, /CLAIMS ON THE BLACKBOARD/);
});

// --- scope gate ---------------------------------------------------------------

test('scope gate fails open: genuine, missing or unrecognised verdicts all run normally', () => {
  for (const scope of ['forecast', 'FORECAST', undefined, null, '', 'maybe', 42]) {
    const run = newRun();
    const res = run.applyPlan({ scope, tasks: [] });
    assert.equal(res.continue, true, `scope ${JSON.stringify(scope)} must not block`);
    assert.equal(res.tasks.length, AGENT_IDS.length);
    assert.equal(run.status, 'running');
    assert.ok(!run.events.some((e) => e.type === 'rejected'));
  }
});

test('scope gate stops junk before any agent spends a credit', () => {
  for (const scope of ['too_vague', 'not_a_forecast', 'out_of_scope', ' Not_A_Forecast ']) {
    const run = newRun();
    const res = run.applyPlan({ scope, scope_reason: 'why', suggested_forecast: scope === 'too_vague' ? 'India GDP >= 6.5% in FY27' : undefined, tasks: [{ agent: 'demand', question: 'q', credits: 2 }] });
    assert.deepEqual([res.continue, res.rejected, res.tasks.length], [false, true, 0]);
    assert.equal(run.status, 'rejected');
    assert.equal(run.tasks.length + run.queue.length, 0);
    for (const id of AGENT_IDS) assert.equal(run.remaining(id), RULES.creditsPerAgent);
    const ev = run.events.find((e) => e.type === 'rejected');
    assert.equal(ev.data.reason, 'why');
    if (scope === 'too_vague') assert.equal(ev.data.suggested_forecast, 'India GDP >= 6.5% in FY27');
  }
});

test('"Run anyway" overrides the scope gate', () => {
  const run = new Run({ forecast: 'Argentina will win the 2030 World Cup', mode: 'test', force: true });
  const res = run.applyPlan({ scope: 'out_of_scope', scope_reason: 'sports', assumptions: [], tasks: [] });
  assert.equal(res.continue, true);
  assert.equal(res.tasks.length, AGENT_IDS.length);
  assert.ok(run.events.some((e) => e.type === 'scope_overridden'));
});

test('roster is the four kept agents; tasks for removed agents are rejected', () => {
  assert.deepEqual(AGENT_IDS, ['demand', 'global', 'data', 'bull']);
  const run = newRun();
  const res = run.applyPlan({ tasks: [{ agent: 'historian', question: 'Find analogs', credits: 2 }] });
  assert.equal(res.tasks.length, 4);
  assert.ok(run.events.some((e) => e.type === 'task_rejected' && /unknown agent/.test(e.data.reason)));
});
