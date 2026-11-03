import { describe, expect, it } from 'vitest';
import { sessions } from './session.js';

const base = { secret: 's'.repeat(32), password: 'correct horse', user: 'priya', ttlMs: 1000 };

describe('sessions', () => {
  it('issues a cookie for the right password only', () => {
    const s = sessions(base);
    expect(s.login('wrong')).toBeUndefined();
    expect(s.verify(s.login('correct horse'))).toBe('priya');
  });

  it('rejects forged, edited and expired cookies', () => {
    let t = 0;
    const s = sessions({ ...base, now: () => t });
    const c = s.login('correct horse') as string;
    const [user, exp, sig] = c.split('.');
    expect(s.verify(`admin.${exp}.${sig}`)).toBeUndefined();
    expect(s.verify(`${user}.99999999.${sig}`)).toBeUndefined();
    expect(
      s.verify(sessions({ ...base, secret: 'x'.repeat(32) }).login('correct horse')),
    ).toBeUndefined();
    expect(s.verify(undefined)).toBeUndefined();
    t = 1001;
    expect(s.verify(c)).toBeUndefined();
  });
});
