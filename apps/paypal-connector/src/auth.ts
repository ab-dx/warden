import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export function requireBearer(expected: string) {
  const want = Buffer.from(`Bearer ${expected}`);
  return (req: Request, res: Response, next: NextFunction) => {
    const got = Buffer.from(req.headers.authorization ?? '');
    if (got.length === want.length && timingSafeEqual(got, want)) return next();
    res.status(401).json({ code: 'unauthenticated' });
  };
}
