import express from 'express';

import { bridge } from '@ske-io/bridge/express';

import { conformance } from './conformance.ts';
import { serve } from './helpers.ts';

conformance('express', async (options) => {
  const app = express();
  bridge(app, options);
  app.use((req, res, next) => {
    if (req.headers.authorization !== 'let-me-in') res.sendStatus(401);
    else next();
  });
  app.get('/whoami', (req, res) => {
    res.json({ ip: req.ip, protocol: req.protocol, hostname: req.hostname });
  });
  app.get('/log', async (_req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    console.log('handled');
    res.sendStatus(204);
  });
  return serve(app);
});
