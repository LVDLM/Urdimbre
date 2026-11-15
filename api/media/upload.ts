import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleUploadMediaRequest, HttpError } from '../../server/mediaService.ts';

async function readJsonBody(req: IncomingMessage & { body?: any }): Promise<any> {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf-8');
  return text ? JSON.parse(text) : {};
}

export default async function handler(
  req: IncomingMessage & { body?: any },
  res: ServerResponse
) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  try {
    const body = await readJsonBody(req);
    const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
    const result = await handleUploadMediaRequest(authHeader, body);
    res.statusCode = 200;
    res.end(JSON.stringify(result));
  } catch (err: any) {
    res.statusCode = err instanceof HttpError ? err.statusCode : 500;
    res.end(JSON.stringify({ error: err?.message || 'Error interno al subir el archivo.' }));
  }
}
