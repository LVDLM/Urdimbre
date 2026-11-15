import type { IncomingMessage, ServerResponse } from 'node:http';
import { getMediaServiceStatus } from '../../server/mediaService';

export default function handler(
  _req: IncomingMessage,
  res: ServerResponse
) {
  const payload = JSON.stringify(getMediaServiceStatus());
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(payload);
}
