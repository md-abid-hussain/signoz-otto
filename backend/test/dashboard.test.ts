import { describe, expect, it } from 'vitest';
import { builderWidget, rowWidget } from '../src/signoz/dashboard.js';

describe('builderWidget — shared SigNoz widget envelope', () => {
  it('produces the v5 envelope with sensible defaults', () => {
    const w = builderWidget({ id: 'w1', title: 'T', panelTypes: 'value', queryData: [{ q: 1 }] }) as any;
    expect(w.id).toBe('w1');
    expect(w.panelTypes).toBe('value');
    expect(w.yAxisUnit).toBe('none');            // default
    expect(w.thresholds).toEqual([]);            // default
    expect(w.nullZeroValues).toBe('zero');
    expect(w.query.id).toBe('q-w1');             // default queryId = q-<id>
    expect(w.query.queryType).toBe('builder');
    expect(w.query.builder.queryData).toEqual([{ q: 1 }]);
    expect(w.query.builder.queryFormulas).toEqual([]); // default
  });

  it('honors overrides (queryId, thresholds, formulas, yAxisUnit)', () => {
    const w = builderWidget({
      id: 'otto-2', queryId: 'q-2', title: 'T', panelTypes: 'graph',
      queryData: [], queryFormulas: [{ f: 1 }], yAxisUnit: 'ns', thresholds: [{ t: 1 }],
    }) as any;
    expect(w.query.id).toBe('q-2');              // migration keeps its own q-<panelId>
    expect(w.yAxisUnit).toBe('ns');
    expect(w.thresholds).toEqual([{ t: 1 }]);
    expect(w.query.builder.queryFormulas).toEqual([{ f: 1 }]);
  });
});

describe('rowWidget — section header', () => {
  it('is a query-less row', () => {
    const r = rowWidget('row-1', 'Health') as any;
    expect(r.panelTypes).toBe('row');
    expect(r.title).toBe('Health');
    expect(r.query.builder.queryData).toEqual([]);
  });
});
