'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const policy = require('../src/renderer/filter-state');

function renderer() {
  class Element {
    constructor() {
      this.children = [];
      this.dataset = {};
      this.style = { setProperty() {} };
      this.classList = { add() {} };
    }
    set innerHTML(value) { this.children = []; }
    append(...children) { this.children.push(...children); }
    appendChild(child) { this.append(child); }
    setAttribute() {}
    addEventListener() {}
    querySelector() { return elements.get('tbody'); }
  }
  const elements = new Map(['modelChips', 'modelTable', 'tbody'].map((id) => [id, new Element()]));
  const context = vm.createContext({
    console, Set, Map, setInterval() {},
    localStorage: { getItem: () => null },
    window: {
      matchMedia: () => ({}), addEventListener() {},
      EmberFilterState: { ...policy, archiveCutoff: () => '2026-09-03',
        isArchivedModel: (model) => policy.isArchivedModel(model, '2026-09-03') },
      EmberTheme: { tokens: () => ({ codex: '#38c98b', codexGpt5: '#38c98b' }) },
    },
    document: {
      getElementById: (id) => elements.get(id),
      createElement: () => new Element(), createTextNode: (text) => ({ textContent: text }),
    },
  });
  const source = fs.readFileSync(require.resolve('../src/renderer/app.js'), 'utf8');
  vm.runInContext(source.replace('init().catch(showStartupError);', ''), context);
  // Colour lookup is independent of archiving and requires the full theme runtime.
  vm.runInContext("modelColor = () => '#38c98b'", context);
  return { run: (code) => vm.runInContext(code, context), elements };
}

test('archiving removes model controls while retaining historical cost and project data', () => {
  const { run, elements } = renderer();
  run(`
    state.buckets = [
      { provider: 'codex', model: 'gpt-5.6-sol', project: 'old-project', date: '2026-11-03', cost: 12 },
      { provider: 'codex', model: 'gpt-6.1-sol', project: 'new-project', date: '2026-11-03', cost: 3 },
    ];
    state.selectedModels = new Set(['codex|gpt-5.6-sol']);
    reconcileVisibleModelSelection();
    renderModelChips();
    renderModelTable(new Map(state.buckets.map((b) => [mkey(b), {
      ...b, priced: true, msgs: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    }])));
  `);
  assert.equal(elements.get('modelChips').children.length, 1);
  assert.equal(elements.get('modelChips').children[0].title, 'Codex · gpt-6.1-sol');
  const rows = elements.get('tbody').children;
  assert.equal(rows.length, 2);
  assert.match(rows[0].children[0].textContent, /Archived models/);
  assert.equal(rows[0].children[1].textContent, '$12.00');
  assert.equal(rows[0].dataset.modelKey, undefined);
  assert.equal(rows[1].dataset.modelKey, 'codex|gpt-6.1-sol');
  assert.equal(run('state.selectedModels.size'), 0);
  assert.equal(run('filteredBuckets().reduce((sum, b) => sum + b.cost, 0)'), 15);
  assert.equal(run("filteredBuckets().some((b) => b.project === 'old-project')"), true);
  assert.equal(run("dayTotals(filteredBuckets()).get('2026-11-03').total"), 15);
});

test('a historical-only range still shows archived cost instead of an empty model table', () => {
  const { run, elements } = renderer();
  run(`renderModelTable(new Map([['old', { model: 'claude-sonnet-5', cost: 8, priced: true }]]));`);
  const rows = elements.get('tbody').children;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].children[1].textContent, '$8.00');
});
