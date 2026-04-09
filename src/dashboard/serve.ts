// Dashboard static file serving — mirrors internal/dashboard package in flowgate-go.
// Serves dashboard/dist/ under /dashboard/ prefix.
// Creates a placeholder index.html if the dist directory doesn't exist,
// so the server starts cleanly even before `make build` is run.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import type { FastifyInstance } from 'fastify';
import staticPlugin from '@fastify/static';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
// Resolve to dashboard/dist/ relative to the project root (two levels up from src/dashboard/).
const DIST_PATH = path.resolve(__dirname, '../../dashboard/dist');

const PLACEHOLDER_HTML = `<!DOCTYPE html>
<html>
<body style="background:#0f0f0f;color:#e0e0e0;font-family:monospace;padding:2rem">
  <p>Run <code>make build</code> to build the dashboard.</p>
</body>
</html>
`;

// ensureDist creates dashboard/dist/index.html if not present.
export function ensureDist(): void {
  if (!fs.existsSync(DIST_PATH)) {
    fs.mkdirSync(DIST_PATH, { recursive: true });
  }
  const indexPath = path.join(DIST_PATH, 'index.html');
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, PLACEHOLDER_HTML, 'utf8');
  }
}

// registerDashboard mounts the React dist under /dashboard/.
// Redirect /dashboard → /dashboard/ for clean browser navigation.
export async function registerDashboard(fastify: FastifyInstance): Promise<void> {
  ensureDist();

  await fastify.register(staticPlugin, {
    root:           DIST_PATH,
    prefix:         '/dashboard/',
    decorateReply:  false,
  });

  // Redirect bare /dashboard to /dashboard/
  fastify.get('/dashboard', async (_request, reply) => {
    return reply.redirect(301, '/dashboard/');
  });
}
