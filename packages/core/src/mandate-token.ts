import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  sign,
  verify,
} from 'node:crypto';

// a mandate as a signed token anyone can check offline: a merchant, another service, a
// reviewer. a compact jws with ed25519, so any jwt library verifies it against the public
// key warden publishes at /.well-known/jwks.json.

export type MandateClaims = {
  iss: 'warden';
  // the mandate id
  jti: string;
  // the agent it was granted to
  sub: string;
  task: string;
  tools: string[];
  // empty means any payee
  payees: string[];
  maxPerCall: string;
  maxTotal: string;
  currency: string;
  iat: number;
  exp: number;
  // the same grant in the shape of an ap2 intent mandate, so ap2-speaking merchants and
  // agents can read it. the caps above have no ap2 field, so they stay warden's own claims
  intent_mandate: {
    natural_language_description: string;
    // who may be paid; null means anyone
    merchants: string[] | null;
    skus: null;
    // within the mandate the agent pays without asking again
    user_cart_confirmation_required: false;
    intent_expiry: string;
  };
};

// the owner's answer on one held payment, signed when they gave it: shaped like an ap2
// payment mandate, and kept in the ledger as proof of exactly what was approved
export type ApprovalReceipt = {
  iss: 'warden';
  kind: 'approval';
  // the call id
  jti: string;
  // the agent that asked
  sub: string;
  approved: boolean;
  // "dashboard:owner", "telegram:12345"
  by: string;
  payment_mandate_contents: {
    payment_mandate_id: string;
    payment_details_id: string;
    payment_details_total: { label: string; amount: { currency: string; value: string } };
    merchant_agent: string;
    timestamp: string;
  };
  iat: number;
};

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

// the pkcs8 wrapper for a raw 32-byte ed25519 seed, so the key fits in one .env line
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

export function signingKey(seed: string) {
  const raw = Buffer.from(seed, 'base64url');
  if (raw.length !== 32) throw new Error('MANDATE_SIGNING_KEY must be a 32-byte base64url seed');
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519, raw]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = createPublicKey(privateKey);
  const x = publicKey.export({ format: 'jwk' }).x ?? '';
  const kid = createHash('sha256').update(x).digest('base64url').slice(0, 16);
  return {
    privateKey,
    publicKey,
    kid,
    jwk: { kty: 'OKP', crv: 'Ed25519', x, kid, alg: 'EdDSA', use: 'sig' },
  };
}

type Key = { privateKey: KeyObject; kid: string };

function signJws(claims: object, key: Key) {
  const head = b64(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: key.kid }));
  const body = b64(JSON.stringify(claims));
  const sig = sign(null, Buffer.from(`${head}.${body}`), key.privateKey);
  return `${head}.${body}.${b64(sig)}`;
}

// the claims of a well-formed, ed25519-signed token from warden; throws otherwise
function readJws(token: string, publicKey: KeyObject): Record<string, unknown> {
  const [head, body, sig, extra] = token.split('.');
  if (!head || !body || !sig || extra !== undefined) throw new Error('not a compact jws');
  const header = JSON.parse(Buffer.from(head, 'base64url').toString()) as { alg?: string };
  // only the one algorithm: never "none", never one the token picks for itself
  if (header.alg !== 'EdDSA') throw new Error(`unexpected alg ${header.alg}`);
  if (!verify(null, Buffer.from(`${head}.${body}`), publicKey, Buffer.from(sig, 'base64url')))
    throw new Error('bad signature');
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as Record<string, unknown>;
  if (claims.iss !== 'warden') throw new Error('not issued by warden');
  return claims;
}

export const signMandate = (claims: MandateClaims, key: Key) => signJws(claims, key);
export const signReceipt = (claims: ApprovalReceipt, key: Key) => signJws(claims, key);

// throws unless the token is a valid, unexpired mandate signed by this key
export function verifyMandate(token: string, publicKey: KeyObject, now = Date.now()) {
  const claims = readJws(token, publicKey) as MandateClaims;
  if (!(claims.exp * 1000 > now)) throw new Error('mandate token expired');
  return claims;
}

// a receipt records a past answer, so it never expires; it only has to be genuine
export function verifyReceipt(token: string, publicKey: KeyObject) {
  const claims = readJws(token, publicKey) as Partial<ApprovalReceipt>;
  if (claims.kind !== 'approval') throw new Error('not an approval receipt');
  return claims as ApprovalReceipt;
}
