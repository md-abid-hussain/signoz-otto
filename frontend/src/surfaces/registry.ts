// Single source of truth for the surfaces — drives the sidebar nav, the About page, and the
// per-surface info popups. Descriptions/use-cases are distilled from the SigNoz skills + PRODUCT.md.

export interface SurfaceMeta {
  id: string;
  path: string;
  label: string;
  hint: string;
  icon: string; // svg path
  emoji?: string;
  blurb: string; // one-liner
  what: string; // longer "what it does"
  useCases: string[];
}

export const SURFACES: SurfaceMeta[] = [
  {
    id: 'home', path: '/', label: 'Overview', hint: 'connection & instance',
    icon: 'M3 12 12 3l9 9M5 10v10h5v-6h4v6h5V10',
    blurb: 'Connection status, the observed-service map, and the one-engine pitch.',
    what: 'The landing view: confirms Otto is connected to your SigNoz + Grafana, maps the observed services (with Otto held separate as the copilot), and links into each workflow.',
    useCases: ['Verify the SigNoz/Grafana connection', 'See which services are live', 'Jump into a workflow'],
  },
  {
    id: 'audit', path: '/audit', label: 'Coverage audit', hint: 'telemetry readiness',
    icon: 'M9 11l3 3 8-8M4 12a8 8 0 1 0 16 0 8 8 0 0 0-16 0',
    blurb: 'Which services emit which signals — traces, metrics, logs — with the gaps called out.',
    what: 'Discovers, live, the service×signal coverage matrix via get_field_values per signal. Otto surfaces gaps (e.g. a service whose logs never reached SigNoz) and hints the collector fix — it does not change ingestion itself.',
    useCases: ['Find services missing logs/metrics/traces in SigNoz', 'Prove telemetry coverage before migrating dashboards', 'Spot ingestion gaps to fix in the collector'],
  },
  {
    id: 'migrate', path: '/migrate', label: 'Migrate', hint: 'Grafana → SigNoz',
    icon: 'M4 7h11M4 7l3-3M4 7l3 3M20 17H9M20 17l-3-3M20 17l-3 3',
    blurb: 'Translate a Grafana dashboard to SigNoz faithfully, panel by panel, with your approval.',
    what: 'The deep workflow. Deterministic PromQL→Query-Builder translation for the mechanical parts, the agent for the tail (renamed metrics, exotic constructs). Every panel is validated against live data; nothing is written until you approve; a replication check confirms fidelity.',
    useCases: ['Move years of Grafana dashboards to SigNoz', 'Know what will break before committing (readiness)', 'Get a faithful replica, not a rebuild'],
  },
  {
    id: 'slo', path: '/slo', label: 'SLO copilot', hint: 'reliability targets',
    icon: 'M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0ZM12 12l4-4M12 12v-4',
    blurb: 'Evidence-based SLOs — the copilot analyses real traffic like an SRE, then proposes a target.',
    what: 'Reads live traffic for an operation, explains what it is, runs a latency-trend check, reasons about the binding SLI (availability vs latency) grounded in SRE principles, and proposes an achievable objective + error budget. On approval it builds the SLI/budget dashboard and a fast-burn alert.',
    useCases: ['Define an SLO without weeks of manual study', 'Understand SLI vs SLO vs SLA + error budget', 'Ship an SLI dashboard + burn-rate alert'],
  },
  {
    id: 'agent', path: '/agent', label: 'AgentOtto', hint: 'the teammate', emoji: '🕵️',
    icon: 'M4 5h16v11H8l-4 4V5Z',
    blurb: 'A conversational SRE teammate over your live SigNoz — reads freely, acts only with approval.',
    what: 'A deepagents agent with the full SigNoz MCP toolset and the SigNoz skills. Ask about your telemetry in plain English and it investigates across traces, logs and metrics; when the conversation leads to a change, the write is gated behind an approval card. It remembers the conversation across turns.',
    useCases: ['"Why is checkout p99 up since yesterday?"', '"Which services have the highest error rate?"', '"Create an alert for that" — gated by your approval'],
  },
  {
    id: 'runs', path: '/runs', label: 'Run history', hint: 'receipts',
    icon: 'M4 6h16M4 12h16M4 18h10M18 16v4M18 20l2-2M18 20l-2-2',
    blurb: 'Every applied migration & SLO as a scored receipt — nothing happens unrecorded.',
    what: 'A record of what Otto actually did: each applied run with its counts, LLM spend, duration, and a link to the created artifact. The same runs are traced end-to-end in Otto Ops.',
    useCases: ['Show a lead what the AI did this week', 'Audit every applied change', 'Re-open a created dashboard'],
  },
  {
    id: 'ops', path: '/ops', label: 'Otto Ops', hint: 'self-observability',
    icon: 'M4 19V5M9 19V9M14 19v-7M19 19V7',
    blurb: 'The tool that manages your observability is itself observable — Otto watching Otto.',
    what: 'Otto self-instruments with OpenTelemetry and ships its own traces (otto.run → panel.migrate → llm.call), metrics, and a frontend RUM service to the same SigNoz it manages. Build the Otto Ops dashboard here and see the trace + cost of the run you just watched.',
    useCases: ['Prove exemplary OTel instrumentation (Track 02)', 'See per-run cost and latency', 'Watch the agent as a live trace'],
  },
];

export const surfaceByPath = (p: string): SurfaceMeta | undefined => SURFACES.find((s) => s.path === p);
