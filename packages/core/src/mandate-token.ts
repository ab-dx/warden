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

export function signMandate(claims: MandateClaims, key: { privateKey: KeyObject; kid: string }) {
  const head = b64(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: key.kid }));
  const body = b64(JSON.stringify(claims));
  const sig = sign(null, Buffer.from(`${head}.${body}`), key.privateKey);
  return `${head}.${body}.${b64(sig)}`;
}

// throws unless the token is well formed, ed25519-signed by this key, from warden, and unexpired
export function verifyMandate(
  token: string,
  publicKey: KeyObject,
  now = Date.now(),
): MandateClaims {
  const [head, body, sig, extra] = token.split('.');
  if (!head || !body || !sig || extra !== undefined) throw new Error('not a compact jws');
  const header = JSON.parse(Buffer.from(head, 'base64url').toString()) as { alg?: string };
  // only the one algorithm: never "none", never one the token picks for itself
  if (header.alg !== 'EdDSA') throw new Error(`unexpected alg ${header.alg}`);
  if (!verify(null, Buffer.from(`${head}.${body}`), publicKey, Buffer.from(sig, 'base64url')))
    throw new Error('bad signature');
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as MandateClaims;
  if (claims.iss !== 'warden') throw new Error('not issued by warden');
  if (!(claims.exp * 1000 > now)) throw new Error('mandate token expired');
  return claims;
}
