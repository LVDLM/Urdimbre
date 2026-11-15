import type { IncomingMessage, ServerResponse } from 'node:http';

const MAX_DIRECT_UPLOAD_BYTES = 3 * 1024 * 1024;
const MAX_MIRROR_BYTES = 5 * 1024 * 1024;

export default function handler(
  _req: IncomingMessage,
  res: ServerResponse
) {
  const token = (process.env.GITHUB_MEDIA_TOKEN || '').trim();
  const owner = (process.env.GITHUB_MEDIA_OWNER || 'LVDLM').trim() || 'LVDLM';
  const repo = (process.env.GITHUB_MEDIA_REPO || 'Urdimbre_medios').trim() || 'Urdimbre_medios';
  const branch = (process.env.GITHUB_MEDIA_BRANCH || 'main').trim() || 'main';

  const payload = JSON.stringify({
    configured: Boolean(token),
    owner,
    repo,
    branch,
    maxUploadBytes: MAX_DIRECT_UPLOAD_BYTES,
    maxMirrorBytes: MAX_MIRROR_BYTES,
  });

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(payload);
}
