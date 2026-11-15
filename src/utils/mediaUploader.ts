import { auth } from '../lib/firebase';
import { formatBytes, MAX_DIRECT_UPLOAD_BYTES, MAX_MIRROR_BYTES } from './mediaLinks';

export type MediaKind = 'img' | 'sounds';

export interface MediaServiceStatus {
  configured: boolean;
  owner: string;
  repo: string;
  branch: string;
  maxUploadBytes: number;
  maxMirrorBytes: number;
  diagnosticError?: string;
}

export interface UploadedMediaResponse {
  ok: true;
  path: string;
  immediateUrl: string;
  publicationUrl: string;
  sizeBytes: number;
  mimeType: string;
  alreadyExists: boolean;
}

let cachedStatus: { value: MediaServiceStatus; fetchedAt: number } | null = null;

export async function getMediaServiceStatus(forceRefresh = false): Promise<MediaServiceStatus> {
  if (!forceRefresh && cachedStatus && Date.now() - cachedStatus.fetchedAt < 30_000) {
    return cachedStatus.value;
  }
  let diagnosticError: string | undefined;
  try {
    const res = await fetch('/api/media/status');
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (res.ok && contentType.includes('application/json')) {
      const data = (await res.json()) as MediaServiceStatus;
      cachedStatus = { value: data, fetchedAt: Date.now() };
      return data;
    }
    if (res.ok && !contentType.includes('application/json')) {
      diagnosticError =
        'La ruta /api/media/status devolvió HTML en lugar de JSON (posible redirección SPA o función /api no desplegada en Vercel).';
    } else {
      diagnosticError = `El endpoint /api/media/status respondió HTTP ${res.status}.`;
    }
  } catch (err: any) {
    diagnosticError = `No se pudo conectar con /api/media/status (${err?.message || 'error de red'}).`;
  }
  return {
    configured: false,
    owner: 'LVDLM',
    repo: 'Urdimbre_medios',
    branch: 'main',
    maxUploadBytes: MAX_DIRECT_UPLOAD_BYTES,
    maxMirrorBytes: MAX_MIRROR_BYTES,
    diagnosticError,
  };
}

export function isRegisteredAuthorSession(): boolean {
  const user = auth.currentUser;
  if (!user) return false;
  if (user.isAnonymous) return false;
  return Boolean(user.email || (user.providerData && user.providerData.length > 0));
}

async function getAuthorBearerToken(): Promise<string> {
  const user = auth.currentUser;
  if (!user || user.isAnonymous || (!user.email && (!user.providerData || user.providerData.length === 0))) {
    throw new Error(
      'Debes iniciar sesión con una cuenta de autor registrada (Google o correo electrónico) para subir archivos al repositorio.'
    );
  }
  return user.getIdToken();
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      if (!result) {
        reject(new Error('No se pudo leer el archivo seleccionado.'));
        return;
      }
      resolve(result);
    };
    reader.onerror = () => reject(new Error('Error al leer el archivo local.'));
    reader.readAsDataURL(file);
  });
}

export async function uploadMediaFileToGitHub(params: {
  file: File;
  kind: MediaKind;
  projectSlug: string;
}): Promise<UploadedMediaResponse> {
  const { file, kind, projectSlug } = params;

  if (file.size > MAX_DIRECT_UPLOAD_BYTES) {
    throw new Error(
      `El archivo "${file.name}" pesa ${formatBytes(file.size)} y supera el límite de subida directa (${formatBytes(MAX_DIRECT_UPLOAD_BYTES)}). Comprímelo o súbelo manualmente a GitHub.`
    );
  }

  const token = await getAuthorBearerToken();
  const dataBase64 = await readFileAsBase64(file);

  const res = await fetch('/api/media/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      kind,
      projectSlug,
      fileName: file.name,
      mimeType: file.type,
      dataBase64,
    }),
  });

  const rawText = await res.text().catch(() => '');
  let payload: any = {};
  try {
    payload = rawText ? JSON.parse(rawText) : {};
  } catch {}
  if (!res.ok) {
    const fallbackDetail = rawText ? ` (${rawText.slice(0, 120).replace(/\s+/g, ' ').trim()})` : '';
    throw new Error(payload?.error || `Error ${res.status} al subir el archivo.${fallbackDetail}`);
  }
  return payload as UploadedMediaResponse;
}

export async function uploadBase64MediaToGitHub(params: {
  dataUrl: string;
  kind: MediaKind;
  projectSlug: string;
  preferredName?: string;
}): Promise<UploadedMediaResponse> {
  const { dataUrl, kind, projectSlug, preferredName } = params;
  const approxBytes = Math.ceil((dataUrl.length * 3) / 4);
  if (approxBytes > MAX_DIRECT_UPLOAD_BYTES + 4096) {
    throw new Error(
      `El recurso incrustado pesa aprox. ${formatBytes(approxBytes)} y supera el límite de ${formatBytes(MAX_DIRECT_UPLOAD_BYTES)}.`
    );
  }

  const token = await getAuthorBearerToken();
  const res = await fetch('/api/media/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      kind,
      projectSlug,
      fileName: preferredName || (kind === 'img' ? 'imagen' : 'sonido'),
      dataBase64: dataUrl,
    }),
  });

  const rawText = await res.text().catch(() => '');
  let payload: any = {};
  try {
    payload = rawText ? JSON.parse(rawText) : {};
  } catch {}
  if (!res.ok) {
    const fallbackDetail = rawText ? ` (${rawText.slice(0, 120).replace(/\s+/g, ' ').trim()})` : '';
    throw new Error(payload?.error || `Error ${res.status} al migrar el archivo incrustado.${fallbackDetail}`);
  }
  return payload as UploadedMediaResponse;
}

export async function mirrorMediaUrlToGitHub(params: {
  sourceUrl: string;
  kind: MediaKind;
  projectSlug: string;
  preferredName?: string;
}): Promise<UploadedMediaResponse> {
  const token = await getAuthorBearerToken();

  const res = await fetch('/api/media/mirror', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(params),
  });

  const rawText = await res.text().catch(() => '');
  let payload: any = {};
  try {
    payload = rawText ? JSON.parse(rawText) : {};
  } catch {}
  if (!res.ok) {
    const fallbackDetail = rawText ? ` (${rawText.slice(0, 120).replace(/\s+/g, ' ').trim()})` : '';
    throw new Error(payload?.error || `Error ${res.status} al copiar la URL externa.${fallbackDetail}`);
  }
  return payload as UploadedMediaResponse;
}
