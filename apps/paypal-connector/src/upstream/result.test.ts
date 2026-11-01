import { describe, expect, it } from 'vitest';
import { classify } from './result.js';

const text = (body: unknown) => ({
  content: [{ type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body) }],
});

describe('classify', () => {
  it('reads a paypal success body and pulls out the id', () => {
    expect(classify(text({ id: '3CY5483682137620M', status: 'COMPLETED' }))).toEqual({
      ok: true,
      upstreamRef: '3CY5483682137620M',
    });
  });

  // shapes captured from the sandbox; every one arrived with isError: false
  it.each([
    [
      { ok: false, code: 'PAYPAL_API_SETUP_ERROR', message: 'Unsupported cache mode: default' },
      'PAYPAL_API_SETUP_ERROR',
    ],
    [
      { ok: false, status: 422, code: 'PAYPAL_API_HTTP_ERROR', message: 'x' },
      'PAYPAL_API_HTTP_ERROR',
    ],
    [{ error: { message: 'not supported in sandbox mode', type: 'paypal_error' } }, 'paypal_error'],
  ])('treats %j as a failure even though isError is false', (body, code) => {
    expect(classify({ isError: false, ...text(body) })).toEqual({ ok: false, errorCode: code });
  });

  it('fails closed on anything it cannot read', () => {
    expect(classify(text('Refund created'))).toMatchObject({
      ok: false,
      errorCode: 'UNREADABLE_RESULT',
    });
    expect(classify({ content: [] })).toMatchObject({ ok: false, errorCode: 'EMPTY_RESULT' });
    expect(classify({ toolResult: {} })).toMatchObject({ ok: false });
    expect(classify({ isError: true, ...text({ id: 'X' }) })).toMatchObject({ ok: false });
  });
});
