import { describe, expect, it } from 'vitest';
import { agentKeys } from './agents.js';

const KEY = 'k'.repeat(32);

describe('agentKeys', () => {
  it('maps a bearer key to its agent', () => {
    const agentFor = agentKeys(`ops-agent:${KEY}, other:${'o'.repeat(30)}`);
    expect(agentFor(`Bearer ${KEY}`)).toBe('ops-agent');
    expect(agentFor(`Bearer ${'o'.repeat(30)}`)).toBe('other');
  });

  it.each([undefined, '', KEY, `Bearer ${KEY}x`, `bearer ${KEY}`])('rejects %j', (h) => {
    expect(agentKeys(`ops-agent:${KEY}`)(h)).toBeUndefined();
  });

  it('refuses weak or malformed config', () => {
    expect(() => agentKeys('ops-agent:short')).toThrow(/24/);
    expect(() => agentKeys(`:${KEY}`)).toThrow();
    expect(() => agentKeys('')).toThrow();
  });
});
