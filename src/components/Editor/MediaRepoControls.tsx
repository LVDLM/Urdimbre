import React, { useEffect, useState } from 'react';
import { Cloud, Upload, CheckCircle2, AlertCircle, Loader2, FolderGit2 } from 'lucide-react';
import {
  formatBytes,
  getProjectMediaFolderSlug,
  isExternalHttpUrl,
  isGitHubMediaUrl,
  MAX_DIRECT_UPLOAD_BYTES,
  MAX_MIRROR_BYTES,
} from '../../utils/mediaLinks';
import {
  getMediaServiceStatus,
  isRegisteredAuthorSession,
  MediaKind,
  MediaServiceStatus,
  mirrorMediaUrlToGitHub,
  uploadBase64MediaToGitHub,
  uploadMediaFileToGitHub,
} from '../../utils/mediaUploader';

interface MediaRepoControlsProps {
  kind: MediaKind;
  project?: { id?: string; title?: string };
  isShared?: boolean;
  currentUrl?: string;
  embeddedDataUrl?: string;
  preferredName?: string;
  accept?: string;
  uploadLabel?: string;
  isClean?: boolean;
  showUploadButton?: boolean;
  onHostedUrl: (immediateUrl: string, repoPath?: string) => void;
  onFallbackLocalFile?: (file: File) => void;
}

export const MediaRepoControls: React.FC<MediaRepoControlsProps> = ({
  kind,
  project,
  isShared = false,
  currentUrl,
  embeddedDataUrl,
  preferredName,
  accept = kind === 'img' ? 'image/*' : 'audio/*,.mp3,.wav,.ogg,.m4a,.webm',
  uploadLabel = kind === 'img' ? 'Subir imagen al Repo' : 'Subir audio al Repo',
  isClean = false,
  showUploadButton = true,
  onHostedUrl,
  onFallbackLocalFile,
}) => {
  const [status, setStatus] = useState<MediaServiceStatus | null>(null);
  const [busyAction, setBusyAction] = useState<'upload' | 'mirror' | 'migrate' | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    getMediaServiceStatus()
      .then((s) => {
        if (mounted) setStatus(s);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  const folderSlug = getProjectMediaFolderSlug(project, isShared);
  const registered = isRegisteredAuthorSession();
  const maxUpload = status?.maxUploadBytes || MAX_DIRECT_UPLOAD_BYTES;
  const maxMirror = status?.maxMirrorBytes || MAX_MIRROR_BYTES;

  const isHostedInRepo = isGitHubMediaUrl(currentUrl);
  const hasExternalUrl = isExternalHttpUrl(currentUrl) && !isHostedInRepo;
  const rawEmbedded = embeddedDataUrl || (currentUrl?.startsWith('data:') ? currentUrl : undefined);
  const hasEmbeddedData = Boolean(rawEmbedded && rawEmbedded.startsWith('data:'));

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setErrorMsg(null);
    setSuccessMsg(null);

    if (file.size > maxUpload) {
      setErrorMsg(
        `El archivo "${file.name}" pesa ${formatBytes(file.size)} y supera el límite de subida directa (${formatBytes(maxUpload)}).`
      );
      return;
    }

    const currentStatus = status || (await getMediaServiceStatus(true));
    setStatus(currentStatus);

    if (!currentStatus.configured) {
      if (onFallbackLocalFile && file.size <= 700 * 1024) {
        onFallbackLocalFile(file);
        setSuccessMsg('Guardado localmente (el token de GitHub aún no está configurado en el servidor).');
        return;
      }
      setErrorMsg(
        'La subida directa al repositorio GitHub aún no está configurada en el servidor (falta GITHUB_MEDIA_TOKEN).'
      );
      return;
    }

    if (!isRegisteredAuthorSession()) {
      setErrorMsg(
        'Solo los autores registrados pueden subir archivos al repositorio. Inicia sesión con Google o correo electrónico.'
      );
      return;
    }

    setBusyAction('upload');
    try {
      const result = await uploadMediaFileToGitHub({
        file,
        kind,
        projectSlug: folderSlug,
      });
      onHostedUrl(result.immediateUrl, result.path);
      setSuccessMsg(
        result.alreadyExists
          ? `Archivo ya existente reutilizado en ${result.path}`
          : `Subido a ${result.path} (${formatBytes(result.sizeBytes)})`
      );
    } catch (err: any) {
      setErrorMsg(err?.message || 'No se pudo subir el archivo al repositorio.');
    } finally {
      setBusyAction(null);
    }
  };

  const handleMirrorExternalUrl = async () => {
    if (!currentUrl || !hasExternalUrl) return;
    setErrorMsg(null);
    setSuccessMsg(null);

    const currentStatus = status || (await getMediaServiceStatus(true));
    setStatus(currentStatus);

    if (!currentStatus.configured) {
      setErrorMsg('El servidor aún no tiene configurado GITHUB_MEDIA_TOKEN para copiar archivos al repositorio.');
      return;
    }
    if (!isRegisteredAuthorSession()) {
      setErrorMsg('Solo los autores registrados pueden copiar archivos al repositorio.');
      return;
    }

    setBusyAction('mirror');
    try {
      const result = await mirrorMediaUrlToGitHub({
        sourceUrl: currentUrl.trim(),
        kind,
        projectSlug: folderSlug,
        preferredName,
      });
      onHostedUrl(result.immediateUrl, result.path);
      setSuccessMsg(
        result.alreadyExists
          ? `Ya existía en el repositorio (${result.path}). Enlace actualizado.`
          : `Copiado al repositorio (${result.path}, ${formatBytes(result.sizeBytes)}).`
      );
    } catch (err: any) {
      setErrorMsg(err?.message || 'No se pudo copiar la URL externa al repositorio.');
    } finally {
      setBusyAction(null);
    }
  };

  const handleMigrateEmbedded = async () => {
    if (!rawEmbedded) return;
    setErrorMsg(null);
    setSuccessMsg(null);

    const currentStatus = status || (await getMediaServiceStatus(true));
    setStatus(currentStatus);

    if (!currentStatus.configured) {
      setErrorMsg('El servidor aún no tiene configurado GITHUB_MEDIA_TOKEN para migrar archivos incrustados.');
      return;
    }
    if (!isRegisteredAuthorSession()) {
      setErrorMsg('Solo los autores registrados pueden subir archivos al repositorio.');
      return;
    }

    setBusyAction('migrate');
    try {
      const result = await uploadBase64MediaToGitHub({
        dataUrl: rawEmbedded,
        kind,
        projectSlug: folderSlug,
        preferredName,
      });
      onHostedUrl(result.immediateUrl, result.path);
      setSuccessMsg(`Recurso incrustado migrado a ${result.path} (${formatBytes(result.sizeBytes)}).`);
    } catch (err: any) {
      setErrorMsg(err?.message || 'No se pudo migrar el recurso incrustado.');
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="space-y-1.5 text-[11px]">
      <div className="flex flex-wrap items-center gap-2">
        {showUploadButton && (
          <label
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-semibold transition-colors ${
              busyAction
                ? 'opacity-60 pointer-events-none'
                : 'cursor-pointer'
            } ${
              isClean
                ? 'bg-[#FFFDF6] hover:bg-[#EBE3CD] border-[#D8CCA4] text-[#2A2118]'
                : 'bg-slate-900 hover:bg-slate-800 border-white/10 text-slate-200'
            }`}
          >
            {busyAction === 'upload' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400" />
            ) : (
              <Upload className="w-3.5 h-3.5 text-amber-400" />
            )}
            <span>{busyAction === 'upload' ? 'Subiendo...' : uploadLabel}</span>
            <input
              type="file"
              accept={accept}
              onChange={handleFileChange}
              disabled={busyAction !== null}
              className="hidden"
            />
          </label>
        )}

        {hasExternalUrl && (
          <button
            type="button"
            onClick={handleMirrorExternalUrl}
            disabled={busyAction !== null}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold bg-sky-600/90 hover:bg-sky-500 disabled:opacity-60 text-white transition-colors cursor-pointer"
            title={`Descarga el archivo externo y lo aloja en ${kind}/${folderSlug}/`}
          >
            {busyAction === 'mirror' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Cloud className="w-3.5 h-3.5" />
            )}
            <span>{busyAction === 'mirror' ? 'Copiando al Repo...' : 'Copiar URL al Repo'}</span>
          </button>
        )}

        {hasEmbeddedData && (
          <button
            type="button"
            onClick={handleMigrateEmbedded}
            disabled={busyAction !== null}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold bg-emerald-600/90 hover:bg-emerald-500 disabled:opacity-60 text-white transition-colors cursor-pointer"
            title="Extrae el archivo Base64 incrustado y lo sube al repositorio GitHub"
          >
            {busyAction === 'migrate' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <FolderGit2 className="w-3.5 h-3.5" />
            )}
            <span>{busyAction === 'migrate' ? 'Migrando...' : 'Subir incrustado al Repo'}</span>
          </button>
        )}

        {isHostedInRepo && (
          <span
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-bold border ${
              isClean
                ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                : 'bg-emerald-950/50 border-emerald-500/30 text-emerald-300'
            }`}
            title="Durante la edición usa CDN instantáneo (jsDelivr). Al publicar la historia se convierte automáticamente a lvdlm.github.io."
          >
            <CheckCircle2 className="w-3 h-3 shrink-0" />
            <span>Alojado en Urdimbre_medios · al publicar usará GitHub Pages</span>
          </span>
        )}
      </div>

      {/* Size & permission policy info */}
      <p className={`text-[10px] leading-snug ${isClean ? 'text-[#6B5C46]' : 'text-slate-400'}`}>
        Carpeta destino: <code className={isClean ? 'text-[#872820] font-semibold' : 'text-amber-300'}>{kind}/{folderSlug}/</code>
        {' · '}Límites: <strong>{formatBytes(maxUpload)}</strong> subida directa,{' '}
        <strong>{formatBytes(maxMirror)}</strong> copiar URL
        {!registered && ' · Requiere cuenta de autor registrada'}
        {status && !status.configured && ' · (Pendiente GITHUB_MEDIA_TOKEN en servidor)'}
      </p>

      {successMsg && (
        <div
          className={`flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1.5 rounded-lg border ${
            isClean
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-emerald-950/40 border-emerald-500/30 text-emerald-300'
          }`}
        >
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
          <span>{successMsg}</span>
        </div>
      )}

      {errorMsg && (
        <div
          className={`flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1.5 rounded-lg border ${
            isClean
              ? 'bg-rose-50 border-rose-200 text-rose-800'
              : 'bg-rose-950/50 border-rose-500/30 text-rose-300'
          }`}
        >
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}
    </div>
  );
};
