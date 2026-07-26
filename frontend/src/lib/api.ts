// Typed client for the Otto backend (Fastify @ /api, proxied to :8010 in dev).

export interface ConnectStatus {
  signoz: { ok: boolean; services?: number; otto?: boolean; error?: string };
  grafana: { ok: boolean; count?: number; error?: string };
}

export interface Svc { name: string; callRate?: number; errorRate?: number; p99Ns?: number; numCalls?: number }
export interface ServicesResult { observed: Svc[]; copilot: Svc | null }
export interface Operation { name: string; p95Ns: number; numCalls: number }
export interface OperationsResult { service: string; operations: Operation[] }

export interface PendingWrite { tool: string; args: unknown; description?: string }
export interface AskResult { answer?: string; turns?: number; skillsLoaded: number; pending?: PendingWrite[]; threadId?: string }

export interface RunRecord {
  id: string; at: number; playbook: 'migration' | 'slo';
  title: string; summary: string; applied: boolean; webUrl?: string;
  stats: Record<string, number | string>;
}

export interface CoverageRow { name: string; traces: boolean; metrics: boolean; logs: boolean; callRate?: number; errorRate?: number }
export interface CoverageResult {
  services: CoverageRow[];
  self: CoverageRow[];
  gaps: { service: string; missing: ('traces' | 'metrics' | 'logs')[] }[];
  totals: { traces: number; metrics: number; logs: number };
}

export interface GrafanaDash { uid: string; title: string; tags?: string[]; folderTitle?: string }

export type PanelStatus = 'validated' | 'validated_with_renames' | 'needs_review' | 'unsupported' | 'missing';

export interface ReadinessItem { name: string; verdict: 'matched' | 'renamed' | 'missing'; mappedTo?: string; reason?: string; panelsAffected: string[] }
export interface ReadinessReport {
  metrics: ReadinessItem[];
  perPanelPrediction: Record<string, PanelStatus>;
  summary: { matched: number; renamed: number; missing: number };
}
export interface ReadinessResult { title: string; panels: number; structural: number; report: ReadinessReport }

export interface PanelOutcome { panelId: string; title: string; grafanaType: string; path: 'deterministic' | 'agent' | 'none'; status: PanelStatus; notes?: string; seriesCount?: number }
export interface Receipt {
  playbook: string; total: number; migrated: number;
  counts: Record<string, number>; recovered: string[];
  llm: { calls: number; inputTokens: number; outputTokens: number };
  durationMs: number; artifacts: string[];
  fidelity?: { titleMatch: boolean; tagsCarried: boolean; descriptionPresent: boolean; sectionsExpected: number; sectionsCreated: number; panelsMigrated: number; panelsTotal: number };
  variables?: { kept: string[]; dropped: string[] };
}
export interface MigrateResult {
  title: string; summary: { total: number; migrated: number };
  outcomes: PanelOutcome[]; receipt: Receipt; createdId?: string; webUrl?: string;
}

export interface SloEvidence { service: string; operation: string; windowLabel: string; total: number; errors: number; successPct: number; p50Ns: number; p95Ns: number; p99Ns: number; pctUnderThreshold?: number }
export interface SloProposal { service: string; operation: string; objectivePct: number; latencyThresholdMs: number; windowDays: number; reasoning: string; budgetHoursPerWindow: number }
export interface SloAnalysis {
  operationExplanation: string;
  sliType: 'availability' | 'latency' | 'both';
  sliDefinition: string;
  reasoning: string;
  errorBudget: string;
  alternatives: { label: string; note: string }[];
  sreNotes: string[];
  trend: { windowLabel: string; recentP95Ms: number; olderP95Ms: number; verdict: 'stable' | 'degrading' | 'improving' };
}
export interface Channel { name: string; type: string }
export interface SloResult { evidence: SloEvidence; proposal: SloProposal; analysis: SloAnalysis; applied?: { dashboardId?: string; alertCreated: boolean; alertError?: string }; webUrl?: string }

// SSE-over-POST: streams `data: {json}` events so the UI can show each step live.
export type MigrateStreamEvent =
  | { type: 'stage'; stage: string; status: 'start' | 'done'; note?: string }
  | { type: 'panel'; panelId: string; title: string; path: string; status: string; note?: string }
  | { type: 'done'; result: MigrateResult }
  | { type: 'error'; error: string };
export type SloStreamEvent =
  | { type: 'step'; step: string; status: 'start' | 'done'; note?: string }
  | { type: 'done'; result: SloResult }
  | { type: 'error'; error: string };

export async function streamPost<E>(path: string, body: unknown, onEvent: (e: E) => void): Promise<void> {
  const res = await fetch(`/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok || !res.body) throw new Error((await res.text()) || res.statusText);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data:'));
      if (line) { try { onEvent(JSON.parse(line.slice(5).trim()) as E); } catch { /* skip malformed */ } }
    }
  }
}

async function req<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

export const api = {
  health: () => req<{ ok: boolean }>('/health'),
  connect: () => req<ConnectStatus>('/connect'),
  grafanaDashboards: () => req<{ dashboards: GrafanaDash[] }>('/grafana/dashboards'),
  services: () => req<ServicesResult>('/signoz/services'),
  operations: (service: string) => req<OperationsResult>(`/signoz/operations?service=${encodeURIComponent(service)}`),
  channels: () => req<{ channels: Channel[] }>('/signoz/channels'),
  auditCoverage: () => req<CoverageResult>('/audit/coverage'),
  runs: () => req<{ runs: RunRecord[] }>('/runs'),
  readiness: (b: { uid?: string; dashboard?: unknown }) => req<ReadinessResult>('/readiness', { method: 'POST', body: JSON.stringify(b) }),
  migrate: (b: { uid?: string; dashboard?: unknown; apply?: boolean }) => req<MigrateResult>('/migrate', { method: 'POST', body: JSON.stringify(b) }),
  slo: (b: { service: string; operation: string; timeRange?: string; apply?: boolean; channel?: string }) => req<SloResult>('/slo', { method: 'POST', body: JSON.stringify(b) }),
  opsDashboard: (b: { apply?: boolean }) => req<{ applied: boolean; createdId?: string; webUrl?: string }>('/ops/dashboard', { method: 'POST', body: JSON.stringify(b) }),
  ask: (b: { question?: string; threadId: string; approve?: boolean }) => req<AskResult>('/ask', { method: 'POST', body: JSON.stringify(b) }),
};

// formatting helpers (mono / tabular readouts)
export const ms = (nano: number) => `${(nano / 1e6).toFixed(nano / 1e6 < 10 ? 1 : 0)} ms`;
export const pct = (n: number, d = 1) => `${n.toFixed(d)}%`;
export const statusColor: Record<PanelStatus, string> = {
  validated: 'var(--color-phosphor)',
  validated_with_renames: 'var(--color-warn)',
  needs_review: 'var(--color-cyan)',
  unsupported: 'var(--color-fg-faint)',
  missing: 'var(--color-danger)',
};
export const statusLabel: Record<PanelStatus, string> = {
  validated: 'validated',
  validated_with_renames: 'renamed',
  needs_review: 'needs review',
  unsupported: 'unsupported',
  missing: 'missing metric',
};
