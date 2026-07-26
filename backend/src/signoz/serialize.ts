// Serializes the neutral BuilderQuery into the two distinct SigNoz v5 shapes
// verified 2026-07-21 (DESIGN §0):
//   toQueryApi() → POST /api/v5/query_range  (validation / preview)
//   toWidget()   → dashboard widgets[].query.builder.queryData[]  (create)

import type { BuilderQuery, Formula } from '../types.js';

/** Query-range API shape: { type:'builder_query', spec:{...} }. */
export function toQueryApi(q: BuilderQuery): Record<string, unknown> {
  const agg: Record<string, unknown> = { metricName: q.metricName };
  if (q.timeAggregation) agg.timeAggregation = q.timeAggregation;
  if (q.spaceAggregation) agg.spaceAggregation = q.spaceAggregation;
  agg.temporality = 'Unspecified';

  const spec: Record<string, unknown> = {
    name: q.name,
    signal: q.signal,
    stepInterval: 60,
    aggregations: [agg],
    groupBy: q.groupBy.map((name) => ({ name })),
    disabled: false,
  };
  if (q.filterExpr) spec.filter = { expression: q.filterExpr };
  if (q.havingExpr) spec.having = { expression: q.havingExpr };
  if (q.orderBy?.length)
    spec.order = q.orderBy.map((o) => ({ key: { name: o.key }, direction: o.dir }));
  if (q.limit) spec.limit = q.limit;
  if (q.legend) spec.legend = q.legend;

  return { type: 'builder_query', spec };
}

/** Dashboard-widget shape: flat queryData entry. */
export function toWidget(q: BuilderQuery): Record<string, unknown> {
  const agg: Record<string, unknown> = { metricName: q.metricName };
  if (q.timeAggregation) agg.timeAggregation = q.timeAggregation;
  if (q.spaceAggregation) agg.spaceAggregation = q.spaceAggregation;

  const data: Record<string, unknown> = {
    queryName: q.name,
    expression: q.name,
    dataSource: q.signal,
    aggregations: [agg],
    groupBy: q.groupBy.map((key) => ({ key, dataType: 'string', type: 'tag' })),
    orderBy: (q.orderBy ?? []).map((o) => ({ columnName: o.key, order: o.dir })),
    functions: [],
    selectColumns: [],
    stepInterval: 60,
  };
  if (q.filterExpr) data.filter = { expression: q.filterExpr };
  if (q.havingExpr) data.having = { expression: q.havingExpr };
  if (q.limit) data.limit = q.limit;
  if (q.legend) data.legend = q.legend;
  return data;
}

/** Formula entries in each shape. */
export function formulaToQueryApi(f: Formula): Record<string, unknown> {
  return { type: 'builder_formula', spec: { name: f.name, expression: f.expression, disabled: false } };
}
export function formulaToWidget(f: Formula): Record<string, unknown> {
  return { queryName: f.name, expression: f.expression };
}
