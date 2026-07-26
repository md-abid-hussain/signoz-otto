// Pragmatic structural PromQL decomposer for the supported subset (DESIGN §1).
// Not a full PromQL parser: it recognises the common nested shapes real
// dashboards use and maps them onto a SigNoz BuilderQuery. Anything it does not
// recognise is returned as `unsupported` so the caller can hand off to the agent.

import type { BuilderQuery, MapResult, SpaceAgg, TimeAgg } from '../types.js';

const OUTER_AGG: Record<string, SpaceAgg> = {
  sum: 'sum',
  avg: 'avg',
  min: 'min',
  max: 'max',
  count: 'count',
};

const TIME_FUNC: Record<string, TimeAgg> = {
  rate: 'rate',
  increase: 'increase',
  irate: 'rate',
  delta: 'increase',
};

const CMP = ['==', '!=', '>=', '<=', '>', '<'];

/** Index of the ')' matching the '(' at openIdx; -1 if unbalanced. */
function matchParen(s: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split on top-level commas, respecting (), [], {} and quotes. */
function splitTopLevelArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(s.slice(start).trim());
  return out;
}

/** Find a top-level comparison operator; returns {op, left, right} or null. */
function splitTopLevelCmp(
  s: string,
): { op: string; left: string; right: string } | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0) {
      for (const op of CMP) {
        if (s.startsWith(op, i)) {
          return {
            op,
            left: s.slice(0, i).trim(),
            right: s.slice(i + op.length).trim(),
          };
        }
      }
    }
  }
  return null;
}

/** Parse `{a="b", c=~"d"}` matcher block into a SigNoz filter expression. */
export function matchersToFilter(block: string): { expr: string; notes: string[] } {
  const notes: string[] = [];
  const inner = block.replace(/^\{/, '').replace(/\}$/, '').trim();
  if (!inner) return { expr: '', notes };
  const parts: string[] = [];
  for (const raw of splitTopLevelArgs(inner)) {
    const m = raw.match(/^([a-zA-Z_][\w.]*)\s*(=~|!~|!=|=)\s*(.+)$/);
    if (!m) {
      notes.push(`could not parse matcher: ${raw}`);
      continue;
    }
    const [, key, op, valRaw] = m;
    const val = valRaw!.replace(/^["']/, '').replace(/["']$/, '');
    if (val.includes('$')) notes.push(`template variable kept literal: ${val}`);
    switch (op) {
      case '=':
        parts.push(`${key} = '${val}'`);
        break;
      case '!=':
        parts.push(`${key} != '${val}'`);
        break;
      case '=~':
        parts.push(`${key} REGEXP '${val}'`);
        break;
      case '!~':
        parts.push(`${key} NOT REGEXP '${val}'`);
        break;
    }
  }
  return { expr: parts.join(' AND '), notes };
}

interface Selector {
  metric: string;
  filter: string;
  notes: string[];
}

/** Parse `metric_name{matchers}[5m]` (window optional) into metric + filter. */
function parseSelector(expr: string): Selector | null {
  const e = expr.trim().replace(/\[[^\]]*\]\s*$/, ''); // drop [5m] window
  const braceIdx = e.indexOf('{');
  if (braceIdx === -1) {
    if (!/^[a-zA-Z_:][\w:.]*$/.test(e)) return null;
    return { metric: e, filter: '', notes: [] };
  }
  const metric = e.slice(0, braceIdx).trim();
  if (metric && !/^[a-zA-Z_:][\w:.]*$/.test(metric)) return null;
  const closeIdx = e.lastIndexOf('}');
  const block = e.slice(braceIdx, closeIdx + 1);
  const { expr: filter, notes } = matchersToFilter(block);
  return { metric, filter, notes };
}

interface AggPeel {
  agg: SpaceAgg;
  groupBy: string[];
  inner: string;
  notes: string[];
}

/** Peel a leading `sum|avg|... [by (labels)] ( inner ) [by (labels)]`. */
function peelOuterAgg(expr: string): AggPeel | null {
  const m = expr.match(/^([a-zA-Z_]+)\b/);
  if (!m) return null;
  const fn = m[1]!.toLowerCase();
  const agg = OUTER_AGG[fn];
  if (!agg) return null;
  const notes: string[] = [];
  let rest = expr.slice(m[0].length).trim();
  let groupBy: string[] = [];

  const byBefore = rest.match(/^(by|without)\s*\(([^)]*)\)/i);
  if (byBefore) {
    if (byBefore[1]!.toLowerCase() === 'without')
      notes.push('`without` grouping approximated as no group-by');
    else groupBy = splitLabels(byBefore[2]!);
    rest = rest.slice(byBefore[0].length).trim();
  }

  if (!rest.startsWith('(')) return null;
  const close = matchParen(rest, 0);
  if (close === -1) return null;
  const inner = rest.slice(1, close).trim();
  let after = rest.slice(close + 1).trim();

  const byAfter = after.match(/^(by|without)\s*\(([^)]*)\)/i);
  if (byAfter && byAfter[1]!.toLowerCase() === 'by') {
    groupBy = splitLabels(byAfter[2]!);
    after = after.slice(byAfter[0].length).trim();
  }
  if (after) notes.push(`ignored trailing tokens after aggregation: ${after}`);
  return { agg, groupBy, inner, notes };
}

function splitLabels(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Peel a leading `func( args )`; returns func name + raw arg list. */
function peelCall(expr: string): { fn: string; args: string[] } | null {
  const m = expr.match(/^([a-zA-Z_]+)\s*\(/);
  if (!m) return null;
  const open = expr.indexOf('(', m[1]!.length);
  const close = matchParen(expr, open);
  if (close === -1) return null;
  if (expr.slice(close + 1).trim()) return null; // trailing tokens => not a clean call
  return { fn: m[1]!.toLowerCase(), args: splitTopLevelArgs(expr.slice(open + 1, close)) };
}

/**
 * Decompose one PromQL expression into a BuilderQuery.
 * Returns ok:false with reasons when the expression is outside the subset.
 */
export function mapPromql(exprInput: string, name = 'A'): MapResult {
  const notes: string[] = [];
  let expr = exprInput.trim();

  const q: BuilderQuery = { name, signal: 'metrics', groupBy: [] };

  // 1. Trailing scalar arithmetic: `... * 100`, `... / 60`
  const scale = splitTrailingScalar(expr);
  if (scale) {
    expr = scale.rest;
    notes.push(
      `scalar ${scale.op} ${scale.num} → apply as formula "${name} ${scale.op} ${scale.num}"`,
    );
  }

  // 2. Top-level comparison → HAVING (only meaningful with an aggregate)
  const cmp = splitTopLevelCmp(expr);
  if (cmp) {
    if (/^-?\d+(\.\d+)?$/.test(cmp.right)) {
      expr = cmp.left;
      q.havingExpr = `value ${cmp.op === '==' ? '=' : cmp.op} ${cmp.right}`;
      notes.push(`comparison → having (${q.havingExpr})`);
    } else {
      return fail(notes, [`vector-to-vector comparison not supported: ${exprInput}`]);
    }
  }

  // 3. histogram_quantile(q, inner)
  const hq = peelCall(expr);
  if (hq && hq.fn === 'histogram_quantile') {
    if (hq.args.length !== 2) return fail(notes, ['histogram_quantile needs 2 args']);
    const p = Number(hq.args[0]);
    q.spaceAggregation = quantileToSpace(p);
    if (!q.spaceAggregation) notes.push(`quantile ${p} rounded to nearest supported`);
    q.spaceAggregation ??= 'p95';
    expr = hq.args[1]!;
    // inner is typically sum by (le) (rate(metric_bucket[5m]))
    const peeled = peelOuterAgg(expr);
    if (peeled) {
      q.groupBy = peeled.groupBy.filter((l) => l !== 'le');
      notes.push(...peeled.notes);
      expr = peeled.inner;
    }
    const tf = peelTimeFunc(expr);
    if (tf) {
      q.timeAggregation = tf.timeAgg;
      notes.push(...tf.notes);
      expr = tf.inner;
    }
    const sel = parseSelector(expr);
    if (!sel) return fail(notes, [`could not parse histogram selector: ${expr}`]);
    q.metricName = sel.metric;
    if (sel.filter) q.filterExpr = sel.filter;
    notes.push(...sel.notes);
    return { ok: true, query: q, notes };
  }

  // 4. topk(n, inner) / bottomk(n, inner)
  if (hq && (hq.fn === 'topk' || hq.fn === 'bottomk')) {
    const n = Number(hq.args[0]);
    if (!Number.isFinite(n)) return fail(notes, ['topk/bottomk needs numeric N']);
    q.limit = n;
    q.orderBy = [{ key: 'value', dir: hq.fn === 'topk' ? 'desc' : 'asc' }];
    notes.push(`${hq.fn}(${n}) → order by value ${hq.fn === 'topk' ? 'desc' : 'asc'} limit ${n}`);
    expr = hq.args[1]!;
  }

  // 5. Outer aggregation `sum by (..) ( inner )`
  const peeled = peelOuterAgg(expr);
  if (peeled) {
    q.spaceAggregation = peeled.agg;
    q.groupBy = peeled.groupBy;
    notes.push(...peeled.notes);
    expr = peeled.inner;
  }

  // 6. Time function `rate(...[5m])`
  const tf = peelTimeFunc(expr);
  if (tf) {
    q.timeAggregation = tf.timeAgg;
    notes.push(...tf.notes);
    expr = tf.inner;
  }

  // 7. Bare selector
  const sel = parseSelector(expr);
  if (!sel) return fail(notes, [`unsupported expression: ${expr}`]);
  q.metricName = sel.metric;
  if (sel.filter) q.filterExpr = sel.filter;
  notes.push(...sel.notes);

  // Defaults when PromQL implied but did not state aggregation.
  if (!q.timeAggregation) {
    q.timeAggregation = 'avg';
    notes.push('no time function; defaulted timeAggregation=avg (verify metric type)');
  }
  if (!q.spaceAggregation) {
    q.spaceAggregation = q.groupBy.length ? 'sum' : 'avg';
    notes.push(`no outer aggregation; defaulted spaceAggregation=${q.spaceAggregation}`);
  }

  return { ok: true, query: q, notes };
}

function peelTimeFunc(
  expr: string,
): { timeAgg: TimeAgg; inner: string; notes: string[] } | null {
  const call = peelCall(expr);
  if (!call) return null;
  const t = TIME_FUNC[call.fn];
  if (!t) return null;
  const notes: string[] = [];
  if (call.fn === 'irate') notes.push('irate approximated as rate');
  if (call.fn === 'delta') notes.push('delta approximated as increase');
  return { timeAgg: t, inner: call.args[0] ?? '', notes };
}

function splitTrailingScalar(
  expr: string,
): { rest: string; op: string; num: string } | null {
  // matches "<inner> * 100" or "<inner> / 60" at top level (right-hand numeric)
  const m = expr.match(/^(.*?)([*/])\s*(-?\d+(?:\.\d+)?)\s*$/s);
  if (!m) return null;
  // ensure the operator is top level (rest has balanced parens)
  const rest = m[1]!.trim();
  let depth = 0;
  for (const c of rest) {
    if (c === '(') depth++;
    else if (c === ')') depth--;
  }
  if (depth !== 0) return null;
  return { rest, op: m[2]!, num: m[3]! };
}

function quantileToSpace(p: number): SpaceAgg | undefined {
  const map: Record<string, SpaceAgg> = {
    '0.5': 'p50',
    '0.9': 'p90',
    '0.95': 'p95',
    '0.99': 'p99',
  };
  return map[String(p)];
}

function fail(notes: string[], reasons: string[]): MapResult {
  return { ok: false, unsupported: reasons, notes };
}
