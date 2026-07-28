import { describe, expect, it } from 'vitest';
import { applyOverrides } from '../src/engine/slo.js';
import type { SloProposal } from '../src/types.js';

const base = {
  service: 's', operation: 'op', objectivePct: 99, latencyThresholdMs: 250, windowDays: 30,
  reasoning: 'x', budgetHoursPerWindow: 7.2, evidence: {} as never,
} as SloProposal;

describe('applyOverrides — the human edits the target before create', () => {
  it('overrides objective and recomputes the error budget', () => {
    const p = applyOverrides(base, { objectivePct: 99.5 });
    expect(p.objectivePct).toBe(99.5);
    expect(p.latencyThresholdMs).toBe(250); // untouched
    expect(p.windowDays).toBe(30);
    expect(p.budgetHoursPerWindow).toBeCloseTo(((100 - 99.5) / 100) * 30 * 24, 5); // 3.6h
  });

  it('overrides threshold and window, rounding to whole units', () => {
    const p = applyOverrides(base, { latencyThresholdMs: 305.7, windowDays: 7.4 });
    expect(p.latencyThresholdMs).toBe(306);
    expect(p.windowDays).toBe(7);
  });

  it('clamps objective into (1, 99.99)', () => {
    expect(applyOverrides(base, { objectivePct: 100 }).objectivePct).toBe(99.99);
    expect(applyOverrides(base, { objectivePct: 0 }).objectivePct).toBe(1);
  });

  it('no overrides keeps the proposal tunables', () => {
    const p = applyOverrides(base, {});
    expect([p.objectivePct, p.latencyThresholdMs, p.windowDays]).toEqual([99, 250, 30]);
  });
});
