// The migration playbook as a LangGraph StateGraph (DESIGN §3, §4.5, TECH §4.5).
// Nodes = pipeline stages; interruptBefore:['apply'] IS the HITL gate — the graph
// pauses after producing the plan and cannot write until resumed with approval.
// LLM tail nodes (semantic-ground / translate-exotic / repair) plug in later; the
// deterministic path runs fully without an API key.

import { Annotation, StateGraph, START, END, MemorySaver } from '@langchain/langgraph';
import { parseGrafanaDashboard, type ParsedDashboard } from '../ingest/grafana.js';
import { runReadiness } from '../readiness/index.js';
import {
  migrateDashboard, assembleDashboard, applyDashboard,
  type PanelMigration, type AssembledDashboard,
} from './migrate.js';
import type { ReadinessReport } from '../types.js';
import type { SigNozMcp } from '../signoz/mcp.js';

const MigrationState = Annotation.Root({
  raw: Annotation<unknown>(),
  targetTitle: Annotation<string | undefined>(),
  dash: Annotation<ParsedDashboard | undefined>(),
  report: Annotation<ReadinessReport | undefined>(),
  migrations: Annotation<PanelMigration[] | undefined>(),
  assembled: Annotation<AssembledDashboard | undefined>(),
  createdId: Annotation<string | undefined>(),
  verified: Annotation<boolean | undefined>(),
});
export type MigrationStateT = typeof MigrationState.State;

/** deep-find the first array under `key` anywhere in a nested response (envelope-agnostic) */
function findArray(o: unknown, key: string): unknown[] | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const rec = o as Record<string, unknown>;
  if (Array.isArray(rec[key])) return rec[key] as unknown[];
  for (const v of Object.values(rec)) {
    const r = findArray(v, key);
    if (r) return r;
  }
  return undefined;
}

/** build the compiled migration graph; `mcp` is captured in closure (live, non-serializable) */
export function buildMigrationGraph(mcp: SigNozMcp) {
  const graph = new StateGraph(MigrationState)
    .addNode('ingest', (s) => ({ dash: parseGrafanaDashboard(s.raw as never) }))
    .addNode('readiness', async (s) => ({ report: await runReadiness(s.dash!, mcp) }))
    // translate + validate (deterministic core; LLM tail handles `unsupported`/failed later)
    .addNode('translate', async (s) => ({ migrations: await migrateDashboard(s.dash!, s.report!, mcp) }))
    .addNode('assemble', (s) => ({ assembled: assembleDashboard(s.dash!, s.migrations!, s.targetTitle) }))
    // writes — reached only after the interrupt is resumed with approval
    .addNode('apply', async (s) => {
      const { id } = await applyDashboard(mcp, s.assembled!);
      return { createdId: id };
    })
    .addNode('verify', async (s) => {
      const d = await mcp.call<unknown>('get_dashboard', { id: s.createdId });
      const widgets = findArray(d, 'widgets') ?? [];
      return { verified: widgets.length === s.assembled!.included };
    })
    .addEdge(START, 'ingest')
    .addEdge('ingest', 'readiness')
    .addEdge('readiness', 'translate')
    .addEdge('translate', 'assemble')
    .addEdge('assemble', 'apply')
    .addEdge('apply', 'verify')
    .addEdge('verify', END);

  // HITL: pause before any write; caller inspects state, then resumes to apply
  return graph.compile({ checkpointer: new MemorySaver(), interruptBefore: ['apply'] });
}
