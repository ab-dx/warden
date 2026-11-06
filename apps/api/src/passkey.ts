import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { CallSummary } from '@warden/contracts';
import { toMinor } from '@warden/core';

// step-up for big approvals: above a threshold, approving needs the owner's passkey, not just
// a signed-in session or a telegram tap. a stolen cookie or chat can still say no, never yes.

type Stored = { id: string; publicKey: string; counter: number; transports?: string[] };

// approving, above the line, needs a passkey. saying no never does, and an amount warden
// couldn't price counts as above
export function needsPasskey(
  call: Pick<CallSummary, 'amount'>,
  approved: boolean,
  aboveMinor: bigint | undefined,
) {
  if (!approved || aboveMinor === undefined) return false;
  if (!call.amount) return true;
  return toMinor(call.amount) > aboveMinor;
}

export function passkeys(opts: { file: string; origin: string; aboveMinor: bigint | undefined }) {
  const rpID = new URL(opts.origin).hostname;
  // shortcut: one owner, one passkey, kept in a file on the api's volume; a table once
  // there is more than one owner
  const load = (): Stored | undefined =>
    existsSync(opts.file) ? (JSON.parse(readFileSync(opts.file, 'utf8')) as Stored) : undefined;
  const save = (c: Stored) => {
    mkdirSync(dirname(opts.file), { recursive: true });
    writeFileSync(opts.file, JSON.stringify(c), { mode: 0o600 });
  };
  // one challenge per ceremony, used once: "register", or the call id being approved
  const pending = new Map<string, string>();
  const credential = (c: Stored) => ({
    id: c.id,
    publicKey: new Uint8Array(Buffer.from(c.publicKey, 'base64url')),
    counter: c.counter,
    ...(c.transports ? { transports: c.transports as never } : {}),
  });

  return {
    aboveMinor: opts.aboveMinor,
    registered: () => load() !== undefined,
    needs: (call: Pick<CallSummary, 'amount'>, approved: boolean) =>
      needsPasskey(call, approved, opts.aboveMinor),

    async registerOptions() {
      // replacing a passkey would let whoever holds a session swap in their own, so the
      // first one stays until someone with access to the server removes it
      if (load()) throw new Error('a passkey is already registered');
      const o = await generateRegistrationOptions({
        rpName: 'Warden',
        rpID,
        userName: 'owner',
        attestationType: 'none',
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      });
      pending.set('register', o.challenge);
      return o;
    },

    async register(response: unknown) {
      if (load()) throw new Error('a passkey is already registered');
      const expectedChallenge = pending.get('register');
      pending.delete('register');
      if (!expectedChallenge) throw new Error('start registration first');
      const r = await verifyRegistrationResponse({
        response: response as never,
        expectedChallenge,
        expectedOrigin: opts.origin,
        expectedRPID: rpID,
        requireUserVerification: true,
      });
      if (!r.verified) throw new Error('the passkey could not be verified');
      const c = r.registrationInfo.credential;
      save({
        id: c.id,
        publicKey: Buffer.from(c.publicKey).toString('base64url'),
        counter: c.counter,
        ...(c.transports ? { transports: c.transports } : {}),
      });
    },

    async challengeFor(callId: string) {
      const c = load();
      if (!c) throw new Error('register a passkey first');
      const o = await generateAuthenticationOptions({
        rpID,
        allowCredentials: [{ id: c.id, ...(c.transports ? { transports: c.transports } : {}) }],
        userVerification: 'required',
      });
      pending.set(`call:${callId}`, o.challenge);
      return o;
    },

    // true only for an assertion made against this call's own challenge
    async check(callId: string, response: unknown) {
      const c = load();
      const expectedChallenge = pending.get(`call:${callId}`);
      pending.delete(`call:${callId}`);
      if (!c || !expectedChallenge) return false;
      try {
        const r = await verifyAuthenticationResponse({
          response: response as never,
          expectedChallenge,
          expectedOrigin: opts.origin,
          expectedRPID: rpID,
          credential: credential(c),
          requireUserVerification: true,
        });
        if (!r.verified) return false;
        save({ ...c, counter: r.authenticationInfo.newCounter });
        return true;
      } catch {
        return false;
      }
    },
  };
}

export type Passkeys = ReturnType<typeof passkeys>;
