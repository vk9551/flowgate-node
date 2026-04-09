// JWT auth middleware — mirrors internal/api/middleware.go.
// Exported as a hook factory (not a Fastify plugin) to avoid scope issues.

import jwt from 'jsonwebtoken';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config/model.js';

// ConfigRef holds the live config. Swap .current atomically on hot-reload.
// Replaces Go's sync.RWMutex — Node is single-threaded so a plain object is safe.
export interface ConfigRef {
  current: Config;
}

// createAuthHook returns an onRequest hook that enforces JWT authentication.
// Public routes (/v1/health, /dashboard/*) and auth=none configs skip all checks.
// Mirrors authMiddleware() in middleware.go.
export function createAuthHook(
  configRef: ConfigRef,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // Strip query string to compare only the path.
    const urlPath = request.url.split('?')[0];

    // Health and dashboard are always public.
    if (urlPath === '/v1/health' || urlPath.startsWith('/dashboard')) return;

    const cfg = configRef.current;
    const authType = cfg.server?.auth?.type;

    // If auth is disabled or unconfigured, allow all requests.
    if (!authType || authType === 'none') return;

    // Require "Authorization: Bearer <token>"
    const authHeader = request.headers.authorization ?? '';
    if (!authHeader.startsWith('Bearer ')) {
      void reply.status(401).send({ error: 'missing or malformed Authorization header' });
      return;
    }

    const token = authHeader.slice(7);
    if (!token) {
      void reply.status(401).send({ error: 'missing or malformed Authorization header' });
      return;
    }

    const secret = cfg.server?.auth?.secret ?? '';
    try {
      jwt.verify(token, secret, { algorithms: ['HS256'] });
    } catch (err) {
      void reply.status(401).send({ error: `invalid token: ${(err as Error).message}` });
    }
  };
}
