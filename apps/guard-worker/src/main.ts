import 'reflect-metadata';
import { Controller, Get, HttpException, Inject, Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadConfig } from './config.js';
import { GuardRuntime } from './worker.js';

@Controller()
class HealthController {
  constructor(@Inject(GuardRuntime) private readonly runtime: GuardRuntime) {}

  @Get('healthz')
  health() {
    if (!this.runtime.healthy) throw new HttpException({ status: 'starting' }, 503);
    return { status: 'ok' };
  }
}

@Module({
  controllers: [HealthController],
  providers: [{ provide: GuardRuntime, useFactory: () => new GuardRuntime(loadConfig()) }],
})
class AppModule {}

const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();
const { GUARD_PORT } = loadConfig();
await app.listen(GUARD_PORT);
Logger.log(`guard-worker listening on ${GUARD_PORT}`, 'main');
