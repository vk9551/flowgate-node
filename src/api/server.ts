// Server setup — mirrors internal/api/router.go.
// buildServer wires the Fastify instance, auth hook, routes, and dashboard.
// Node is single-threaded, so atomic config swap via { current: Config }
// replaces Go's sync.RWMutex.

import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from '../config/model.js';
import type { Store } from '../store/store.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import { registerDashboard } from '../dashboard/serve.js';
import { type ConfigRef, createAuthHook } from './middleware.js';
import { registerRoutes } from './routes.js';

export type { ConfigRef };

export interface ServerOptions {
  configPath?: string; // path to flowgate.yaml — used by the /v1/policies/reload endpoint
  config: Config;
  store: Store;
  scheduler?: Scheduler;
}

// buildServer creates and configures a Fastify instance.
// Does NOT call listen() — use startServer() for production or inject() for tests.
export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false });
  const configRef: ConfigRef = { current: opts.config };
  const startTime = Date.now();

  // Auth hook added at root scope — applies to every registered route.
  fastify.addHook('onRequest', createAuthHook(configRef));

  // Dashboard static serving (creates placeholder dist/ if absent).
  await fastify.register(registerDashboard);

  // All API routes.
  registerRoutes(fastify, {
    configRef,
    configPath: opts.configPath ?? '',
    store:      opts.store,
    startTime,
    scheduler:  opts.scheduler,
  });

  return fastify;
}

// startServer starts listening and installs SIGINT/SIGTERM shutdown handlers.
export async function startServer(opts: ServerOptions, port: number): Promise<void> {
  const server = await buildServer(opts);

  const shutdown = async (): Promise<void> => {
    await server.close();
    process.exit(0);
  };

  process.once('SIGINT',  () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });

  await server.listen({ port, host: '0.0.0.0' });
  console.log(`FlowGate listening on :${port}`);
}
