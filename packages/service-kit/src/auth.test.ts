import { describe, expect, it } from 'vitest';
import { requireBearer } from './auth.js';

function call(header: string | undefined) {
  let status = 0;
  let passed = false;
  const res = {
    status: (s: number) => {
      status = s;
      return { json: () => {} };
    },
  };
  requireBearer('s3cret-token')(
    { headers: { authorization: header } } as never,
    res as never,
    () => {
      passed = true;
    },
  );
  return { status, passed };
}

describe('requireBearer', () => {
  it('lets the right token through', () => {
    expect(call('Bearer s3cret-token').passed).toBe(true);
  });

  it.each([undefined, '', 'Bearer s3cret-tokeX', 'Bearer s3cret-token ', 's3cret-token'])(
    'rejects %j',
    (h) => {
      expect(call(h)).toEqual({ status: 401, passed: false });
    },
  );
});
