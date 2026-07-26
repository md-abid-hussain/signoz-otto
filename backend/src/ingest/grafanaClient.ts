// Live Grafana connect: list dashboards + fetch one by uid via the Grafana HTTP API.
// (File upload is the other ingest mode; this is for "connect to Grafana" in the UI.)

export interface GrafanaClientOpts { url?: string; token?: string }

function headers(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export interface GrafanaDashboardSummary { uid: string; title: string; folder?: string }

export async function listGrafanaDashboards(opts: GrafanaClientOpts = {}): Promise<GrafanaDashboardSummary[]> {
  const base = (opts.url ?? process.env.GRAFANA_URL ?? '').replace(/\/$/, '');
  if (!base) throw new Error('GRAFANA_URL not set');
  const res = await fetch(`${base}/api/search?type=dash-db`, { headers: headers(opts.token ?? process.env.GRAFANA_TOKEN) });
  if (!res.ok) throw new Error(`Grafana search failed: ${res.status}`);
  const rows = (await res.json()) as { uid: string; title: string; folderTitle?: string }[];
  return rows.map((r) => ({ uid: r.uid, title: r.title, folder: r.folderTitle }));
}

export async function fetchGrafanaDashboard(uid: string, opts: GrafanaClientOpts = {}): Promise<unknown> {
  const base = (opts.url ?? process.env.GRAFANA_URL ?? '').replace(/\/$/, '');
  if (!base) throw new Error('GRAFANA_URL not set');
  const res = await fetch(`${base}/api/dashboards/uid/${uid}`, { headers: headers(opts.token ?? process.env.GRAFANA_TOKEN) });
  if (!res.ok) throw new Error(`Grafana fetch failed: ${res.status}`);
  const body = (await res.json()) as { dashboard?: unknown };
  return body.dashboard ?? body;
}
