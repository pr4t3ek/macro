// Offline demo driver. It plays the n8n workflow's part with a scripted
// India-FY28 debate so the war room can be shown without API keys. It goes
// through exactly the same referee calls the n8n workflow makes (plan ->
// findings -> rulings -> ... -> verdict), so budgets, delegation and stopping
// behave the same way. Everything it says is illustrative, not real evidence.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const steps = (...tools) => tools.map((tool) => ({ action: { tool } }));
const ev = (fact, source) => ({ fact, source: `${source} (illustrative)` });

const Q = {
  demand1: 'Is private consumption growth strong enough to carry 7%? Check credit, wages, employment and housing.',
  global1: 'Which external shock (Fed, China, crude, trade, capital flows) is most likely to invalidate 7%?',
  data1: 'Which indicators is the 7% forecast leaning on, and are they measuring what we think?',
  bull1: 'Build the strongest evidence-backed case that 7% is robust.',
  bull2: 'Is capacity utilisation high enough to force new private capex?',
  demand2: 'Is consumption being financed by unsecured household credit rather than income growth?',
  global2: 'Stress test: what happens to growth if Brent stays above $120 for three quarters?',
  data2: 'Who is forecasting capex growth, and how far apart are they?',
  demand3: 'Have corporate capex intentions weakened in the latest surveys and announcements?',
  bull3: 'Can public infrastructure investment compensate for a private capex shortfall?',
  data3: 'Decompose recent GDP growth: how much came from inventories, government spending and base effects?',
  data4: 'Investigate private vs public capex contribution: how large were private-investment multipliers in past public-capex-led recoveries?',
};

const FINDINGS = {
  [Q.demand1]: {
    steps: steps('web_search', 'world_bank_indicator'),
    out: {
      headline: 'Demand appears resilient — for now',
      stance: 'supports', target_assumption: 'A1', confidence: 0.58,
      argument: 'Urban consumption indicators and services activity remain firm, and real wage growth has turned positive.',
      causal_mechanism: 'Positive real wages -> discretionary spending -> services output.',
      evidence: [ev('Passenger vehicle and air traffic volumes near record highs', 'Industry data'), ev('Household final consumption share of GDP stable', 'World Bank WDI')],
      follow_ups: [{ agent: 'demand', question: Q.demand2, credits: 3, reason: 'Resilience may be borrowed — need to check what is funding it.' }],
    },
  },
  [Q.global1]: {
    steps: steps('web_search', 'fred_series'),
    out: {
      headline: 'External environment relatively benign — except crude',
      stance: 'neutral', target_assumption: 'A3', confidence: 0.5,
      argument: 'Fed easing and stable capital flows help, but India imports most of its crude; oil is the single largest external sensitivity.',
      causal_mechanism: 'Oil price -> import bill -> current account -> rupee -> imported inflation -> RBI response.',
      evidence: [ev('Brent futures curve flat', 'FRED DCOILBRENTEU'), ev('India net oil import dependence above 80%', 'PPAC')],
      follow_ups: [{ agent: 'global', question: Q.global2, credits: 3, reason: 'Need a quantified stress test, not a vibe.' }],
    },
  },
  [Q.data1]: {
    steps: steps('web_search', 'world_bank_indicator'),
    out: {
      headline: 'The forecast leans heavily on investment growth',
      stance: 'attacks', target_assumption: 'A2', confidence: 0.64,
      argument: 'Back-solving the 7% path requires gross fixed capital formation to keep growing at double digits. That single assumption carries more weight than consumption.',
      causal_mechanism: 'If GFCF growth halves, roughly a percentage point of headline growth disappears.',
      evidence: [ev('GFCF share of GDP rising for three consecutive years', 'MoSPI national accounts')],
      follow_ups: [{ agent: 'data', question: Q.data2, credits: 3, reason: 'If capex forecasts disagree, the forecast is fragile at its core.' }],
    },
  },
  [Q.bull1]: {
    steps: steps('web_search', 'world_bank_indicator'),
    out: {
      headline: 'Public capex pipeline and clean balance sheets support 7%',
      stance: 'supports', target_assumption: 'A2', confidence: 0.66,
      argument: 'Bank and corporate balance sheets are the cleanest in a decade, and the government infrastructure pipeline is funded for the next two years.',
      causal_mechanism: 'Low NPAs + funded public capex -> credit availability -> investment.',
      evidence: [ev('Bank gross NPAs at multi-year lows', 'RBI Financial Stability Report'), ev('Central government capex budget at record share of GDP', 'Union Budget')],
      done: true,
    },
  },
  [Q.bull2]: {
    steps: steps('web_search'),
    out: {
      headline: 'Capacity utilisation near the level that historically triggers capex',
      stance: 'supports', target_assumption: 'A2', confidence: 0.5,
      argument: 'Manufacturing capacity utilisation is around the threshold where firms have historically started expanding.',
      evidence: [ev('Capacity utilisation in mid-70s %', 'RBI OBICUS survey')],
      done: true,
    },
  },
  [Q.demand2]: {
    steps: steps('web_search', 'web_search', 'fred_series'),
    out: {
      headline: 'Consumption is increasingly credit-financed',
      stance: 'attacks', target_assumption: 'A1', confidence: 0.61,
      argument: 'Unsecured personal loans grew far faster than wages; household financial savings fell. Demand is being pulled forward.',
      causal_mechanism: 'Unsecured credit -> consumption today -> repayment drag + regulatory tightening tomorrow.',
      evidence: [ev('Unsecured retail credit growth outpaced nominal wage growth', 'RBI sectoral credit'), ev('Net household financial savings at multi-decade low', 'RBI')],
      indicators_to_watch: [{ indicator: 'Bank credit growth', threshold: '> 14%', direction: 'validates' }],
      follow_ups: [{ agent: 'data', question: Q.data3, credits: 2, reason: 'Delegating: if recent prints are flattered, the starting point is weaker than it looks.' }],
    },
  },
  [Q.global2]: {
    steps: steps('fred_series', 'web_search', 'calculator'),
    out: {
      headline: 'Oil > $120 for 3 quarters breaks the forecast',
      stance: 'attacks', target_assumption: 'A3', confidence: 0.57,
      argument: 'A sustained oil shock widens the current account deficit, weakens the rupee and forces the RBI to hold rates, hitting both consumption and private capex.',
      causal_mechanism: 'Oil -> CAD -> INR -> imported inflation -> tighter policy -> capex delayed.',
      evidence: [ev('Rule of thumb: +$10/bbl adds ~0.4% of GDP to the CAD', 'RBI estimates')],
      indicators_to_watch: [{ indicator: 'Brent', threshold: '> $120 for 3 quarters', direction: 'breaks' }],
      done: true,
    },
  },
  [Q.data2]: {
    steps: steps('web_search', 'web_search', 'web_search'),
    out: {
      headline: 'Capex forecasts disagree by a factor of two',
      stance: 'attacks', target_assumption: 'A2', confidence: 0.63,
      argument: 'Official projections assume double-digit GFCF growth; several private forecasters assume half that. The 7% number sits on the optimistic tail.',
      causal_mechanism: 'Dispersion in the most load-bearing input -> high forecast variance.',
      evidence: [ev('Official GFCF projections double-digit', 'Ministry of Finance'), ev('Private forecasters project mid-single-digit GFCF', 'Broker research')],
      done: true,
    },
  },
  [Q.demand3]: {
    steps: steps('web_search', 'web_search'),
    out: {
      headline: 'Corporate capex intentions have weakened',
      stance: 'attacks', target_assumption: 'A2', challenges_claim: 'C4', confidence: 0.62,
      argument: 'New project announcements and capex intention surveys both softened over the last two quarters despite high utilisation.',
      causal_mechanism: 'Weak demand visibility -> firms defer projects -> private GFCF slows.',
      evidence: [ev('New project announcements down year-on-year', 'CMIE CapEx'), ev('Capex intention index lower', 'Industry survey')],
      indicators_to_watch: [{ indicator: 'Private capex growth', threshold: '< 8%', direction: 'breaks' }],
      done: true,
    },
  },
  [Q.bull3]: {
    steps: steps('web_search', 'world_bank_indicator'),
    out: {
      headline: 'Public infrastructure investment may compensate',
      stance: 'supports', target_assumption: 'A2', challenges_claim: 'C8', confidence: 0.55,
      argument: 'Funded public capex in roads, rail and power can sustain GFCF growth even if private intentions dip for a few quarters.',
      causal_mechanism: 'Public capex -> construction activity -> GFCF.',
      evidence: [ev('Central and state capex allocations rising', 'Union Budget')],
      done: true,
    },
  },
  [Q.data3]: {
    steps: steps('world_bank_indicator', 'web_search'),
    out: {
      headline: 'Government spending and inventories flatter recent prints',
      stance: 'attacks', target_assumption: 'A2', confidence: 0.5,
      argument: 'A meaningful share of recent growth came from government consumption and inventory build, which do not persist.',
      evidence: [ev('Discrepancies and inventories large in recent quarters', 'MoSPI national accounts')],
      done: true,
    },
  },
  [Q.data4]: {
    steps: steps('wikipedia', 'web_search', 'world_bank_indicator'),
    out: {
      headline: 'Public-capex-led recoveries had weaker private multipliers than assumed',
      stance: 'attacks', target_assumption: 'A2', challenges_claim: 'C10', confidence: 0.6,
      argument: 'In comparable episodes (India 2014–19, several EMs post-2009), public capex did not crowd in private investment at the rate this forecast implies; private capex recovered only once demand visibility improved.',
      causal_mechanism: 'Public capex supports construction but private multipliers depend on demand visibility, which is weak.',
      evidence: [ev('Private GFCF share stagnated during 2014–19 despite rising public capex', 'MoSPI'), ev('Cross-country public investment multipliers lower in low-confidence regimes', 'IMF research')],
      done: true,
    },
  },
};

const PLAN = {
  scope: 'forecast',
  scope_reason: 'A dated, quantified GDP growth forecast.',
  forecast_label: 'India real GDP growth, FY28',
  forecast_value: '7.0%',
  horizon: 'FY2027-28',
  assumptions: [
    { id: 'A1', text: 'Private consumption grows ~7% on rising real incomes', load_bearing: 0.7 },
    { id: 'A2', text: 'Gross fixed capital formation grows at double digits, private capex joins public', load_bearing: 0.85 },
    { id: 'A3', text: 'External environment benign: oil stable, no global shock', load_bearing: 0.6 },
  ],
  tasks: [
    { agent: 'demand', question: Q.demand1, credits: 2 },
    { agent: 'global', question: Q.global1, credits: 2 },
    { agent: 'data', question: Q.data1, credits: 2 },
    { agent: 'bull', question: Q.bull1, credits: 2 },
  ],
};

// Claim ids follow the order findings arrive: round 1 is C1 demand, C2 global,
// C3 data, C4 bull; round 2 is C5 bull, C6 demand, C7 global, C8 data;
// round 3 is C9 demand, C10 bull, C11 data; round 4 is C12 data.
const RULINGS = [
  {
    round_summary: 'Forecast survives round 1. But the Data Detective has shown that the 7% path is concentrated on investment growth — that is where the attack should go.',
    robustness_estimate: 72,
    rulings: [
      { claim_id: 'C1', status: 'unresolved', reason: 'Resilience shown, but funding source unexamined.' },
      { claim_id: 'C2', status: 'survives', reason: 'Oil sensitivity is well documented.' },
      { claim_id: 'C3', status: 'survives', reason: 'Back-solve is arithmetic, not opinion.' },
      { claim_id: 'C4', status: 'unresolved', reason: 'Balance sheets are necessary but not sufficient for private capex.', flags: ['causal gap'] },
    ],
    assumption_status: [{ id: 'A2', status: 'under attack' }],
    contradictions: [{ between: ['C3', 'C4'], issue: 'Does investment carry the forecast on public or private capex?', resolving_data: 'Split of GFCF by institutional sector' }],
    new_investigations: [{ agent: 'bull', question: Q.bull2, credits: 1, type: 'investigate', reason: 'Defend the capex assumption: is there a capacity trigger?' }],
    sufficient: false,
  },
  {
    round_summary: 'Capex forecasts disagree widely and demand is partly credit-funded. The bull case rests on public capex; I am ordering a direct confrontation.',
    robustness_estimate: 63,
    rulings: [
      { claim_id: 'C5', status: 'unresolved', reason: 'Utilisation is a condition, not evidence of intent.', flags: ['correlation ≠ causation'] },
      { claim_id: 'C6', status: 'survives', reason: 'Two independent sources show credit outpacing income.' },
      { claim_id: 'C7', status: 'survives', reason: 'Clear, measurable transmission channel.' },
      { claim_id: 'C8', status: 'survives', reason: 'Dispersion documented from independent forecasters.' },
    ],
    assumption_status: [{ id: 'A1', status: 'weakened' }, { id: 'A3', status: 'conditional' }],
    contradictions: [{ between: ['C8', 'C4'], issue: 'Bull relies on public capex; Data Detective shows private forecasts are much lower.', resolving_data: 'Corporate capex intention surveys' }],
    new_investigations: [
      { agent: 'demand', question: Q.demand3, credits: 2, type: 'challenge', target_claim_id: 'C4', reason: 'Bear side: test private investment intent directly.' },
      { agent: 'bull', question: Q.bull3, credits: 2, type: 'challenge', target_claim_id: 'C8', reason: 'Bull side: defend the investment assumption.' },
    ],
    sufficient: false,
  },
  {
    round_summary: 'Unresolved: private capex intentions are weakening, and the bull argues public capex compensates. Creating a dedicated investigation into private vs public capex contribution.',
    robustness_estimate: 60,
    rulings: [
      { claim_id: 'C9', status: 'survives', reason: 'Two independent indicators agree.' },
      { claim_id: 'C10', status: 'unresolved', reason: 'Plausible, but assumes a private multiplier nobody has evidenced.', flags: ['missing evidence'] },
      { claim_id: 'C11', status: 'unresolved', reason: 'Directionally right, magnitude uncertain.' },
    ],
    contradictions: [{ between: ['C9', 'C10'], issue: 'Can public capex substitute for private capex at the required scale?', resolving_data: 'Historical private-investment multipliers of public capex' }],
    new_investigations: [{ agent: 'data', question: Q.data4, credits: 3, type: 'challenge', target_claim_id: 'C10', reason: 'The historical record decides whether public capex crowds in private capex.' }],
    sufficient: false,
  },
  {
    round_summary: 'The historical record does not support the multiplier the bull case needs. The investment assumption is the primary vulnerability; the oil shock is the most dangerous scenario.',
    robustness_estimate: 58,
    rulings: [
      { claim_id: 'C10', status: 'falls', reason: 'Historical multipliers too weak to close the gap.' },
      { claim_id: 'C12', status: 'survives', reason: 'Consistent with C9 and with multiple episodes.' },
    ],
    assumption_status: [{ id: 'A2', status: 'fragile' }],
    sufficient: true,
  },
];

const VERDICT = {
  forecast_label: 'India real GDP growth, FY28',
  forecast_value: '7.0%',
  robustness: 58,
  confidence: 61,
  vulnerability: 'HIGH',
  verdict: 'Fragile',
  primary_vulnerability: 'Private investment assumptions',
  secondary_vulnerability: 'Global energy shock',
  strongest_opposing_evidence: 'Corporate capex intentions declining despite high capacity utilisation',
  strongest_supporting_evidence: 'Funded public capex and the cleanest bank balance sheets in a decade',
  critical_unknown: 'Household credit deterioration',
  most_dangerous_scenario: 'Oil > $120 for 3 consecutive quarters',
  break_conditions: ['Oil > $120', 'Private capex < 8%'],
  break_logic: 'AND',
  validate_conditions: ['Credit growth > 14%', 'Private capex > 12%', 'PMI > 55'],
  watchlist: [
    { indicator: 'Corporate capex', why: 'The most load-bearing and most contested input' },
    { indicator: 'Bank credit', why: 'Tells us whether consumption is income- or debt-funded' },
    { indicator: 'PMI new orders', why: 'Leading signal for private demand visibility' },
    { indicator: 'Oil', why: 'Largest external sensitivity' },
  ],
  agent_scores: [
    { agent: 'data', reason: 'Found the load-bearing assumption in round 1 and the decisive evidence on capex multipliers.' },
    { agent: 'demand', reason: 'Showed private capex intentions are weakening.' },
  ],
};

async function simulate(run, { speed = 1 } = {}) {
  const pause = (ms) => sleep(ms / speed);
  try {
    await pause(900);
    let next = run.applyPlan(PLAN);
    let round = 0;
    while (next.continue) {
      for (const task of next.tasks) {
        await pause(1400);
        const script = FINDINGS[task.question] || {
          steps: steps('web_search'),
          out: { headline: `${task.agent} found nothing decisive`, stance: 'neutral', confidence: 0.4, argument: task.question, done: true },
        };
        run.recordFinding({ task_id: task.task_id, output: script.out, steps: script.steps });
      }
      await pause(2200);
      next = run.applyRulings(RULINGS[Math.min(round, RULINGS.length - 1)]);
      round += 1;
    }
    await pause(2000);
    run.applyVerdict(VERDICT);
  } catch (err) {
    run.fail(err.message);
  }
}

module.exports = { simulate };
