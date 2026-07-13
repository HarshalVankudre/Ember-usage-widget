'use strict';

const { isOpenAIModel } = require('./model-attribution');

// Both providers' buckets are normalized to one shape so the renderer can
// merge them freely:
//   { provider, date, hour, minute, model, project, session, msgs,
//     input, output, cacheRead, cacheWrite, reasoning,   <- token counts
//     cost, cIn, cOut, cCr, cCw, cRs, cacheSavings, priced }
// Claude: cacheRead/cacheWrite are real log counts (5m+1h writes merged).
// Codex: `cached` maps to cacheRead. Native logs currently omit cache writes,
// so cacheWrite stays 0 while cCw and costMin/costMax expose the uncertainty.
function normalizeClaude(b) {
  if (isOpenAIModel(b.model)) {
    // Claudex/Ultracode records GPT calls in Claude's Anthropic-shaped
    // transcript. Attribute those calls to Codex, retain their real project
    // and session, and translate the token fields to OpenAI billing semantics.
    return {
      provider: 'codex',
      date: b.date, hour: b.hour, minute: b.minute ?? null,
      model: b.model, project: b.project, session: b.session,
      msgs: b.msgs,
      input: b.input, output: b.output,
      cacheRead: b.cacheRead, cacheWrite: b.cacheW5m + b.cacheW1h, reasoning: 0,
      cost: b.cost, costMin: b.costMin, costMax: b.costMax,
      cIn: b.cIn, cOut: b.cOut, cCr: b.cCr, cCw: b.cCw, cRs: 0, cTool: b.cTool || 0,
      cacheSavings: b.cacheSavings, priced: b.priced, estimated: !!b.estimated,
      pricedCalls: b.pricedCalls || 0, unpricedCalls: b.unpricedCalls || 0,
      longContextCalls: b.longContextCalls || 0,
      pricingSource: b.pricingSource || '',
      projectDeleted: !!b.projectDeleted,
    };
  }

  return {
    provider: 'claude',
    date: b.date, hour: b.hour, minute: b.minute ?? null,
    model: b.model, project: b.project, session: b.session,
    msgs: b.msgs,
    input: b.input, output: b.output,
    cacheRead: b.cacheRead, cacheWrite: b.cacheW5m + b.cacheW1h, reasoning: 0,
    cost: b.cost, costMin: b.costMin, costMax: b.costMax,
    cIn: b.cIn, cOut: b.cOut, cCr: b.cCr, cCw: b.cCw, cRs: 0, cTool: b.cTool || 0,
    cacheSavings: b.cacheSavings, priced: b.priced, estimated: !!b.estimated,
    pricedCalls: b.pricedCalls || 0, unpricedCalls: b.unpricedCalls || 0,
    fastCalls: b.fastCalls || 0, usRegionCalls: b.usRegionCalls || 0,
    pricingSource: b.pricingSource || '',
    projectDeleted: !!b.projectDeleted,
  };
}

function normalizeCodex(b) {
  return {
    provider: 'codex',
    date: b.date, hour: b.hour, minute: b.minute ?? null,
    model: b.model, project: b.project, session: b.session,
    msgs: b.msgs,
    input: b.input, output: b.output,
    cacheRead: b.cached, cacheWrite: b.cacheWrite || 0, reasoning: b.reasoning,
    cost: b.cost, costMin: b.costMin, costMax: b.costMax,
    cIn: b.cIn, cOut: b.cOut, cCr: b.cCached, cCw: b.cWrite, cRs: b.cReasoning, cTool: 0,
    cacheSavings: b.cacheSavings, priced: b.priced, estimated: !!b.estimated,
    pricedCalls: b.pricedCalls || 0, unpricedCalls: b.unpricedCalls || 0,
    longContextCalls: b.longContextCalls || 0,
    pricingSource: b.pricingSource || '',
    projectDeleted: !!b.projectDeleted,
  };
}

module.exports = { normalizeClaude, normalizeCodex };
