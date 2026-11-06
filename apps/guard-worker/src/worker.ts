import { fileURLToPath } from 'node:url';
import { Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OpenTelemetryPlugin } from '@temporalio/interceptors-opentelemetry';
import { NativeConnection, Worker } from '@temporalio/worker';
import { ConnectorService, JudgeService, PolicyService } from '@warden/contracts';
import { startOutbox } from '@warden/outbox';
import { internalClient } from '@warden/service-kit';
import pg from 'pg';
import { createActivities } from './activities.js';
import type { Config } from './config.js';

// workflow code runs in temporal's sandbox, outside the node sdk. this plugin carries the trace
// in and on to the activities, and exports the sandbox's own spans. it is built on the 1.x
// otel sdk, so it gets its own 1.x exporter rather than the service-wide one
function tracing() {
  const url = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (!url) return [];
  return [
    new OpenTelemetryPlugin({
      resource: new Resource({ 'service.name': 'guard-worker' }),
      spanProcessor: new BatchSpanProcessor(new OTLPTraceExporter({ url })),
    }),
  ];
}

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
      plugins: tracing(),
      activities: createActivities({
        policy: internalClient(PolicyService, c.POLICY_URL, c.POLICY_TOKEN),
        connector: internalClient(ConnectorService, c.CONNECTOR_URL, c.CONNECTOR_TOKEN),
        judge:
          c.JUDGE_URL && c.JUDGE_TOKEN
            ? internalClient(JudgeService, c.JUDGE_URL, c.JUDGE_TOKEN)
            : undefined,
        pool: this.pool,
      }),
    });
    this.running = this.worker.run();
    this.log.log(`polling ${c.GUARD_TASK_QUEUE} on ${c.TEMPORAL_ADDRESS}`);
    if (!c.JUDGE_URL) this.log.warn('no JUDGE_URL: provenance checks are off');
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
