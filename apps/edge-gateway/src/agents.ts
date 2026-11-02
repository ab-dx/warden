import { createHash } from 'node:crypto';

const hash = (key: string) => createHash('sha256').update(key).digest('hex');

// WARDEN_AGENT_KEYS="ops-agent:<key>,other-agent:<key>". only hashes are kept in memory
// after boot, and lookups compare hashes, so a key never sits in a map as plaintext.
export function agentKeys(spec: string): (bearer: string | undefined) => string | undefined {
  const byHash = new Map<string, string>();
  for (const pair of spec
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const i = pair.indexOf(':');
    const agent = pair.slice(0, i);
    const key = pair.slice(i + 1);
    if (i <= 0 || !/^[a-z0-9-]{1,64}$/.test(agent))
      throw new Error('WARDEN_AGENT_KEYS entries must look like agent-id:key');
    if (key.length < 24) throw new Error(`key for ${agent} is shorter than 24 characters`);
    byHash.set(hash(key), agent);
  }
  if (byHash.size === 0) throw new Error('WARDEN_AGENT_KEYS has no agents');
  return (bearer) => {
    const m = /^Bearer (.+)$/.exec(bearer ?? '');
    return m?.[1] ? byHash.get(hash(m[1])) : undefined;
  };
}
