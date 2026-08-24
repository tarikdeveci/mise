import { createApp } from './http/server.js';
import { logger } from './obs/logger.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

async function main(): Promise<void> {
  const app = await createApp();

  // Graceful shutdown: a meal log in flight should finish, not 502.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      logger.info({ signal }, 'shutting down');
      void app.close().then(() => process.exit(0));
    });
  }

  await app.listen({ port: PORT, host: HOST });
  logger.info({ port: PORT, host: HOST }, 'mise api listening');
}

main().catch((err: unknown) => {
  logger.error({ err }, 'failed to start');
  process.exit(1);
});
