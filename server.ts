import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  getMediaServiceStatus,
  handleMirrorMediaRequest,
  handleUploadMediaRequest,
  HttpError,
} from './server/mediaService.ts';

async function startServer() {
  const app = express();
  const port = Number(process.env.PORT) || 3000;

  // Support up to 3 MB binary files (~4.2 MB base64 JSON) cleanly
  app.use(express.json({ limit: '8mb' }));

  app.get('/api/media/status', (_req, res) => {
    res.json(getMediaServiceStatus());
  });

  app.post('/api/media/upload', async (req, res) => {
    try {
      const result = await handleUploadMediaRequest(req.headers.authorization, req.body || {});
      res.json(result);
    } catch (err: any) {
      const status = err instanceof HttpError ? err.statusCode : 500;
      res.status(status).json({ error: err?.message || 'Error interno al subir el archivo.' });
    }
  });

  app.post('/api/media/mirror', async (req, res) => {
    try {
      const result = await handleMirrorMediaRequest(req.headers.authorization, req.body || {});
      res.json(result);
    } catch (err: any) {
      const status = err instanceof HttpError ? err.statusCode : 500;
      res.status(status).json({ error: err?.message || 'Error interno al copiar la URL.' });
    }
  });

  const isProd = process.env.NODE_ENV === 'production';
  const distDir = path.resolve(process.cwd(), 'dist');

  if (!isProd || !fs.existsSync(distDir)) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
