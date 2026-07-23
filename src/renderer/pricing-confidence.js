'use strict';

(function initPricingConfidence(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EmberPricingConfidence = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function callLabel(value) {
    const calls = Math.max(0, Number(value) || 0);
    return `${calls.toLocaleString()} ${calls === 1 ? 'call' : 'calls'}`;
  }

  function affectedModels(models) {
    const callsByModel = new Map();
    for (const model of models || []) {
      const calls = Math.max(0, Number(model && model.unpricedCalls) || 0);
      if (!calls) continue;
      const id = String((model && model.model) || 'unknown');
      callsByModel.set(id, (callsByModel.get(id) || 0) + calls);
    }
    return [...callsByModel]
      .map(([model, calls]) => ({ model, calls }))
      .sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model));
  }

  function partialTitle(models) {
    const affected = affectedModels(models);
    const detail = affected.length
      ? `${affected.length === 1 ? 'Unpriced model' : 'Unpriced models'}: ${affected.map(({ model, calls }) => `${model} (${callLabel(calls)})`).join(', ')}.`
      : 'Some models have no published official API price.';
    return `${detail} Calls and tokens remain in usage totals; only their dollar value is omitted.`;
  }

  function describePricingConfidence(tot, models = []) {
    if (!tot.msgs) {
      return { tone: 'complete', summary: 'No usage in this view', title: '' };
    }

    if (tot.unpricedCalls > 0) {
      const tokenTotal = tot.pricedTokens + tot.unpricedTokens;
      const coverage = tokenTotal ? (tot.pricedTokens / tokenTotal) * 100 : 100;
      const coverageText = `${Math.min(99.99, coverage).toFixed(coverage >= 99 ? 2 : 1)}%`;
      return {
        tone: 'partial',
        summary: `${coverageText} of tokens priced · ${callLabel(tot.unpricedCalls)} unpriced`,
        title: partialTitle(models),
      };
    }

    if (tot.estimated) {
      return {
        tone: 'estimated',
        summary: '100% officially priced · cache-write premium estimated',
        title: 'Codex logs omit GPT-5.6 cache-write counts. The headline uses the conservative upper estimate.',
      };
    }

    return {
      tone: 'complete',
      summary: '100% officially priced from measured token classes',
      title: 'Every visible call has an official model price and measured token categories.',
    };
  }

  return { affectedModels, describePricingConfidence };
}));
