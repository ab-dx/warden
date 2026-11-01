import { Controller, Get, Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import { type Config, loadConfig } from './config.js';
import { clientCredentialsMint, TokenProvider } from './token.js';
import { PayPalMcp } from './upstream/mcp.js';

export const CONFIG = Symbol('config');

@Controller()
class HealthController {
  @Get('healthz')
  health() {
    return { status: 'ok' };
  }
}

class McpLifecycle implements OnModuleDestroy {
  constructor(@Inject(PayPalMcp) private readonly mcp: PayPalMcp) {}
  async onModuleDestroy() {
    await this.mcp.close();
  }
}

@Module({
  controllers: [HealthController],
  providers: [
    { provide: CONFIG, useFactory: () => loadConfig() },
    {
      provide: TokenProvider,
      inject: [CONFIG],
      useFactory: (c: Config) =>
        new TokenProvider(
          clientCredentialsMint(c.PAYPAL_API_BASE, c.PAYPAL_CLIENT_ID, c.PAYPAL_CLIENT_SECRET),
        ),
    },
    {
      provide: PayPalMcp,
      inject: [CONFIG, TokenProvider],
      useFactory: (c: Config, t: TokenProvider) => new PayPalMcp(c, t),
    },
    McpLifecycle,
  ],
})
export class AppModule {}
