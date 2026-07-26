import { describe, expect, it } from 'vitest';
import { mapPromql, matchersToFilter } from '../src/mapper/promql.js';
import { toQueryApi, toWidget } from '../src/signoz/serialize.js';

describe('matchersToFilter', () => {
  it('maps equality and regex matchers', () => {
    expect(matchersToFilter('{service="frontend", code=~"5.."}').expr).toBe(
      "service = 'frontend' AND code REGEXP '5..'",
    );
  });
  it('maps negation matchers', () => {
    expect(matchersToFilter('{job!="batch", path!~"/health.*"}').expr).toBe(
      "job != 'batch' AND path NOT REGEXP '/health.*'",
    );
  });
  it('notes template variables', () => {
    const r = matchersToFilter('{ns="$namespace"}');
    expect(r.expr).toBe("ns = '$namespace'");
    expect(r.notes.join()).toContain('template variable');
  });
});

describe('mapPromql — golden table', () => {
  it('bare selector', () => {
    const r = mapPromql('node_memory_MemAvailable_bytes{instance="a"}');
    expect(r.ok).toBe(true);
    expect(r.query).toMatchObject({
      metricName: 'node_memory_MemAvailable_bytes',
      filterExpr: "instance = 'a'",
      spaceAggregation: 'avg',
    });
  });

  it('rate + sum by', () => {
    const r = mapPromql('sum by (service) (rate(http_requests_total{job="api"}[5m]))');
    expect(r.ok).toBe(true);
    expect(r.query).toMatchObject({
      metricName: 'http_requests_total',
      filterExpr: "job = 'api'",
      timeAggregation: 'rate',
      spaceAggregation: 'sum',
      groupBy: ['service'],
    });
  });

  it('by-clause after the group also works', () => {
    const r = mapPromql('sum(rate(http_requests_total[5m])) by (service, route)');
    expect(r.ok).toBe(true);
    expect(r.query?.groupBy).toEqual(['service', 'route']);
    expect(r.query?.spaceAggregation).toBe('sum');
  });

  it('histogram_quantile p95, drops le from groupBy', () => {
    const r = mapPromql(
      'histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket[5m])))',
    );
    expect(r.ok).toBe(true);
    expect(r.query).toMatchObject({
      metricName: 'http_request_duration_seconds_bucket',
      spaceAggregation: 'p95',
      timeAggregation: 'rate',
      groupBy: ['route'],
    });
  });

  it('topk → order by + limit', () => {
    const r = mapPromql('topk(5, sum by (service) (rate(errors_total[5m])))');
    expect(r.ok).toBe(true);
    expect(r.query?.limit).toBe(5);
    expect(r.query?.orderBy).toEqual([{ key: 'value', dir: 'desc' }]);
    expect(r.query?.groupBy).toEqual(['service']);
  });

  it('bottomk → ascending', () => {
    const r = mapPromql('bottomk(20, sum by (route) (rate(requests_total[5m])))');
    expect(r.query?.orderBy).toEqual([{ key: 'value', dir: 'asc' }]);
    expect(r.query?.limit).toBe(20);
  });

  it('comparison → having', () => {
    const r = mapPromql('sum by (endpoint) (rate(hits_total[5m])) > 1000');
    expect(r.ok).toBe(true);
    expect(r.query?.havingExpr).toBe('value > 1000');
  });

  it('scalar arithmetic recorded as formula note', () => {
    const r = mapPromql('sum(rate(errors_total[5m])) * 100');
    expect(r.ok).toBe(true);
    expect(r.notes.join()).toContain('formula');
  });

  it('irate approximated as rate with a note', () => {
    const r = mapPromql('irate(cpu_seconds_total[1m])');
    expect(r.query?.timeAggregation).toBe('rate');
    expect(r.notes.join()).toContain('irate approximated');
  });
});

describe('mapPromql — unsupported long tail', () => {
  it('vector-to-vector comparison is unsupported', () => {
    const r = mapPromql('foo_total > bar_total');
    expect(r.ok).toBe(false);
    expect(r.unsupported?.join()).toContain('vector-to-vector');
  });

  it('label_replace is unsupported', () => {
    const r = mapPromql('label_replace(up, "x", "$1", "y", "(.*)")');
    expect(r.ok).toBe(false);
  });
});

describe('serializers produce the two verified v5 shapes', () => {
  const r = mapPromql('sum by (service) (rate(signoz_calls_total{code=~"5.."}[5m]))');
  const q = r.query!;

  it('toQueryApi shape (validation)', () => {
    const api = toQueryApi(q) as any;
    expect(api.type).toBe('builder_query');
    expect(api.spec.signal).toBe('metrics');
    expect(api.spec.aggregations[0]).toMatchObject({
      metricName: 'signoz_calls_total',
      timeAggregation: 'rate',
      spaceAggregation: 'sum',
    });
    expect(api.spec.filter.expression).toBe("code REGEXP '5..'");
    expect(api.spec.groupBy).toEqual([{ name: 'service' }]);
  });

  it('toWidget shape (dashboard create)', () => {
    const w = toWidget(q) as any;
    expect(w.queryName).toBe('A');
    expect(w.dataSource).toBe('metrics');
    expect(w.groupBy).toEqual([{ key: 'service', dataType: 'string', type: 'tag' }]);
    expect(w.filter.expression).toBe("code REGEXP '5..'");
  });
});
