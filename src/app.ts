import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { AppContext } from './context.js';
import { registerApi } from './routes/api.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

export async function buildApp(ctx: AppContext) {
  const app = Fastify({ logger: ctx.cfg.env === 'development' ? { level: 'info' } : false, bodyLimit: 1_000_000, trustProxy: true });
  await app.register(cookie, { secret: ctx.cfg.sessionSecret });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(multipart, { limits: { fileSize: ctx.cfg.maxUploadBytes, files: 1, fields: 10 } });
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('x-frame-options', 'DENY');
    if (!reply.getHeader('content-security-policy')) {
      reply.header('content-security-policy', "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
    }
    return payload;
  });
  await registerApi(app, ctx);
  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: '/' });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' });
    return reply.sendFile('index.html');
  });
  app.get('/healthz', async () => ({ ok: true }));
  return app;
}
