// Shared domain types. Encodes the SigNoz v5 schema verified 2026-07-21 against
// the live instance + official docs. See DESIGN.md §0–§2.

// ---- Grafana side (parser output) --------------------------------------

export interface Threshold {
  value: number;
  color?: string;
}

export interface GrafanaTarget {
  refId: string;
  expr: string; // raw PromQL
  legend?: string; // Grafana legendFormat, e.g. "{{span_name}}"
}

export interface PanelSpec {
  id: string;
  title: string;
  grafanaType: string; // 'timeseries' | 'stat' | 'gauge' | 'table' | ...
  targets: GrafanaTarget[];
  unit?: string;
  thresholds?: Threshold[];
  gridPos: { x: number; y: number; w: number; h: number };
}

// ---- Neutral SigNoz builder model (shape-agnostic) ---------------------
// Produced by mapper/promql.ts; the engine serializes it into Query-Builder
// widgets inline (see engine/fullmigrate.ts wrapWidget).

export type TimeAgg =
  | 'rate'
  | 'increase'
  | 'avg'
  | 'sum'
  | 'min'
  | 'max'
  | 'count'
  | 'latest';

export type SpaceAgg =
  | 'sum'
  | 'avg'
  | 'min'
  | 'max'
  | 'count'
  | 'p50'
  | 'p90'
  | 'p95'
  | 'p99';

export interface OrderBy {
  key: string; // e.g. "count()" or an attribute name
  dir: 'asc' | 'desc';
}

export interface BuilderQuery {
  name: string; // 'A', 'B', ...
  signal: 'metrics' | 'traces' | 'logs';
  metricName?: string;
  timeAggregation?: TimeAgg;
  spaceAggregation?: SpaceAgg;
  filterExpr?: string; // "service.name = 'frontend' AND ..."
  groupBy: string[]; // attribute names
  havingExpr?: string; // "count() > 1000"
  orderBy?: OrderBy[];
  limit?: number;
  legend?: string;
}

export interface Formula {
  name: string; // 'F1'
  expression: string; // "A/B"
}

// ---- Conversion result -------------------------------------------------

export type PanelStatus =
  | 'validated'
  | 'validated_with_renames'
  | 'needs_review'
  | 'unsupported';

export type SigNozPanelType = 'graph' | 'value' | 'table' | 'list' | 'bar';

export interface Rename {
  from: string;
  to: string;
  reason: string;
}

export interface PanelResult {
  panel: PanelSpec;
  queries: BuilderQuery[];
  formulas: Formula[];
  panelType: SigNozPanelType;
  status: PanelStatus;
  renames: Rename[];
  notes: string;
  path: 'deterministic' | 'agent';
  validation?: { seriesCount: number; sample: unknown };
}

// ---- Deterministic mapper output ---------------------------------------
// The mapper converts one PromQL target. If it fully handles the expression
// it returns queries (and maybe a formula); otherwise `unsupported` lists the
// parts it could not map, and the caller hands off to the agent.

export interface MapResult {
  ok: boolean;
  query?: BuilderQuery;
  formula?: Formula;
  unsupported?: string[]; // human-readable reasons; empty when ok
  notes: string[];
}

// ---- Readiness (the shared analyze stage) ------------------------------

export type ReadinessVerdict = 'matched' | 'renamed' | 'missing';

export interface ReadinessItem {
  name: string; // the Grafana-side metric name
  verdict: ReadinessVerdict;
  mappedTo?: string; // the SigNoz-side name when renamed
  reason?: string;
  panelsAffected: string[]; // panel ids
}

export interface ReadinessReport {
  metrics: ReadinessItem[];
  perPanelPrediction: Record<string, PanelStatus>; // panelId -> predicted status
  summary: { matched: number; renamed: number; missing: number };
}

// ---- Run scoring / receipt ---------------------------------------------

export interface LlmUsage { calls: number; inputTokens: number; outputTokens: number }

export interface ReplicationFidelity {
  titleMatch: boolean;
  tagsCarried: boolean;
  descriptionPresent: boolean;
  sectionsExpected: number;
  sectionsCreated: number;
  panelsMigrated: number;
  panelsTotal: number;
}

export interface Receipt {
  playbook: string; // 'migration' | 'slo'
  total: number;
  migrated: number;
  counts: Record<string, number>; // status → count
  recovered: string[]; // metrics recovered via LLM semantic match
  llm: LlmUsage;
  durationMs: number;
  artifacts: string[]; // created dashboard/alert ids
  fidelity?: ReplicationFidelity; // replication check vs the original (when applied)
  variables?: { kept: string[]; dropped: string[] }; // dashboard vars created vs dropped (unresolvable/free-text)
}

// ---- SLO copilot --------------------------------------------------------

export interface SloEvidence {
  service: string;
  operation: string;
  windowLabel: string;
  total: number;
  errors: number;
  successPct: number;
  p50Ns: number;
  p95Ns: number;
  p99Ns: number;
  pctUnderThreshold?: number; // % completing under the proposed latency threshold
}

export interface SloProposal {
  service: string;
  operation: string;
  objectivePct: number; // e.g. 99
  latencyThresholdMs: number; // e.g. 750
  windowDays: number; // e.g. 30
  reasoning: string;
  budgetHoursPerWindow: number; // allowed degraded time
  evidence: SloEvidence;
}

// SRE-grounded reasoning layer (LLM) — explains the operation + justifies the SLO before creating anything
export interface SloAnalysis {
  operationExplanation: string; // what this operation does, from its name + observed telemetry
  sliType: 'availability' | 'latency' | 'both'; // the binding constraint
  sliDefinition: string; // "good = has_error=false AND duration < Xms"
  reasoning: string; // why this target/window, SRE-grounded
  errorBudget: string; // human phrasing of the budget the target implies
  alternatives: { label: string; note: string }[]; // options considered + tradeoffs
  sreNotes: string[]; // SLA-vs-SLO, burn-rate, low-traffic caveats
  trend: { windowLabel: string; recentP95Ms: number; olderP95Ms: number; verdict: 'stable' | 'degrading' | 'improving' }; // deeper look, not a single pass
}
