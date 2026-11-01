import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Config } from '../config.js';
import type { TokenProvider } from '../token.js';

type Connection = { client: Client; token: string };

// paypal's mcp server. stdio runs their package as a child process; the hosted
// sse server fails every tool in sandbox right now, so it is opt-in.
export class PayPalMcp {
  private conn: Connection | undefined;
  private connecting: Promise<Connection> | undefined;

  constructor(
    private readonly config: Pick<Config, 'PAYPAL_MCP_TRANSPORT' | 'PAYPAL_MCP_URL'>,
    private readonly tokens: TokenProvider,
  ) {}

  async listTools() {
    const { client } = await this.connection();
    const tools = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>) {
    const { client } = await this.connection();
    return client.callTool({ name, arguments: args });
  }

  async close(): Promise<void> {
    await this.conn?.client.close();
    this.conn = undefined;
  }

  // the stdio server reads its token once at startup, so a new token means a new child
  private async connection(): Promise<Connection> {
    const token = await this.tokens.get();
    if (this.conn?.token === token) return this.conn;
    this.connecting ??= this.reconnect(token).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async reconnect(token: string): Promise<Connection> {
    const old = this.conn;
    this.conn = undefined;
    await old?.client.close().catch(() => {});

    const client = new Client({ name: 'warden-paypal-connector', version: '0.0.0' });
    client.onclose = () => {
      if (this.conn?.client === client) this.conn = undefined;
    };
    await client.connect(this.transport(token));
    this.conn = { client, token };
    return this.conn;
  }

  private transport(token: string) {
    if (this.config.PAYPAL_MCP_TRANSPORT === 'stdio') {
      return new StdioClientTransport({
        command: process.execPath,
        args: [createRequire(import.meta.url).resolve('@paypal/mcp/dist/index.js'), '--tools=all'],
        // just what the child needs; it never sees the client secret
        env: {
          PATH: process.env.PATH ?? '',
          PAYPAL_ACCESS_TOKEN: token,
          PAYPAL_ENVIRONMENT: 'SANDBOX',
        },
        stderr: 'ignore',
      });
    }
    const authorization = `Bearer ${token}`;
    return new SSEClientTransport(new URL(this.config.PAYPAL_MCP_URL), {
      requestInit: { headers: { authorization } },
      eventSourceInit: {
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization },
          }),
      },
    });
  }
}
