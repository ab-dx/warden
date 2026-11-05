import { toJson } from '@bufbuild/protobuf';
import { timestampDate, timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type Client as RpcClient } from '@connectrpc/connect';
import {
  Body,
  type CanActivate,
  Controller,
  Delete,
  type ExecutionContext,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Injectable,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Client as TemporalClient } from '@temporalio/client';
import {
  type CallSummary,
  CallSummarySchema,
  GetCallResponseSchema,
  MandateSchema,
  type PolicyService,
  VerifyChainResponseSchema,
} from '@warden/contracts';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { decide, type Ledger, pendingApprovals } from './approvals.js';
import type { Sessions } from './session.js';

export const DEPS = Symbol('deps');
export type Deps = {
  sessions: Sessions;
  ledger: Ledger;
  policy: RpcClient<typeof PolicyService>;
  temporal: TemporalClient;
  secureCookie: boolean;
  // a note for the owner on each held payment; advice only
  brief: (call: CallSummary) => Promise<string>;
};

const COOKIE = 'warden_session';

function cookieOf(req: Request): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

type Authed = Request & { user?: string };

@Injectable()
class SignedIn implements CanActivate {
  constructor(@Inject(DEPS) private readonly deps: Deps) {}
  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<Authed>();
    // a cross-site form can't send json, and the cookie is same-site, so this also stops csrf
    if (req.method !== 'GET' && !req.is('application/json'))
      throw new HttpException('send json', 415);
    const user = this.deps.sessions.verify(cookieOf(req));
    if (!user) throw new HttpException('sign in first', 401);
    req.user = user;
    return true;
  }
}

// policy-service validation errors are meant for the person filling in the form
async function rpc<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    const e = ConnectError.from(err);
    if (e.code === Code.InvalidArgument) throw new HttpException(e.rawMessage, 400);
    if (e.code === Code.NotFound) throw new HttpException(e.rawMessage, 404);
    throw new HttpException('a warden service did not answer', 502);
  }
}

@Controller('api/session')
export class SessionController {
  constructor(@Inject(DEPS) private readonly deps: Deps) {}

  @Post()
  @HttpCode(204)
  login(@Body() body: { password?: unknown }, @Res({ passthrough: true }) res: Response) {
    const cookie =
      typeof body?.password === 'string' ? this.deps.sessions.login(body.password) : undefined;
    if (!cookie) throw new HttpException('That password is not right.', 401);
    res.cookie(COOKIE, cookie, {
      httpOnly: true,
      sameSite: 'strict',
      secure: this.deps.secureCookie,
      path: '/',
    });
  }

  @Get()
  who(@Req() req: Request) {
    const user = this.deps.sessions.verify(cookieOf(req));
    if (!user) throw new HttpException('sign in first', 401);
    return { user };
  }

  @Delete()
  @HttpCode(204)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(COOKIE, { path: '/' });
  }
}

const decision = z.object({ approved: z.boolean() });

const newMandate = z.object({
  agentId: z.string().min(1),
  task: z.string().min(1),
  maxPerCall: z.string(),
  maxTotal: z.string(),
  currency: z.string().default('USD'),
  counterparties: z.array(z.string()).default([]),
  tools: z.array(z.string()).min(1),
  expiresInMinutes: z.number().int().positive(),
});

@Controller('api')
@UseGuards(SignedIn)
export class ApiController {
  constructor(@Inject(DEPS) private readonly deps: Deps) {}

  @Get('approvals')
  async approvals() {
    const rows = await pendingApprovals(this.deps.ledger, this.deps.temporal);
    return Promise.all(
      rows.map(async (r) => ({
        call: toJson(CallSummarySchema, r.call),
        brief: await this.deps.brief(r.call),
        expiresAt: r.expiresAt ?? null,
        requestedAt: r.requestedAt ? timestampDate(r.requestedAt).toISOString() : null,
      })),
    );
  }

  @Post('approvals/:callId')
  @HttpCode(202)
  async decide(@Param('callId') callId: string, @Body() body: unknown, @Req() req: Authed) {
    const parsed = decision.safeParse(body);
    if (!parsed.success)
      throw new HttpException('send { "approved": true } or { "approved": false }', 400);
    const r = await decide(
      this.deps.temporal,
      callId,
      parsed.data.approved,
      `dashboard:${req.user}`,
    );
    if (r === 'not_waiting')
      throw new HttpException('This payment is no longer waiting for a decision.', 409);
    return { callId, approved: parsed.data.approved };
  }

  @Get('calls')
  async calls(@Query('limit') limit?: string, @Query('agent') agent?: string) {
    const { calls } = await rpc(
      this.deps.ledger.listCalls({ limit: Number(limit) || 50, agentId: agent ?? '' }),
    );
    return calls.map((c) => toJson(CallSummarySchema, c));
  }

  @Get('calls/:callId')
  async call(@Param('callId') callId: string) {
    return toJson(GetCallResponseSchema, await rpc(this.deps.ledger.getCall({ callId })));
  }

  @Get('ledger/verify')
  async verify() {
    return toJson(VerifyChainResponseSchema, await rpc(this.deps.ledger.verifyChain({})));
  }

  @Get('mandates')
  async mandates() {
    const { mandates } = await rpc(this.deps.policy.listMandates({ agentId: '' }));
    return mandates.map((m) => toJson(MandateSchema, m));
  }

  @Post('mandates')
  async createMandate(@Body() body: unknown, @Req() req: Authed) {
    const parsed = newMandate.safeParse(body);
    if (!parsed.success)
      throw new HttpException(
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    const m = parsed.data;
    const { mandate } = await rpc(
      this.deps.policy.createMandate({
        mandate: {
          agentId: m.agentId,
          // the signed-in person is who granted it, whatever the form says
          userId: req.user ?? '',
          task: m.task,
          maxPerCall: { value: m.maxPerCall, currency: m.currency },
          maxTotal: { value: m.maxTotal, currency: m.currency },
          counterparties: m.counterparties,
          tools: m.tools,
          expiresAt: timestampFromDate(new Date(Date.now() + m.expiresInMinutes * 60_000)),
        },
      }),
    );
    return mandate ? toJson(MandateSchema, mandate) : null;
  }

  @Delete('mandates/:id')
  async revoke(@Param('id') id: string) {
    const { mandate } = await rpc(this.deps.policy.revokeMandate({ mandateId: id }));
    return mandate ? toJson(MandateSchema, mandate) : null;
  }
}
