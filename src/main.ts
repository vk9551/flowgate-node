// Entrypoint — parses --config / --port / --db flags, wires config + store +
// scheduler + dispatcher, then starts the Fastify server.

import { readConfig, watchConfig } from './config/loader.js';
import { SqliteStore } from './store/sqlite.js';
import { FlowgateScheduler } from './scheduler/scheduler.js';
import { FlowgateDispatcher } from './dispatcher/dispatcher.js';
import { startServer } from './api/server.js';

function parseArgs(): { configPath: string; port: number; dbPath: string } {
  const args = process.argv.slice(2);
  let configPath = 'flowgate.yaml';
  let port = 8080;
  let dbPath = 'flowgate.db';

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--config' || args[i] === '-config') && args[i + 1]) {
      configPath = args[++i];
    } else if ((args[i] === '--port' || args[i] === '-port') && args[i + 1]) {
      port = parseInt(args[++i], 10);
    } else if ((args[i] === '--db' || args[i] === '-db') && args[i + 1]) {
      dbPath = args[++i];
    }
  }

  return { configPath, port, dbPath };
}

async function main(): Promise<void> {
  const { configPath, port: portArg, dbPath } = parseArgs();

  let config = readConfig(configPath);

  // Config port wins unless explicitly overridden by --port CLI flag.
  // CLI default is 8080; if unchanged and config has a port, use config.
  const port = portArg !== 8080
    ? portArg                            // explicit --port flag
    : (config.server?.port ?? portArg); // config.server.port, or default 8080
  const store = new SqliteStore(dbPath);

  // Dispatcher resolves callback URLs from the live config on each call.
  const dispatcher = new FlowgateDispatcher(() => config);

  // Scheduler fires events via the dispatcher. Delete-before-fire (in scheduler.ts)
  // plus the async setImmediate callback gives the same crash-safety as Go's goroutine.
  const scheduler = new FlowgateScheduler(store, (e) => {
    dispatcher.dispatch(e, 'delay_ready').catch((err: unknown) => {
      console.error('FlowGate: dispatch error', err);
    });
  });
  scheduler.start();

  // Hot-reload: swap config on file change. The dispatcher picks it up automatically
  // via the () => config closure.
  const watcher = watchConfig(configPath, (newCfg) => {
    config = newCfg;
    console.log('FlowGate: config reloaded');
  });

  const shutdown = async (): Promise<void> => {
    scheduler.stop();
    await watcher.close();
  };

  process.once('SIGINT',  () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });

  await startServer({ configPath, config, store, scheduler }, port);
}

main().catch((err) => {
  console.error('FlowGate startup error:', err);
  process.exit(1);
});
