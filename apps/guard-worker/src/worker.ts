import { fileURLToPath } from 'node:url';
import { Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { NativeConnection, Worker } from '@temporalio/worker';
import { ConnectorService, PolicyService } from '@warden/contracts';
import { startOutbox } from '@warden/outbox';
import { internalClient } from '@warden/service-kit';
import pg from 'pg';
import { createActivities } from './activities.js';
import type { Config } from './config.js';

// advisory lock id for this service's outbox relay; one leader per database
const RELAY_LOCK = 0x67756172;

export class GuardRuntime implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('guard-worker');
  private readonly pool: pg.Pool;
  private worker: Worker | undefined;
  private running: Promise<void> | undefined;
  private outbox: { stop: () => Promise<void> } | undefined;

  constructor(private readonly config: Config) {
    this.pool = new pg.Pool({ connectionString: config.GUARD_DATABASE_URL, max: 10 });
  }

  async onApplicationBootstrap() {
    const c = this.config;
    this.outbox = await startOutbox({
      pool: this.pool,
      brokers: c.KAFKA_BROKERS.split(','),
      clientId: 'guard-worker',
      lockKey: RELAY_LOCK,
      onError: (err) => this.log.warn(`outbox relay: ${(err as Error).message}`),
    });

    this.worker = await Worker.create({
      connection: await NativeConnection.connect({ address: c.TEMPORAL_ADDRESS }),
      namespace: c.TEMPORAL_NAMESPACE,
      taskQueue: c.GUARD_TASK_QUEUE,
      workflowsPath: fileURLToPath(new URL('./workflow.js', import.meta.url)),
      activities: createActivities({
        policy: internalClient(PolicyService, c.POLICY_URL, c.POLICY_TOKEN),
        connector: internalClient(ConnectorService, c.CONNECTOR_URL, c.CONNECTOR_TOKEN),
        pool: this.pool,
      }),
    });
    this.running = this.worker.run();
    this.log.log(`polling ${c.GUARD_TASK_QUEUE} on ${c.TEMPORAL_ADDRESS}`);
  }

  async onApplicationShutdown() {
    this.worker?.shutdown();
    await this.running?.catch(() => {});
    await this.outbox?.stop();
    await this.pool.end();
  }

  get healthy() {
    return this.worker?.getState() === 'RUNNING';
  }
}
