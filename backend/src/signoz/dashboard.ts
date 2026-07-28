// Shared SigNoz dashboard-widget envelope. The migration, SLO, and Otto-Ops builders all emit the
// same Query-Builder widget shape; this is the one place that shape is defined so it can't drift.
// (Only the envelope lives here — each builder still authors its own queries/layout/thresholds.)

export interface WidgetOpts {
  id: string;
  /** internal query id; defaults to `q-<id>` (migration keeps its own `q-<panelId>` form) */
  queryId?: string;
  title: string;
  panelTypes: string;
  queryData: unknown[];
  queryFormulas?: unknown[];
  yAxisUnit?: string;
  thresholds?: unknown[];
}

/** a builder-query dashboard widget (timeseries/value/bar/table/…) in SigNoz's v5 shape */
export function builderWidget(o: WidgetOpts): Record<string, unknown> {
  return {
    id: o.id, title: o.title, description: '', panelTypes: o.panelTypes,
    nullZeroValues: 'zero', opacity: '1', timePreferance: 'GLOBAL_TIME', yAxisUnit: o.yAxisUnit ?? 'none',
    selectedLogFields: [], selectedTracesFields: [], thresholds: o.thresholds ?? [], contextLinks: { linksData: [] },
    query: { id: o.queryId ?? `q-${o.id}`, queryType: 'builder', promql: [], clickhouse_sql: [], builder: { queryData: o.queryData, queryFormulas: o.queryFormulas ?? [] } },
  };
}

/** a section-header row widget (no query) */
export function rowWidget(id: string, title: string): Record<string, unknown> {
  return {
    id, panelTypes: 'row', title, description: '',
    query: { queryType: 'builder', promql: [], clickhouse_sql: [], builder: { queryData: [], queryFormulas: [] } },
    selectedLogFields: [], selectedTracesFields: [], thresholds: [], contextLinks: { linksData: [] },
  };
}
