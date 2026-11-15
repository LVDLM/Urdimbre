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
  try {
    const res = await fetch('/api/media/status');
    if (res.ok) {
      const data = (await res.json()) as MediaServiceStatus;
      cachedStatus = { value: data, fetchedAt: Date.now() };
      return data;
    }
  } catch {
    // Fallback defaults when API endpoint is unavailable
  }
  return {
    configured: false,
    owner: 'LVDLM',
    repo: 'Urdimbre_medios',
    branch: 'main',
    maxUploadBytes: MAX_DIRECT_UPLOAD_BYTES,
    maxMirrorBytes: MAX_MIRROR_BYTES,
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

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload?.error || `Error ${res.status} al subir el archivo.`);
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

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload?.error || `Error ${res.status} al migrar el archivo incrustado.`);
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

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload?.error || `Error ${res.status} al copiar la URL externa.`);
  }
  return payload as UploadedMediaResponse;
}
