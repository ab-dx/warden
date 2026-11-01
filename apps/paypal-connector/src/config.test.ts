import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = {
  PAYPAL_CLIENT_ID: 'id',
  PAYPAL_CLIENT_SECRET: 'super-secret-value',
  CONNECTOR_TOKEN: 'x'.repeat(32),
};

describe('loadConfig', () => {
  it('defaults to sandbox endpoints and stdio', () => {
    expect(loadConfig(base)).toMatchObject({
      PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
      PAYPAL_MCP_TRANSPORT: 'stdio',
    });
  });

  it('refuses live paypal endpoints', () => {
    expect(() => loadConfig({ ...base, PAYPAL_API_BASE: 'https://api-m.paypal.com' })).toThrow(
      'PAYPAL_API_BASE',
    );
    expect(() => loadConfig({ ...base, PAYPAL_MCP_URL: 'https://mcp.paypal.com/sse' })).toThrow();
  });

  it('names bad keys without echoing secret values', () => {
    try {
      loadConfig({ ...base, CONNECTOR_TOKEN: 'short' });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('CONNECTOR_TOKEN');
      expect((err as Error).message).not.toContain('super-secret-value');
    }
  });
});
