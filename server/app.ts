import fs from 'node:fs';
import path from 'node:path';
import express, { type Express } from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { ROOT, config } from './config.js';
import { attachContext, requireAppHeader } from './middleware/context.js';
import { errorHandler } from './middleware/errors.js';
import api from './routes/index.js';

export async function createApp(opts: { dev?: boolean; serveClient?: boolean } = {}): Promise<Express> {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  app.use(
    helmet({
      // Vite's dev server injects inline scripts; production gets a strict policy.
      contentSecurityPolicy: opts.dev
        ? false
        : {
            useDefaults: true,
            directives: {
              'script-src': ["'self'"],
              'style-src': ["'self'", "'unsafe-inline'"],
              'img-src': ["'self'", 'data:', 'blob:'],
              'font-src': ["'self'", 'data:'],
              'connect-src': ["'self'"],
              'upgrade-insecure-requests': null,
            },
          },
      crossOriginOpenerPolicy: false,
      originAgentCluster: false,
      // Only meaningful (and only safe to send) once the server is on HTTPS.
      strictTransportSecurity: config.https ? { maxAge: 180 * 86400, includeSubDomains: false } : false,
    }),
  );
  app.use(compression());
  app.use(cookieParser());
  // Bottle photos and process order PDFs (scientist uploads) are the only large requests; everything else stays small.
  app.use(/^\/api\/admin\/ingredients\/[^/]+\/photo$/, express.json({ limit: '3mb' }));
  app.use(/^\/api\/supervisor\/formulas\/import(\/pdf)?$/, express.json({ limit: '9mb' }));
  app.use(express.json({ limit: '256kb' }));

  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', requireAppHeader, attachContext, api);
  app.use('/api', errorHandler);

  if (opts.serveClient === false) return app;

  if (opts.dev) {
    const { createServer } = await import('vite');
    const vite = await createServer({ root: ROOT, server: { middlewareMode: true, hmr: { port: config.port + 1 } }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const dist = path.join(ROOT, 'dist');
    app.use(
      express.static(dist, {
        index: false,
        setHeaders: (res, file) => {
          if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
          else if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        },
      }),
    );
    const indexHtml = path.join(dist, 'index.html');
    app.get(/^(?!\/api\/|\/socket\.io\/).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.type('html').send(fs.readFileSync(indexHtml, 'utf8'));
    });
  }
  app.use(errorHandler);
  return app;
}
