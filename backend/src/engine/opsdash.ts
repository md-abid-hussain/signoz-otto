// The Otto Ops dashboard (DESIGN §7 "demo payoff"): Otto builds, in the same SigNoz it manages,
// a dashboard of its OWN behaviour from its OWN telemetry — runs, panel outcomes, LLM spend,
// run latency, and the slowest panels. After a migration you flip here and see the trace + cost
// of the run you just watched. Trace-based panels use the confirmed otto.run/panel.migrate spans;
// count/spend panels use the otto.* metrics.

const NS = 'none';

/** metrics builder-widget query (dashboard shape) */
function metricQ(name: string, metricName: string, timeAgg: string, spaceAgg: string, groupBy: string[], legend: string): Record<string, unknown> {
  return {
    queryName: name, expression: name, dataSource: 'metrics', stepInterval: 60,
    aggregations: [{ metricName, timeAggregation: timeAgg, spaceAggregation: spaceAgg }],
    filter: { expression: '' },
    groupBy: groupBy.map((k) => ({ key: k, dataType: 'string', type: 'tag' })),
    orderBy: [], selectColumns: [], functions: [], legend, reduceTo: 'sum', disabled: false,
  };
}

/** traces builder-widget query (dashboard shape) */
function traceQ(name: string, agg: string, filter: string, groupBy: string[], legend: string, reduceTo = 'sum', limit?: number): Record<string, unknown> {
  return {
    queryName: name, expression: name, dataSource: 'traces', stepInterval: 60,
    aggregations: [{ expression: agg }], filter: { expression: filter },
    groupBy: groupBy.map((k) => ({ key: k, dataType: 'string', type: 'tag' })),
    orderBy: groupBy.length ? [{ columnName: '#SIGNOZ_VALUE', order: 'desc' }] : [],
    selectColumns: [], functions: [], legend, reduceTo, disabled: false,
    ...(limit ? { limit } : {}),
  };
}

function widget(id: string, title: string, panelTypes: string, queryData: unknown[], yAxisUnit = NS): Record<string, unknown> {
  return {
    id, title, description: '', panelTypes, nullZeroValues: 'zero', opacity: '1',
    timePreferance: 'GLOBAL_TIME', yAxisUnit, selectedLogFields: [], selectedTracesFields: [],
    thresholds: [], contextLinks: { linksData: [] },
    query: { id: `q-${id}`, queryType: 'builder', promql: [], clickhouse_sql: [], builder: { queryData, queryFormulas: [] } },
  };
}

function row(id: string, title: string): Record<string, unknown> {
  return {
    id, panelTypes: 'row', title, description: '',
    query: { queryType: 'builder', promql: [], clickhouse_sql: [], builder: { queryData: [], queryFormulas: [] } },
    selectedLogFields: [], selectedTracesFields: [], thresholds: [], contextLinks: { linksData: [] },
  };
}

const uid = (fallback: string) => globalThis.crypto?.randomUUID?.() ?? fallback;

export function buildOttoOpsDashboard(): Record<string, unknown> {
  const rHealth = uid('row-health');
  const rDetail = uid('row-detail');
  return {
    title: 'Otto Ops — self-observability',
    description: 'Otto watching itself. Built by Otto from its own OpenTelemetry telemetry in the same SigNoz it manages: every migration is a trace (otto.run → panel.migrate → llm.call), every panel outcome a metric, every LLM call token-counted. The tool that manages your observability is itself fully observable.',
    tags: ['otto', 'self-observability', 'ops'],
    variables: {},
    layout: [
      { i: rHealth, x: 0, y: 0, w: 12, h: 1 },
      { i: 'ops-runs', x: 0, y: 1, w: 4, h: 4 },
      { i: 'ops-panels', x: 4, y: 1, w: 4, h: 4 },
      { i: 'ops-tokens', x: 8, y: 1, w: 4, h: 4 },
      { i: 'ops-duration', x: 0, y: 5, w: 6, h: 6 },
      { i: 'ops-runs-time', x: 6, y: 5, w: 6, h: 6 },
      { i: rDetail, x: 0, y: 11, w: 12, h: 1 },
      { i: 'ops-by-status', x: 0, y: 12, w: 6, h: 6 },
      { i: 'ops-slowest', x: 6, y: 12, w: 6, h: 6 },
    ],
    widgets: [
      row(rHealth, 'Run health'),
      widget('ops-runs', 'Total migration runs', 'value', [traceQ('A', 'count()', "name = 'otto.run'", [], 'runs')]),
      widget('ops-panels', 'Panels processed', 'value', [metricQ('A', 'otto.panels', 'increase', 'sum', [], 'panels')]),
      widget('ops-tokens', 'LLM tokens consumed', 'value', [metricQ('A', 'otto.llm.tokens', 'increase', 'sum', [], 'tokens')]),
      widget('ops-duration', 'Run duration p95', 'graph', [traceQ('A', 'p95(duration_nano)', "name = 'otto.run'", [], 'p95 duration', 'avg')], 'ns'),
      widget('ops-runs-time', 'Runs over time', 'graph', [traceQ('A', 'count()', "name = 'otto.run'", [], 'runs')]),
      row(rDetail, 'Migration detail'),
      widget('ops-by-status', 'Panels by outcome', 'bar', [metricQ('A', 'otto.panels', 'increase', 'sum', ['status'], '{{status}}')]),
      widget('ops-slowest', 'Slowest panels (p95)', 'table', [traceQ('A', 'p95(duration_nano)', "name = 'panel.migrate'", ['otto.panel'], '{{otto.panel}}', 'avg', 10)], 'ns'),
    ],
  };
}
