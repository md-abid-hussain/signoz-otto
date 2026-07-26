// Grafana dashboard JSON → internal PanelSpec[]. Pure, no IO.
// Ingest from the Grafana API export / user upload (never repo/IaC files — F8).
// Structural panels (text, row) carry no queries; captured separately, never dropped unread.

import type { GrafanaTarget, PanelSpec, Threshold } from '../types.js';

export interface TemplateVar {
  name: string;
  query: string; // raw variable query (or custom values)
  type: string; // grafana var type: 'query' (data-backed) | 'textbox' | 'custom' | 'constant' | 'datasource'
}

export interface Section { title: string; y: number } // Grafana row header → SigNoz section

export interface ParsedDashboard {
  title: string;
  description?: string; // original dashboard description (for faithful replica)
  tags: string[]; // original dashboard tags
  panels: PanelSpec[]; // query panels only
  structural: { type: string; title: string; text?: string }[]; // text banners, row headers
  sections: Section[]; // row headers with their y position (for section reproduction)
  variables: TemplateVar[];
  /** distinct metric names + label keys referenced across all panels (readiness input) */
  dependencies: { metrics: string[]; labels: string[] };
}

interface RawPanel {
  id?: number | string;
  title?: string;
  type?: string;
  gridPos?: { x: number; y: number; w: number; h: number };
  targets?: { refId?: string; expr?: string; query?: string; legendFormat?: string; hide?: boolean }[];
  fieldConfig?: { defaults?: { unit?: string; thresholds?: { steps?: { value: number | null; color?: string }[] } } };
  options?: { content?: string }; // text panels
  panels?: RawPanel[]; // collapsed rows nest panels
}

interface RawDashboard {
  title?: string;
  description?: string;
  tags?: string[];
  panels?: RawPanel[];
  templating?: { list?: { name?: string; query?: unknown; type?: string }[] };
}

const STRUCTURAL_TYPES = new Set(['text', 'row']);

function extractThresholds(p: RawPanel): Threshold[] | undefined {
  const steps = p.fieldConfig?.defaults?.thresholds?.steps;
  if (!steps?.length) return undefined;
  const out = steps
    .filter((s) => s.value !== null && s.value !== undefined)
    .map((s) => ({ value: s.value as number, color: s.color }));
  return out.length ? out : undefined;
}

function targetExpr(t: { expr?: string; query?: string }): string {
  return (t.expr ?? t.query ?? '').trim();
}

/** collect metric names + label keys from a PromQL string (best-effort, for readiness) */
function scanDeps(expr: string, metrics: Set<string>, labels: Set<string>): void {
  // labels first: from {matchers} AND from by()/without()/on()/ignoring()/group_* clauses
  for (const block of expr.matchAll(/\{([^}]*)\}/g)) {
    for (const kv of block[1]!.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:=~|!~|!=|=)/g)) labels.add(kv[1]!);
  }
  for (const g of expr.matchAll(/(?:by|without|on|ignoring|group_left|group_right)\s*\(([^)]*)\)/gi)) {
    for (const l of g[1]!.split(',')) { const t = l.trim(); if (t) labels.add(t); }
  }
  // metrics: a name immediately followed by a selector `{` or range `[` (highest precision)
  for (const m of expr.matchAll(/([a-zA-Z_:][a-zA-Z0-9_:.]*)\s*[\{\[]/g)) if (accept(m[1]!)) metrics.add(m[1]!);
  // metrics: sole argument of a time/agg function, e.g. rate(metric_name[..]) or sum(metric)
  for (const m of expr.matchAll(/(?:rate|increase|irate|delta|sum|avg|min|max|count)\s*\(\s*([a-zA-Z_:][a-zA-Z0-9_:.]*)\s*[\[\)]/g)) {
    if (accept(m[1]!)) metrics.add(m[1]!);
  }
}

/** a real metric name has a separator (_/./:) and isn't a PromQL keyword — kills `head`,`sort`,`where` noise */
function accept(name: string): boolean {
  return /[_.:]/.test(name) && !isReservedWord(name);
}

const RESERVED = new Set([
  'sum', 'avg', 'min', 'max', 'count', 'rate', 'increase', 'irate', 'delta',
  'histogram_quantile', 'topk', 'bottomk', 'by', 'without', 'le', 'on', 'ignoring',
  'group_left', 'group_right', 'and', 'or', 'unless', 'offset',
]);
function isReservedWord(w: string): boolean {
  return RESERVED.has(w.toLowerCase()) || /^\d/.test(w);
}

function walkPanels(panels: RawPanel[], out: RawPanel[]): void {
  for (const p of panels) {
    out.push(p);
    if (p.panels?.length) walkPanels(p.panels, out); // collapsed rows
  }
}

export function parseGrafanaDashboard(raw: RawDashboard): ParsedDashboard {
  const all: RawPanel[] = [];
  walkPanels(raw.panels ?? [], all);

  const panels: PanelSpec[] = [];
  const structural: ParsedDashboard['structural'] = [];
  const sections: Section[] = [];
  const bannerTexts: string[] = [];
  const metrics = new Set<string>();
  const labels = new Set<string>();

  for (const p of all) {
    const type = p.type ?? 'unknown';
    const queryTargets = (p.targets ?? []).filter((t) => targetExpr(t) && !t.hide);

    if (STRUCTURAL_TYPES.has(type) || queryTargets.length === 0) {
      // capture text content so it is never dropped unread (folded into dashboard description later)
      structural.push({ type, title: p.title ?? '', text: p.options?.content });
      if (type === 'row' && p.title) sections.push({ title: p.title, y: p.gridPos?.y ?? 0 });
      if (type === 'text' && p.options?.content) bannerTexts.push(p.options.content.trim());
      continue;
    }

    const targets: GrafanaTarget[] = queryTargets.map((t, i) => {
      const expr = targetExpr(t);
      scanDeps(expr, metrics, labels);
      return { refId: t.refId ?? String.fromCharCode(65 + i), expr, legend: t.legendFormat };
    });

    panels.push({
      id: String(p.id ?? p.title ?? panels.length),
      title: p.title ?? '(untitled)',
      grafanaType: type,
      targets,
      unit: p.fieldConfig?.defaults?.unit,
      thresholds: extractThresholds(p),
      gridPos: p.gridPos ?? { x: 0, y: 0, w: 12, h: 8 },
    });
  }

  // a name used as a label key is not a metric — the bare-metric scan over-collects
  // group-by keys (e.g. `by (service_name)`); subtract labels to fix classification.
  for (const l of labels) metrics.delete(l);

  const variables: TemplateVar[] = (raw.templating?.list ?? []).map((v) => ({
    name: v.name ?? '',
    query: typeof v.query === 'string' ? v.query : ((v.query as { query?: string })?.query ?? ''),
    type: v.type ?? 'query', // grafana defaults omitted type to query
  }));

  // faithful description: original description, else the text-banner content (stripped of markdown noise)
  const description = (raw.description?.trim() || bannerTexts.join(' ').replace(/[#*`]/g, '').replace(/\s+/g, ' ').trim() || undefined);

  return {
    title: raw.title ?? '(untitled dashboard)',
    description,
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    panels,
    structural,
    sections: sections.sort((a, b) => a.y - b.y),
    variables,
    dependencies: { metrics: [...metrics].sort(), labels: [...labels].sort() },
  };
}
