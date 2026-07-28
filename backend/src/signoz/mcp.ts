// SigNoz access over MCP (HTTP transport) via @langchain/mcp-adapters.
// Connects to signoz-mcp at SIGNOZ_MCP_URL (/mcp, :8000) with the required
// SIGNOZ-API-KEY header (verified: 401 without). Exposes the raw LangChain tool
// objects, a JSON-parsing `call()` helper, and the MCP resources/prompts.

import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { withSpan } from '../otel/index.js';

export interface SigNozMcp {
  raw: StructuredToolInterface[];
  /** invoke a tool by its base name (e.g. "list_metrics") and JSON-parse the result */
  call<T = unknown>(baseName: string, args: Record<string, unknown>): Promise<T>;
  toolNames: string[];
  /** MCP resources — the canonical signoz://… docs (dashboard/alert/promql instructions & examples) */
  listResources: () => Promise<unknown>;
  readResource: (uri: string) => Promise<unknown>;
  /** MCP prompts (if the server serves any) */
  listPrompts: () => Promise<unknown>;
  getPrompt: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
  close: () => Promise<void>;
}

/** match a loaded tool by base name regardless of any server prefix the adapter adds */
function findByBase(tools: StructuredToolInterface[], base: string): StructuredToolInterface | undefined {
  return tools.find((t) => t.name === base || t.name.endsWith(base) || t.name.endsWith(`signoz_${base}`) || t.name.includes(base));
}

export async function connectSigNoz(opts?: { url?: string; apiKey?: string }): Promise<SigNozMcp> {
  const url = opts?.url ?? process.env.SIGNOZ_MCP_URL ?? 'http://localhost:8000/mcp';
  const apiKey = opts?.apiKey ?? process.env.SIGNOZ_API_KEY;
  if (!apiKey) throw new Error('SIGNOZ_API_KEY is required (sent as SIGNOZ-API-KEY header to signoz-mcp)');

  const client = new MultiServerMCPClient({
    mcpServers: {
      signoz: {
        url,
        headers: { 'SIGNOZ-API-KEY': apiKey },
      },
    },
  });

  const raw = await client.getTools();

  const call = <T = unknown>(baseName: string, args: Record<string, unknown>): Promise<T> =>
    withSpan(`signoz.tool ${baseName}`, { 'otto.kind': 'mcp', 'otto.tool': baseName }, async () => {
    const tool = findByBase(raw, baseName);
    if (!tool) throw new Error(`MCP tool not found: ${baseName} (have: ${raw.map((t) => t.name).join(', ')})`);
    let payload: unknown = await tool.invoke(args);
    // MCP tool results arrive as a JSON string or an MCP content array [{type:'text', text}]
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch { return payload as T; }
    }
    if (Array.isArray(payload) && payload[0] && (payload[0] as { type?: string }).type === 'text') {
      const text = (payload[0] as { text?: string }).text;
      if (typeof text === 'string') {
        try { payload = JSON.parse(text); } catch { payload = text; }
      }
    }
    // some tools return a single content object { type:'text', text, structuredContent } instead of an array
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const p = payload as { type?: string; text?: string; structuredContent?: unknown };
      if (p.type === 'text' && typeof p.text === 'string') {
        try { payload = JSON.parse(p.text); } catch { payload = p.text; }
      } else if (p.structuredContent !== undefined) {
        payload = p.structuredContent;
      }
    }
    return payload as T;
  });

  const SERVER = 'signoz';
  const listResources = () => client.listResources(SERVER);
  const readResource = (uri: string) => client.readResource(SERVER, uri);
  const getPromptClient = async () => (await client.getClient(SERVER)) as { listPrompts?: () => Promise<unknown>; getPrompt?: (a: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown> } | undefined;
  const listPrompts = async () => { const c = await getPromptClient(); return c?.listPrompts ? c.listPrompts() : { prompts: [] }; };
  const getPrompt = async (name: string, args?: Record<string, unknown>) => { const c = await getPromptClient(); return c?.getPrompt ? c.getPrompt({ name, arguments: args }) : { error: 'prompts not supported' }; };

  return { raw, call, toolNames: raw.map((t) => t.name), listResources, readResource, listPrompts, getPrompt, close: () => client.close() };
}
