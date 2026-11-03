import { type Client, WorkflowNotFoundError } from '@temporalio/client';
import type { GuardInput, GuardResult } from '@warden/contracts';

// failed: the workflow broke, so whether money moved is unknown
export type Held =
  | { done: GuardResult }
  | { pending: string }
  | { missing: true }
  | { failed: true };

export class Guard {
  constructor(
    private readonly temporal: Client,
    private readonly taskQueue: string,
    private readonly holdMs: number,
  ) {}

  // waits up to holdMs, since most mcp clients cope with a slow tool better than with polling
  async run(input: GuardInput, agentId: string): Promise<Held> {
    const handle = await this.temporal.workflow.start('paymentGuard', {
      taskQueue: this.taskQueue,
      workflowId: input.callId,
      args: [input],
      memo: { agentId },
    });
    let timer: NodeJS.Timeout | undefined;
    const held = new Promise<Held>((resolve) => {
      // out of time: say what the workflow is actually doing, since a slow upstream
      // isn't the same as waiting on the user
      timer = setTimeout(() => {
        handle.query<string>('status').then(
          (status) => resolve({ pending: status }),
          () => resolve({ pending: 'processing' }),
        );
      }, this.holdMs);
    });
    try {
      const result = handle.result().then(
        (done: GuardResult): Held => ({ done }),
        (): Held => ({ failed: true }),
      );
      return await Promise.race([result, held]);
    } finally {
      clearTimeout(timer);
    }
  }

  // only the agent that made a call can read it back
  async check(callId: string, agentId: string): Promise<Held> {
    const handle = this.temporal.workflow.getHandle(callId);
    try {
      const d = await handle.describe();
      if (d.memo?.agentId !== agentId) return { missing: true };
      if (d.status.name === 'RUNNING') return { pending: await handle.query<string>('status') };
      if (d.status.name !== 'COMPLETED') return { failed: true };
      return { done: (await handle.result()) as GuardResult };
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) return { missing: true };
      throw err;
    }
  }
}
