import { after } from 'node:test';

import Fastify from 'fastify';

import { bridge } from '@ske-io/bridge/fastify';

import { conformance } from './conformance.ts';

conformance('fastify', async (options) => {
  const app = Fastify();
  await app.register(bridge, options);
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.authorization !== 'let-me-in') return reply.code(401).send();
  });
  app.get('/whoami', async (request) => ({ ip: request.ip, protocol: request.protocol, hostname: request.hostname }));
  app.get('/log', async (_request, reply) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    console.log('handled');
    return reply.code(204).send();
  });
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  after(() => app.close());
  return url;
});
