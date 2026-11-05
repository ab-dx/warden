import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const same = (a: string, b: string) => {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
};

// signed "user.expiry.mac" cookie. only the owner can approve a payment, here or from their
// telegram chat, so an agent holding its mcp key still can't get one.
export function sessions(opts: {
  secret: string;
  password: string;
  user: string;
  ttlMs: number;
  now?: () => number;
}) {
  const now = opts.now ?? Date.now;
  const mac = (body: string) => createHmac('sha256', opts.secret).update(body).digest('base64url');
  return {
    login(password: string): string | undefined {
      if (!same(password, opts.password)) return undefined;
      const body = `${opts.user}.${now() + opts.ttlMs}`;
      return `${body}.${mac(body)}`;
    },
    verify(cookie: string | undefined): string | undefined {
      const parts = (cookie ?? '').split('.');
      if (parts.length !== 3) return undefined;
      const [user, exp, sig] = parts as [string, string, string];
      if (!same(sig, mac(`${user}.${exp}`))) return undefined;
      if (!(Number(exp) > now())) return undefined;
      return user;
    },
  };
}

export type Sessions = ReturnType<typeof sessions>;
