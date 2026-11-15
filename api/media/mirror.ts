import type { IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';

const MAX_MIRROR_BYTES = 5 * 1024 * 1024; // 5 MB

type MediaKind = 'img' | 'sounds';

class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

function getRepoConfig() {
  return {
    token: (process.env.GITHUB_MEDIA_TOKEN || '').trim(),
    owner: (process.env.GITHUB_MEDIA_OWNER || 'LVDLM').trim() || 'LVDLM',
    repo: (process.env.GITHUB_MEDIA_REPO || 'Urdimbre_medios').trim() || 'Urdimbre_medios',
    branch: (process.env.GITHUB_MEDIA_BRANCH || 'main').trim() || 'main',
  };
}

function getFirebaseConfig() {
  return {
    apiKey:
      process.env.FIREBASE_API_KEY ||
      process.env.VITE_FIREBASE_API_KEY ||
      'AIzaSyDEVpXziuBFxnu6ZGhaLesnRXaJkjstrS4',
    projectId:
      process.env.FIREBASE_PROJECT_ID ||
      process.env.VITE_FIREBASE_PROJECT_ID ||
      'youtube2next',
    firestoreDatabaseId:
      process.env.FIREBASE_DATABASE_ID ||
      process.env.VITE_FIREBASE_DATABASE_ID ||
      'ai-studio-motordeaventuras-6db161c5-340a-4759-aa6e-ee66855d7f92',
  };
}

async function verifyRegisteredAuthor(authHeader: string | undefined) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new HttpError(401, 'Debes iniciar sesión con una cuenta de autor registrada para subir archivos.');
  }
  const idToken = authHeader.slice(7).trim();
  if (!idToken) {
    throw new HttpError(401, 'Token de sesión inválido.');
  }

  const fbConfig = getFirebaseConfig();
  let lookupRes: Response;
  try {
    lookupRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(fbConfig.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      }
    );
  } catch (err: any) {
    throw new HttpError(502, `Error al verificar la sesión con Firebase: ${err?.message || 'Error de red'}`);
  }

  if (!lookupRes.ok) {
    throw new HttpError(401, 'Tu sesión ha caducado o no es válida. Vuelve a iniciar sesión.');
  }

  const lookupData = (await lookupRes.json()) as {
    users?: Array<{
      localId?: string;
      email?: string;
      disabled?: boolean;
      providerUserInfo?: Array<{ providerId?: string }>;
    }>;
  };

  const user = lookupData.users?.[0];
  if (!user?.localId) {
    throw new HttpError(401, 'No se pudo verificar tu cuenta de usuario.');
  }
  if (user.disabled) {
    throw new HttpError(403, 'Tu cuenta está deshabilitada.');
  }

  const isRegistered =
    Boolean(user.email) || (Array.isArray(user.providerUserInfo) && user.providerUserInfo.length > 0);
  if (!isRegistered) {
    throw new HttpError(
      403,
      'Las sesiones de invitado o anónimas no pueden subir archivos al repositorio. Inicia sesión con Google o con tu correo registrado.'
    );
  }

  try {
    const dbId = fbConfig.firestoreDatabaseId || '(default)';
    const userDocUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(fbConfig.projectId)}/databases/${encodeURIComponent(dbId)}/documents/users/${encodeURIComponent(user.localId)}`;
    const profileRes = await fetch(userDocUrl, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (profileRes.ok) {
      const profileJson = (await profileRes.json()) as {
        fields?: { isSuspended?: { booleanValue?: boolean } };
      };
      if (profileJson.fields?.isSuspended?.booleanValue === true) {
        throw new HttpError(403, 'Tu cuenta está suspendida y no tiene permisos para subir archivos.');
      }
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
  }

  return {
    uid: user.localId,
    email: user.email || user.localId,
  };
}

function sanitizeSegment(input: string, fallback: string, maxLen = 60): string {
  const cleaned = (input || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLen);
  return cleaned || fallback;
}

const IMG_EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

const SOUND_EXT_BY_MIME: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mpeg3': 'mp3',
  'audio/x-mpeg': 'mp3',
  'audio/x-mp3': 'mp3',
  'audio/ogg': 'ogg',
  'application/ogg': 'ogg',
  'audio/vorbis': 'ogg',
  'audio/opus': 'opus',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'video/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/x-aac': 'aac',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/webm': 'webm',
  'video/webm': 'webm',
};

const VALID_IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg']);
const VALID_SOUND_EXTS = new Set(['mp3', 'ogg', 'oga', 'wav', 'm4a', 'aac', 'flac', 'webm', 'opus']);

function resolveExtensionAndValidate(
  kind: MediaKind,
  mimeTypeRaw: string | undefined,
  fileName: string,
  buffer: Buffer
) {
  const mime = (mimeTypeRaw || '').split(';')[0].trim().toLowerCase();
  const extMatch = (fileName || '').split(/[?#]/)[0].match(/\.([a-zA-Z0-9]+)$/);
  const urlExt = extMatch ? extMatch[1].toLowerCase() : '';

  if (kind === 'img') {
    if (mime.includes('text/html')) {
      throw new HttpError(400, 'La URL no apunta a una imagen directa, sino a una página web HTML.');
    }
    const ext = IMG_EXT_BY_MIME[mime] || (VALID_IMG_EXTS.has(urlExt) ? (urlExt === 'jpeg' ? 'jpg' : urlExt) : '');
    if (!ext) {
      throw new HttpError(400, `Formato de imagen no compatible (${mime || urlExt || 'desconocido'}). Usa PNG, JPG, WebP, GIF o SVG.`);
    }
    if (ext === 'svg') {
      const textPreview = buffer.toString('utf-8', 0, Math.min(buffer.length, 64 * 1024));
      if (/<script[\s>]/i.test(textPreview) || /on\w+\s*=/i.test(textPreview)) {
        throw new HttpError(400, 'El archivo SVG contiene código activo no permitido.');
      }
    }
    return {
      ext,
      normalizedMime: mime.startsWith('image/') ? mime : `image/${ext === 'jpg' ? 'jpeg' : ext === 'svg' ? 'svg+xml' : ext}`,
    };
  }

  if (mime.includes('text/html') || mime.includes('application/json')) {
    throw new HttpError(400, 'La URL no apunta a un archivo de audio directo, sino a una página web.');
  }
  const ext = SOUND_EXT_BY_MIME[mime] || (VALID_SOUND_EXTS.has(urlExt) ? urlExt : '');
  if (!ext) {
    throw new HttpError(400, `Formato de audio no compatible (${mime || urlExt || 'desconocido'}). Usa MP3, OGG, WAV, M4A, AAC, WebM u Opus.`);
  }
  return {
    ext,
    normalizedMime: mime.startsWith('audio/') || mime === 'application/ogg' ? mime : `audio/${ext === 'mp3' ? 'mpeg' : ext}`,
  };
}

function buildMediaUrls(owner: string, repo: string, branch: string, filePath: string) {
  const encodedPath = filePath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return {
    immediateUrl: `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${encodedPath}`,
    publicationUrl: `https://${owner.toLowerCase()}.github.io/${repo}/${encodedPath}`,
  };
}

async function pushBufferToGitHub(
  kind: MediaKind,
  projectSlug: string,
  originalFileName: string,
  mimeType: string | undefined,
  buffer: Buffer,
  author: { uid: string; email: string }
) {
  const { token, owner, repo, branch } = getRepoConfig();
  if (!token) {
    throw new HttpError(503, 'Falta configurar el secreto GITHUB_MEDIA_TOKEN en el servidor para subir archivos a GitHub.');
  }
  if (buffer.length === 0) {
    throw new HttpError(400, 'El archivo está vacío.');
  }

  const { ext, normalizedMime } = resolveExtensionAndValidate(kind, mimeType, originalFileName, buffer);
  const safeFolder = sanitizeSegment(projectSlug, 'compartidos', 64);
  const rawBase = (originalFileName || (kind === 'img' ? 'imagen' : 'sonido'))
    .split(/[?#]/)[0]
    .replace(/\.[^.]+$/, '');
  const safeBase = sanitizeSegment(rawBase, kind === 'img' ? 'imagen' : 'sonido', 48);
  const shortHash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 10);

  const filePath = `${kind}/${safeFolder}/${safeBase}_${shortHash}.${ext}`;
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${filePath
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/')}`;

  const ghHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Urdimbre-Media-Service',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  try {
    const checkRes = await fetch(`${apiUrl}?ref=${encodeURIComponent(branch)}`, {
      method: 'GET',
      headers: ghHeaders,
    });
    if (checkRes.ok) {
      const urls = buildMediaUrls(owner, repo, branch, filePath);
      return {
        ok: true as const,
        path: filePath,
        immediateUrl: urls.immediateUrl,
        publicationUrl: urls.publicationUrl,
        sizeBytes: buffer.length,
        mimeType: normalizedMime,
        alreadyExists: true,
      };
    }
  } catch {}

  const putBody = JSON.stringify({
    message: `media(${kind}): add ${filePath} by ${author.email}`,
    content: buffer.toString('base64'),
    branch,
  });

  let putRes: Response;
  try {
    putRes = await fetch(apiUrl, {
      method: 'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: putBody,
    });
  } catch (err: any) {
    throw new HttpError(502, `Error de red al conectar con GitHub: ${err?.message || 'sin conexión'}`);
  }

  if (!putRes.ok && (putRes.status === 409 || putRes.status === 422 || putRes.status === 500)) {
    let removedPlaceholder = false;
    for (const dirPath of [kind, `${kind}/${safeFolder}`]) {
      const dirApiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${dirPath
        .split('/')
        .map((s) => encodeURIComponent(s))
        .join('/')}`;
      try {
        const dirCheck = await fetch(`${dirApiUrl}?ref=${encodeURIComponent(branch)}`, {
          method: 'GET',
          headers: ghHeaders,
        });
        if (dirCheck.ok) {
          const dirMeta = (await dirCheck.json()) as Array<unknown> | { type?: string; size?: number; sha?: string };
          if (!Array.isArray(dirMeta) && dirMeta?.type === 'file' && typeof dirMeta.size === 'number' && dirMeta.size <= 4 && dirMeta.sha) {
            const delRes = await fetch(dirApiUrl, {
              method: 'DELETE',
              headers: { ...ghHeaders, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                message: `chore(media): replace empty placeholder "${dirPath}" with directory`,
                sha: dirMeta.sha,
                branch,
              }),
            });
            if (delRes.ok) removedPlaceholder = true;
          }
        }
      } catch {}
    }
    if (removedPlaceholder) {
      putRes = await fetch(apiUrl, {
        method: 'PUT',
        headers: { ...ghHeaders, 'Content-Type': 'application/json' },
        body: putBody,
      });
    }
  }

  if (!putRes.ok) {
    let ghMessage = `Error ${putRes.status} de GitHub`;
    try {
      const errBody = (await putRes.json()) as { message?: string };
      if (errBody?.message) ghMessage = errBody.message;
    } catch {}
    if (putRes.status === 401 || putRes.status === 403) {
      throw new HttpError(502, `GitHub rechazó el token (${ghMessage}). Verifica que GITHUB_MEDIA_TOKEN tenga permiso "Contents: Read and write" en ${owner}/${repo}.`);
    }
    if (putRes.status === 404) {
      throw new HttpError(502, `No se encontró el repositorio ${owner}/${repo} o la rama "${branch}" en GitHub.`);
    }
    throw new HttpError(502, `No se pudo guardar en GitHub: ${ghMessage}`);
  }

  const urls = buildMediaUrls(owner, repo, branch, filePath);
  return {
    ok: true as const,
    path: filePath,
    immediateUrl: urls.immediateUrl,
    publicationUrl: urls.publicationUrl,
    sizeBytes: buffer.length,
    mimeType: normalizedMime,
    alreadyExists: false,
  };
}

function isBlockedPrivateUrl(parsed: URL): boolean {
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return true;
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    ) {
      return true;
    }
  }
  return false;
}

async function readJsonBody(req: IncomingMessage & { body?: any }): Promise<any> {
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) {
      const text = req.body.toString('utf-8');
      return text ? JSON.parse(text) : {};
    }
    if (typeof req.body === 'string') {
      return req.body ? JSON.parse(req.body) : {};
    }
    if (typeof req.body === 'object') {
      return req.body;
    }
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf-8');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'El cuerpo de la petición JSON no es válido.');
  }
}

export default async function handler(
  req: IncomingMessage & { body?: any },
  res: ServerResponse
) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  try {
    const body = await readJsonBody(req);
    const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
    const author = await verifyRegisteredAuthor(authHeader);

    if (body.kind !== 'img' && body.kind !== 'sounds') {
      throw new HttpError(400, 'Tipo de medio inválido (debe ser "img" o "sounds").');
    }
    const kind: MediaKind = body.kind;

    const sourceUrl = typeof body.sourceUrl === 'string' ? body.sourceUrl.trim() : '';
    if (!sourceUrl) {
      throw new HttpError(400, 'Falta la URL de origen.');
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(sourceUrl);
    } catch {
      throw new HttpError(400, 'La URL proporcionada no es válida.');
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new HttpError(400, 'Solo se permiten URLs http:// o https://.');
    }
    if (isBlockedPrivateUrl(parsedUrl)) {
      throw new HttpError(403, 'Dirección de red no permitida.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    let remoteRes: Response;
    try {
      remoteRes = await fetch(sourceUrl, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; UrdimbreMediaMirror/1.0)',
        },
      });
    } catch (err: any) {
      clearTimeout(timeout);
      if (err?.name === 'AbortError') {
        throw new HttpError(504, 'Tiempo de espera agotado al intentar descargar la URL externa.');
      }
      throw new HttpError(502, `No se pudo conectar con la URL externa: ${err?.message || 'Error de red'}`);
    }
    clearTimeout(timeout);

    if (!remoteRes.ok) {
      throw new HttpError(502, `El servidor externo respondió con error HTTP ${remoteRes.status} al descargar el archivo.`);
    }

    const contentLengthHeader = remoteRes.headers.get('content-length');
    if (contentLengthHeader && Number(contentLengthHeader) > MAX_MIRROR_BYTES) {
      const mb = (Number(contentLengthHeader) / (1024 * 1024)).toFixed(2);
      throw new HttpError(413, `El archivo remoto pesa ${mb} MB y supera el límite máximo permitido de copia (5.0 MB).`);
    }

    const reader = remoteRes.body?.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            totalBytes += value.byteLength;
            if (totalBytes > MAX_MIRROR_BYTES) {
              try {
                await reader.cancel();
              } catch {}
              throw new HttpError(413, 'El archivo remoto supera el límite máximo permitido de copia (5.0 MB).');
            }
            chunks.push(value);
          }
        }
      } else {
        const arrBuf = await remoteRes.arrayBuffer();
        totalBytes = arrBuf.byteLength;
        if (totalBytes > MAX_MIRROR_BYTES) {
          throw new HttpError(413, 'El archivo remoto supera el límite máximo permitido de copia (5.0 MB).');
        }
        chunks.push(new Uint8Array(arrBuf));
      }
    } catch (err: any) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, `Error al leer la descarga desde el servidor externo: ${err?.message || 'stream interrumpido'}`);
    }

    const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const contentType = remoteRes.headers.get('content-type') || undefined;
    const pathFromUrl = parsedUrl.pathname.split('/').pop() || '';
    const fileName = body.preferredName || decodeURIComponent(pathFromUrl) || (kind === 'img' ? 'imagen' : 'sonido');

    const result = await pushBufferToGitHub(
      kind,
      body.projectSlug || 'compartidos',
      fileName,
      contentType,
      buffer,
      author
    );

    res.statusCode = 200;
    res.end(JSON.stringify(result));
  } catch (err: any) {
    res.statusCode = err instanceof HttpError ? err.statusCode : 500;
    res.end(JSON.stringify({ error: err?.message || 'Error interno al copiar la URL.' }));
  }
}
