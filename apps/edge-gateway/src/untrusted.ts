import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult } from './render.js';

// the agent's other tools (mail, web, docs) routed through warden, so it knows what the
// agent has read. their output is treated as untrusted.
export type Untrusted = {
  list(): Promise<Tool[]>;
  // undefined when no untrusted server has a tool by that name
  call(name: string, args: Record<string, unknown>): Promise<ToolResult | undefined>;
};

export const noUntrusted: Untrusted = { list: async () => [], call: async () => undefined };

const TOOL_CACHE_MS = 60_000;

export function untrustedServers(
  urls: string[],
  reserved: (name: string) => boolean,
  warn: (msg: string) => void,
): Untrusted {
  const clients = new Map<string, Client>();
  let cached: { at: number; tools: Tool[]; route: Map<string, string> } | undefined;

  const client = async (url: string) => {
    let c = clients.get(url);
    if (!c) {
      c = new Client({ name: 'warden', version: '0.1.0' });
      await c.connect(new StreamableHTTPClientTransport(new URL(url)));
      clients.set(url, c);
    }
    return c;
  };
  const drop = (url: string) => {
    void clients.get(url)?.close();
    clients.delete(url);
  };

  const refresh = async () => {
    if (cached && Date.now() - cached.at < TOOL_CACHE_MS) return cached;
    const tools: Tool[] = [];
    const route = new Map<string, string>();
    let ok = true;
    for (const url of urls) {
      try {
        for (const t of (await (await client(url)).listTools()).tools) {
          // a server that offers a paypal tool name is trying to shadow it
          if (reserved(t.name) || route.has(t.name)) {
            warn(`ignoring tool ${t.name} from ${url}: name already taken`);
            continue;
          }
          route.set(t.name, url);
          tools.push(t);
        }
      } catch (err) {
        // a mailbox that is down just means fewer tools, not a broken gateway
        warn(`untrusted server ${url}: ${(err as Error).message}`);
        drop(url);
        ok = false;
      }
    }
    // don't remember a list with a server missing, so it shows up once it's back
    const fresh = { at: ok ? Date.now() : 0, tools, route };
    cached = fresh;
    return fresh;
  };

  return {
    list: async () => (await refresh()).tools,
    async call(name, args) {
      const url = (await refresh()).route.get(name);
      if (!url) return undefined;
      try {
        const r = await (await client(url)).callTool({ name, arguments: args });
        return {
          content: (r.content as ToolResult['content']) ?? [],
          ...(r.isError ? { isError: true } : {}),
        };
      } catch (err) {
        drop(url);
        throw err;
      }
    },
  };
}
