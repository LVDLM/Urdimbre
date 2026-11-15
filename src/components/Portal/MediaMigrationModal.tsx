import React, { useEffect, useRef, useState } from 'react';
import {
  Cloud,
  X,
  Search,
  CheckCircle2,
  AlertCircle,
  Loader2,
  FolderGit2,
  Image as ImageIcon,
  Volume2,
  Play,
  Square,
} from 'lucide-react';
import {
  CloudProjectDoc,
  DialogueBlock,
  DialogueOption,
  GameProject,
  SoundDefinition,
  UserProfile,
} from '../../types';
import {
  fetchGlobalSoundLibraryFromFirestore,
  saveGlobalSoundLibraryToFirestore,
  updateProjectMediaInCloud,
} from '../../lib/firebase';
import {
  formatBytes,
  getProjectMediaFolderSlug,
  isExternalHttpUrl,
  isGitHubMediaUrl,
} from '../../utils/mediaLinks';
import {
  getMediaServiceStatus,
  MediaKind,
  MediaServiceStatus,
  mirrorMediaUrlToGitHub,
  uploadBase64MediaToGitHub,
  UploadedMediaResponse,
} from '../../utils/mediaUploader';

interface MediaMigrationModalProps {
  isOpen: boolean;
  onClose: () => void;
  projects: CloudProjectDoc[];
  currentUser: UserProfile | null;
  isClean?: boolean;
  onMigrationComplete: () => void;
}

interface ScannedAssetItem {
  key: string; // `${kind}::${projectSlug}::${rawSource}`
  kind: MediaKind;
  sourceType: 'url' | 'base64';
  rawSource: string;
  previewLabel: string;
  projectSlug: string;
  projectTitle: string;
  targetDocIds: string[]; // 'GLOBAL_SOUNDS' or project doc IDs
  occurrences: number;
  selected: boolean;
  status: 'pending' | 'migrating' | 'done' | 'error';
  resultPath?: string;
  errorMsg?: string;
}

function makeAssetKey(kind: MediaKind, projectSlug: string, rawSource: string): string {
  return `${kind}::${projectSlug}::${rawSource}`;
}

function shouldMigrateValue(val: unknown, includeEmbedded: boolean): val is string {
  if (typeof val !== 'string') return false;
  const trimmed = val.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('data:')) {
    return includeEmbedded;
  }
  if (isExternalHttpUrl(trimmed) && !isGitHubMediaUrl(trimmed)) {
    return true;
  }
  return false;
}

export const MediaMigrationModal: React.FC<MediaMigrationModalProps> = ({
  isOpen,
  onClose,
  projects,
  currentUser,
  isClean = false,
  onMigrationComplete,
}) => {
  const [status, setStatus] = useState<MediaServiceStatus | null>(null);
  const [scopeProjectId, setScopeProjectId] = useState<string>('ALL');
  const [includeEmbedded, setIncludeEmbedded] = useState<boolean>(true);
  const [includeGlobalSounds, setIncludeGlobalSounds] = useState<boolean>(true);

  const [isScanning, setIsScanning] = useState(false);
  const [hasScanned, setHasScanned] = useState(false);
  const [items, setItems] = useState<ScannedAssetItem[]>([]);
  const [globalSoundsSnapshot, setGlobalSoundsSnapshot] = useState<SoundDefinition[]>([]);

  const [isMigrating, setIsMigrating] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [summaryMsg, setSummaryMsg] = useState<{ tone: 'success' | 'warning' | 'error'; text: string } | null>(null);
  const cancelRef = useRef(false);

  useEffect(() => {
    if (!isOpen) return;
    getMediaServiceStatus(true)
      .then(setStatus)
      .catch(() => {});
  }, [isOpen]);

  if (!isOpen) return null;

  const registerFinding = (
    map: Map<string, ScannedAssetItem>,
    params: {
      kind: MediaKind;
      rawSource: string;
      previewLabel: string;
      projectSlug: string;
      projectTitle: string;
      docId: string;
    }
  ) => {
    const trimmed = params.rawSource.trim();
    const key = makeAssetKey(params.kind, params.projectSlug, trimmed);
    const existing = map.get(key);
    if (existing) {
      existing.occurrences += 1;
      if (!existing.targetDocIds.includes(params.docId)) {
        existing.targetDocIds.push(params.docId);
      }
      return;
    }
    const isBase64 = trimmed.startsWith('data:');
    map.set(key, {
      key,
      kind: params.kind,
      sourceType: isBase64 ? 'base64' : 'url',
      rawSource: trimmed,
      previewLabel: params.previewLabel,
      projectSlug: params.projectSlug,
      projectTitle: params.projectTitle,
      targetDocIds: [params.docId],
      occurrences: 1,
      selected: true,
      status: 'pending',
    });
  };

  const scanDialogue = (
    dlg: DialogueBlock | undefined,
    map: Map<string, ScannedAssetItem>,
    projectSlug: string,
    projectTitle: string,
    docId: string,
    contextLabel: string
  ) => {
    if (!dlg) return;
    const inspectOpt = (opt: DialogueOption) => {
      if (shouldMigrateValue(opt.soundEffect, includeEmbedded)) {
        registerFinding(map, {
          kind: 'sounds',
          rawSource: opt.soundEffect,
          previewLabel: `Audio diálogo (${contextLabel})`,
          projectSlug,
          projectTitle,
          docId,
        });
      }
    };
    (dlg.options || []).forEach(inspectOpt);
    (dlg.nodes || []).forEach((n) => (n.options || []).forEach(inspectOpt));
  };

  const scanProjectSnapshot = (
    projData: GameProject | undefined,
    map: Map<string, ScannedAssetItem>,
    projectSlug: string,
    projectTitle: string,
    docId: string
  ) => {
    if (!projData) return;

    (projData.customSounds || []).forEach((s) => {
      if (shouldMigrateValue(s.url, includeEmbedded)) {
        registerFinding(map, {
          kind: 'sounds',
          rawSource: s.url,
          previewLabel: `Sonido: ${s.name || s.id}`,
          projectSlug,
          projectTitle,
          docId,
        });
      }
    });

    (projData.inventoryItems || []).forEach((item) => {
      if (shouldMigrateValue(item.imageUrl, includeEmbedded)) {
        registerFinding(map, {
          kind: 'img',
          rawSource: item.imageUrl,
          previewLabel: `Objeto: ${item.name || item.id}`,
          projectSlug,
          projectTitle,
          docId,
        });
      }
      if (includeEmbedded && shouldMigrateValue(item.imageFileData, true)) {
        registerFinding(map, {
          kind: 'img',
          rawSource: item.imageFileData,
          previewLabel: `Objeto (incrustado): ${item.name || item.id}`,
          projectSlug,
          projectTitle,
          docId,
        });
      }
    });

    (projData.characters || []).forEach((ch) => {
      if (shouldMigrateValue(ch.imageUrl, includeEmbedded)) {
        registerFinding(map, {
          kind: 'img',
          rawSource: ch.imageUrl,
          previewLabel: `Personaje: ${ch.name || ch.id}`,
          projectSlug,
          projectTitle,
          docId,
        });
      }
      if (includeEmbedded && shouldMigrateValue(ch.imageFileData, true)) {
        registerFinding(map, {
          kind: 'img',
          rawSource: ch.imageFileData,
          previewLabel: `Personaje (incrustado): ${ch.name || ch.id}`,
          projectSlug,
          projectTitle,
          docId,
        });
      }
    });

    (projData.scenes || []).forEach((sc) => {
      if (shouldMigrateValue(sc.sfx, includeEmbedded)) {
        registerFinding(map, {
          kind: 'sounds',
          rawSource: sc.sfx,
          previewLabel: `Audio escena: ${sc.name || sc.id}`,
          projectSlug,
          projectTitle,
          docId,
        });
      }
      (sc.textBlocks || []).forEach((b, idx) => {
        if (shouldMigrateValue(b.imageUrl, includeEmbedded)) {
          registerFinding(map, {
            kind: 'img',
            rawSource: b.imageUrl,
            previewLabel: `${sc.name || 'Escena'} · Párrafo ${idx + 1}`,
            projectSlug,
            projectTitle,
            docId,
          });
        }
        if (includeEmbedded && shouldMigrateValue(b.imageFileData, true)) {
          registerFinding(map, {
            kind: 'img',
            rawSource: b.imageFileData,
            previewLabel: `${sc.name || 'Escena'} · Párrafo ${idx + 1} (incrustada)`,
            projectSlug,
            projectTitle,
            docId,
          });
        }
        if (shouldMigrateValue(b.soundEffect, includeEmbedded)) {
          registerFinding(map, {
            kind: 'sounds',
            rawSource: b.soundEffect,
            previewLabel: `Audio párrafo: ${sc.name || 'Escena'} #${idx + 1}`,
            projectSlug,
            projectTitle,
            docId,
          });
        }
        scanDialogue(b.dialogue, map, projectSlug, projectTitle, docId, sc.name || sc.id);
      });
      (sc.hotspots || []).forEach((hs) => {
        (hs.actions || []).forEach((act) => {
          if (shouldMigrateValue(act.soundEffect, includeEmbedded)) {
            registerFinding(map, {
              kind: 'sounds',
              rawSource: act.soundEffect,
              previewLabel: `Audio acción "${hs.word}"`,
              projectSlug,
              projectTitle,
              docId,
            });
          }
          if (shouldMigrateValue(act.failSoundEffect, includeEmbedded)) {
            registerFinding(map, {
              kind: 'sounds',
              rawSource: act.failSoundEffect,
              previewLabel: `Audio fallo "${hs.word}"`,
              projectSlug,
              projectTitle,
              docId,
            });
          }
          scanDialogue(act.dialogue, map, projectSlug, projectTitle, docId, hs.word);
        });
      });
    });
  };

  const handleScan = async () => {
    setIsScanning(true);
    setSummaryMsg(null);
    const findings = new Map<string, ScannedAssetItem>();

    try {
      const targetProjects =
        scopeProjectId === 'ALL'
          ? projects
          : projects.filter((p) => p.id === scopeProjectId);

      for (const docItem of targetProjects) {
        const title = docItem.title || docItem.projectData?.title || docItem.id;
        const slug = getProjectMediaFolderSlug({ id: docItem.id, title });
        scanProjectSnapshot(docItem.projectData, findings, slug, title, docItem.id);
        scanProjectSnapshot(docItem.publishedData, findings, slug, title, docItem.id);
      }

      if (includeGlobalSounds && scopeProjectId === 'ALL') {
        const globals = await fetchGlobalSoundLibraryFromFirestore();
        setGlobalSoundsSnapshot(globals);
        for (const s of globals) {
          if (shouldMigrateValue(s.url, includeEmbedded)) {
            registerFinding(findings, {
              kind: 'sounds',
              rawSource: s.url,
              previewLabel: `Biblioteca Global: ${s.name || s.id}`,
              projectSlug: 'compartidos',
              projectTitle: 'Biblioteca Oficial de Sonidos',
              docId: 'GLOBAL_SOUNDS',
            });
          }
        }
      } else {
        setGlobalSoundsSnapshot([]);
      }

      setItems(Array.from(findings.values()));
      setHasScanned(true);
    } finally {
      setIsScanning(false);
    }
  };

  const applyReplacementsToSnapshot = (
    proj: GameProject,
    projectSlug: string,
    mode: 'draft' | 'published',
    uploadedMap: Map<string, UploadedMediaResponse>
  ): { updated: GameProject; changed: boolean } => {
    const copy = JSON.parse(JSON.stringify(proj)) as GameProject;
    let changed = false;

    const pickUrl = (res: UploadedMediaResponse) =>
      mode === 'published' ? res.publicationUrl : res.immediateUrl;

    const resolveReplacement = (kind: MediaKind, raw?: string): UploadedMediaResponse | null => {
      if (!raw) return null;
      const hit = uploadedMap.get(makeAssetKey(kind, projectSlug, raw.trim()));
      return hit || null;
    };

    const rewriteDialogue = (dlg?: DialogueBlock): DialogueBlock | undefined => {
      if (!dlg) return dlg;
      const mapOpt = (opt: DialogueOption): DialogueOption => {
        const hit = resolveReplacement('sounds', opt.soundEffect);
        if (!hit) return opt;
        changed = true;
        return { ...opt, soundEffect: pickUrl(hit) };
      };
      return {
        ...dlg,
        options: dlg.options ? dlg.options.map(mapOpt) : dlg.options,
        nodes: dlg.nodes
          ? dlg.nodes.map((node) => ({
              ...node,
              options: (node.options || []).map(mapOpt),
            }))
          : dlg.nodes,
      };
    };

    if (Array.isArray(copy.customSounds)) {
      copy.customSounds = copy.customSounds.map((s) => {
        const hit = resolveReplacement('sounds', s.url);
        if (!hit) return s;
        changed = true;
        return { ...s, url: pickUrl(hit) };
      });
    }

    if (Array.isArray(copy.inventoryItems)) {
      copy.inventoryItems = copy.inventoryItems.map((item) => {
        const hitData = resolveReplacement('img', item.imageFileData);
        const hitUrl = resolveReplacement('img', item.imageUrl);
        const hit = hitData || hitUrl;
        if (!hit) return item;
        changed = true;
        return {
          ...item,
          imageUrl: pickUrl(hit),
          imageFileData: undefined,
          imageFileName: hit.path,
        };
      });
    }

    if (Array.isArray(copy.characters)) {
      copy.characters = copy.characters.map((ch) => {
        const hitData = resolveReplacement('img', ch.imageFileData);
        const hitUrl = resolveReplacement('img', ch.imageUrl);
        const hit = hitData || hitUrl;
        if (!hit) return ch;
        changed = true;
        return {
          ...ch,
          imageUrl: pickUrl(hit),
          imageFileData: undefined,
          imageFileName: hit.path,
        };
      });
    }

    if (Array.isArray(copy.scenes)) {
      copy.scenes = copy.scenes.map((sc) => {
        let nextSfx = sc.sfx;
        const sfxHit = resolveReplacement('sounds', sc.sfx);
        if (sfxHit) {
          changed = true;
          nextSfx = pickUrl(sfxHit);
        }

        const nextBlocks = (sc.textBlocks || []).map((b) => {
          const hitImg =
            resolveReplacement('img', b.imageFileData) ||
            resolveReplacement('img', b.imageUrl);
          const hitSound = resolveReplacement('sounds', b.soundEffect);
          const nextDlg = rewriteDialogue(b.dialogue);
          if (!hitImg && !hitSound && nextDlg === b.dialogue) return b;
          if (hitImg || hitSound) changed = true;
          return {
            ...b,
            imageUrl: hitImg ? pickUrl(hitImg) : b.imageUrl,
            imageFileData: hitImg ? undefined : b.imageFileData,
            imageFileName: hitImg ? hitImg.path : b.imageFileName,
            soundEffect: hitSound ? pickUrl(hitSound) : b.soundEffect,
            dialogue: nextDlg,
          };
        });

        const nextHotspots = (sc.hotspots || []).map((hs) => ({
          ...hs,
          actions: (hs.actions || []).map((act) => {
            const hitSfx = resolveReplacement('sounds', act.soundEffect);
            const hitFailSfx = resolveReplacement('sounds', act.failSoundEffect);
            const nextDlg = rewriteDialogue(act.dialogue);
            if (!hitSfx && !hitFailSfx && nextDlg === act.dialogue) return act;
            if (hitSfx || hitFailSfx) changed = true;
            return {
              ...act,
              soundEffect: hitSfx ? pickUrl(hitSfx) : act.soundEffect,
              failSoundEffect: hitFailSfx ? pickUrl(hitFailSfx) : act.failSoundEffect,
              dialogue: nextDlg,
            };
          }),
        }));

        return {
          ...sc,
          sfx: nextSfx,
          textBlocks: nextBlocks,
          hotspots: nextHotspots,
        };
      });
    }

    return { updated: copy, changed };
  };

  const handleRunMigration = async () => {
    const selectedItems = items.filter((i) => i.selected && i.status !== 'done');
    if (selectedItems.length === 0) return;

    cancelRef.current = false;
    setIsMigrating(true);
    setSummaryMsg(null);
    setProgress({ current: 0, total: selectedItems.length });

    const uploadedMap = new Map<string, UploadedMediaResponse>();
    let okCount = 0;
    let errCount = 0;

    for (let idx = 0; idx < selectedItems.length; idx++) {
      if (cancelRef.current) break;
      const item = selectedItems[idx];
      setProgress({ current: idx + 1, total: selectedItems.length });

      setItems((prev) =>
        prev.map((p) => (p.key === item.key ? { ...p, status: 'migrating', errorMsg: undefined } : p))
      );

      try {
        let res: UploadedMediaResponse;
        if (item.sourceType === 'base64') {
          res = await uploadBase64MediaToGitHub({
            dataUrl: item.rawSource,
            kind: item.kind,
            projectSlug: item.projectSlug,
            preferredName: item.previewLabel,
          });
        } else {
          res = await mirrorMediaUrlToGitHub({
            sourceUrl: item.rawSource,
            kind: item.kind,
            projectSlug: item.projectSlug,
            preferredName: item.previewLabel,
          });
        }
        uploadedMap.set(item.key, res);
        okCount += 1;
        setItems((prev) =>
          prev.map((p) =>
            p.key === item.key ? { ...p, status: 'done', resultPath: res.path } : p
          )
        );
      } catch (err: any) {
        errCount += 1;
        setItems((prev) =>
          prev.map((p) =>
            p.key === item.key
              ? { ...p, status: 'error', errorMsg: err?.message || 'Error al migrar recurso' }
              : p
          )
        );
      }
    }

    let updatedDocsCount = 0;

    if (uploadedMap.size > 0) {
      // 1. Update projects in Firestore
      const affectedProjectIds = new Set<string>();
      for (const item of selectedItems) {
        if (!uploadedMap.has(item.key)) continue;
        item.targetDocIds.forEach((id) => {
          if (id !== 'GLOBAL_SOUNDS') affectedProjectIds.add(id);
        });
      }

      for (const docId of affectedProjectIds) {
        const projDoc = projects.find((p) => p.id === docId);
        if (!projDoc) continue;
        const title = projDoc.title || projDoc.projectData?.title || projDoc.id;
        const slug = getProjectMediaFolderSlug({ id: projDoc.id, title });

        const draftResult = projDoc.projectData
          ? applyReplacementsToSnapshot(projDoc.projectData, slug, 'draft', uploadedMap)
          : { updated: undefined, changed: false };
        const pubResult = projDoc.publishedData
          ? applyReplacementsToSnapshot(projDoc.publishedData, slug, 'published', uploadedMap)
          : { updated: undefined, changed: false };

        if (draftResult.changed || pubResult.changed) {
          await updateProjectMediaInCloud(projDoc.id, {
            projectData: draftResult.changed ? draftResult.updated : undefined,
            publishedData: pubResult.changed ? pubResult.updated : undefined,
          });
          updatedDocsCount += 1;
        }
      }

      // 2. Update global sounds if affected
      const hasGlobalChange = selectedItems.some(
        (i) => i.targetDocIds.includes('GLOBAL_SOUNDS') && uploadedMap.has(i.key)
      );
      if (hasGlobalChange && globalSoundsSnapshot.length > 0) {
        let globalChanged = false;
        const nextGlobals = globalSoundsSnapshot.map((s) => {
          if (!s.url) return s;
          const hit = uploadedMap.get(makeAssetKey('sounds', 'compartidos', s.url.trim()));
          if (!hit) return s;
          globalChanged = true;
          return { ...s, url: hit.immediateUrl };
        });
        if (globalChanged) {
          await saveGlobalSoundLibraryToFirestore(
            nextGlobals,
            currentUser?.email || 'admin'
          );
          setGlobalSoundsSnapshot(nextGlobals);
          updatedDocsCount += 1;
        }
      }

      onMigrationComplete();
    }

    setIsMigrating(false);
    const tone: 'success' | 'warning' | 'error' =
      errCount === 0 && okCount > 0 ? 'success' : okCount > 0 && errCount > 0 ? 'warning' : 'error';
    setSummaryMsg({
      tone,
      text: `${cancelRef.current ? 'Proceso detenido. ' : ''}Migrados: ${okCount} · Con error (enlace original conservado): ${errCount} · Documentos actualizados en Firestore: ${updatedDocsCount}.`,
    });
  };

  const selectedCount = items.filter((i) => i.selected && i.status !== 'done').length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs">
      <div
        className={`w-full max-w-4xl max-h-[90vh] flex flex-col rounded-3xl border shadow-2xl overflow-hidden ${
          isClean
            ? 'bg-white border-slate-200 text-slate-900'
            : 'bg-slate-900 border-white/10 text-slate-100'
        }`}
      >
        {/* Header */}
        <div
          className={`px-6 py-4 border-b flex items-center justify-between gap-4 ${
            isClean ? 'bg-slate-50 border-slate-200' : 'bg-slate-950/60 border-white/10'
          }`}
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-sky-500/20 border border-sky-500/30 flex items-center justify-center text-sky-400">
              <FolderGit2 className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-extrabold text-base sm:text-lg">
                Escáner y Migración de Medios a GitHub
              </h2>
              <p className={`text-xs ${isClean ? 'text-slate-500' : 'text-slate-400'}`}>
                Sube archivos externos e imágenes/audios Base64 incrustados al repositorio{' '}
                <code>LVDLM/Urdimbre_medios</code> y actualiza borradores (jsDelivr) y publicaciones (lvdlm.github.io).
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isMigrating}
            className="p-2 rounded-xl hover:bg-slate-500/10 disabled:opacity-40 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {status && !status.configured && (
            <div className="p-4 rounded-2xl border border-amber-500/40 bg-amber-500/10 text-xs text-amber-300 flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
              <div className="space-y-1">
                {status.diagnosticError ? (
                  <>
                    <p className="font-bold">La API de medios (/api/media/status) no está respondiendo correctamente</p>
                    <p>{status.diagnosticError}</p>
                  </>
                ) : (
                  <>
                    <p className="font-bold">Falta configurar el secreto GITHUB_MEDIA_TOKEN en el servidor</p>
                    <p>
                      El servidor respondió correctamente, pero <code>process.env.GITHUB_MEDIA_TOKEN</code> está vacío en este entorno. En Vercel, verifica que la variable esté marcada para <strong>Production</strong> (y Preview) y haz un <strong>Redeploy</strong>.
                    </p>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Scan Options */}
          <div
            className={`p-4 rounded-2xl border space-y-4 ${
              isClean ? 'bg-slate-50 border-slate-200' : 'bg-slate-950/60 border-white/10'
            }`}
          >
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold mb-1.5">Alcance del escaneo:</label>
                <select
                  value={scopeProjectId}
                  onChange={(e) => setScopeProjectId(e.target.value)}
                  disabled={isScanning || isMigrating}
                  className={`w-full px-3 py-2 rounded-xl border text-xs font-semibold ${
                    isClean
                      ? 'bg-white border-slate-300 text-slate-900'
                      : 'bg-slate-900 border-white/10 text-slate-200'
                  }`}
                >
                  <option value="ALL">Todas las historias ({projects.length})</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title || p.projectData?.title || p.id} ({p.status})
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col justify-center space-y-2 text-xs">
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeEmbedded}
                    onChange={(e) => setIncludeEmbedded(e.target.checked)}
                    disabled={isScanning || isMigrating}
                    className="rounded accent-sky-500"
                  />
                  <span>Extraer imágenes y audios incrustados en Base64 (aligera Firestore)</span>
                </label>

                {scopeProjectId === 'ALL' && (
                  <label className="inline-flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={includeGlobalSounds}
                      onChange={(e) => setIncludeGlobalSounds(e.target.checked)}
                      disabled={isScanning || isMigrating}
                      className="rounded accent-sky-500"
                    />
                    <span>Incluir Biblioteca Oficial de Sonidos (carpeta sounds/compartidos/)</span>
                  </label>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-white/10">
              <p className={`text-[11px] ${isClean ? 'text-slate-500' : 'text-slate-400'}`}>
                Límites aplicados: <strong>{formatBytes(status?.maxUploadBytes || 3 * 1024 * 1024)}</strong> para archivos incrustados ·{' '}
                <strong>{formatBytes(status?.maxMirrorBytes || 5 * 1024 * 1024)}</strong> para URLs externas.
              </p>
              <button
                type="button"
                onClick={handleScan}
                disabled={isScanning || isMigrating}
                className="px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white text-xs font-bold flex items-center gap-2 cursor-pointer"
              >
                {isScanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                <span>{isScanning ? 'Escaneando...' : 'Escanear Medios Pendientes'}</span>
              </button>
            </div>
          </div>

          {/* Summary banner */}
          {summaryMsg && (
            <div
              className={`p-3.5 rounded-2xl border text-xs font-semibold flex items-center gap-2 ${
                summaryMsg.tone === 'success'
                  ? isClean
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                    : 'bg-emerald-950/40 border-emerald-500/30 text-emerald-300'
                  : summaryMsg.tone === 'warning'
                  ? isClean
                    ? 'bg-amber-50 border-amber-200 text-amber-900'
                    : 'bg-amber-950/40 border-amber-500/30 text-amber-300'
                  : isClean
                  ? 'bg-rose-50 border-rose-200 text-rose-800'
                  : 'bg-rose-950/40 border-rose-500/30 text-rose-300'
              }`}
            >
              {summaryMsg.tone === 'success' ? (
                <CheckCircle2 className="w-4 h-4 shrink-0" />
              ) : (
                <AlertCircle className="w-4 h-4 shrink-0" />
              )}
              <span>{summaryMsg.text}</span>
            </div>
          )}

          {/* Scan Results */}
          {hasScanned && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-xs font-bold uppercase tracking-wider opacity-80">
                  Recursos detectados fuera de Urdimbre_medios ({items.length})
                </h3>
                {items.length > 0 && !isMigrating && (
                  <div className="flex items-center gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() => setItems((prev) => prev.map((i) => ({ ...i, selected: true })))}
                      className="text-sky-400 hover:underline cursor-pointer"
                    >
                      Marcar todos
                    </button>
                    <span className="opacity-40">·</span>
                    <button
                      type="button"
                      onClick={() => setItems((prev) => prev.map((i) => ({ ...i, selected: false })))}
                      className="text-slate-400 hover:underline cursor-pointer"
                    >
                      Desmarcar todos
                    </button>
                  </div>
                )}
              </div>

              {items.length === 0 ? (
                <div
                  className={`p-8 text-center rounded-2xl border text-xs ${
                    isClean ? 'bg-slate-50 border-slate-200 text-slate-600' : 'bg-slate-950/40 border-white/10 text-slate-400'
                  }`}
                >
                  <CheckCircle2 className="w-8 h-8 mx-auto mb-2 text-emerald-500" />
                  No se encontraron imágenes ni sonidos pendientes de migrar en el alcance seleccionado.
                </div>
              ) : (
                <div className="space-y-2 max-h-[340px] overflow-y-auto pr-1">
                  {items.map((item) => (
                    <div
                      key={item.key}
                      className={`p-3 rounded-xl border text-xs flex items-start gap-3 ${
                        isClean
                          ? 'bg-white border-slate-200'
                          : 'bg-slate-950/60 border-white/10'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={item.selected}
                        disabled={isMigrating || item.status === 'done'}
                        onChange={(e) =>
                          setItems((prev) =>
                            prev.map((p) =>
                              p.key === item.key ? { ...p, selected: e.target.checked } : p
                            )
                          )
                        }
                        className="mt-1 rounded accent-sky-500 cursor-pointer"
                      />
                      <div className="shrink-0 mt-0.5">
                        {item.kind === 'img' ? (
                          <ImageIcon className="w-4 h-4 text-amber-400" />
                        ) : (
                          <Volume2 className="w-4 h-4 text-sky-400" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-bold truncate">{item.projectTitle}</span>
                          <span className="px-1.5 py-0.5 rounded bg-slate-500/20 text-[10px] font-mono">
                            {item.kind}/{item.projectSlug}/
                          </span>
                          <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[10px] font-semibold">
                            {item.sourceType === 'base64' ? 'Base64 incrustado' : 'URL externa'} · {item.occurrences} uso{item.occurrences > 1 ? 's' : ''}
                          </span>
                        </div>
                        <p className={`text-[11px] ${isClean ? 'text-slate-600' : 'text-slate-300'}`}>
                          {item.previewLabel}
                        </p>
                        <p className="text-[10px] font-mono opacity-60 truncate">
                          {item.sourceType === 'base64'
                            ? `${item.rawSource.slice(0, 64)}... (${formatBytes(Math.ceil((item.rawSource.length * 3) / 4))})`
                            : item.rawSource}
                        </p>
                        {item.status === 'done' && (
                          <p className="text-[11px] text-emerald-400 font-semibold">
                            ✓ Migrado a {item.resultPath}
                          </p>
                        )}
                        {item.status === 'error' && (
                          <p className="text-[11px] text-rose-400 font-semibold">
                            ✕ {item.errorMsg}
                          </p>
                        )}
                      </div>
                      <div className="shrink-0">
                        {item.status === 'migrating' && (
                          <Loader2 className="w-4 h-4 animate-spin text-sky-400" />
                        )}
                        {item.status === 'done' && (
                          <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                        )}
                        {item.status === 'error' && (
                          <AlertCircle className="w-4 h-4 text-rose-500" />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className={`px-6 py-4 border-t flex flex-wrap items-center justify-between gap-3 ${
            isClean ? 'bg-slate-50 border-slate-200' : 'bg-slate-950/60 border-white/10'
          }`}
        >
          <div className="text-xs opacity-80">
            {isMigrating
              ? `Migrando recurso ${progress.current} de ${progress.total}...`
              : hasScanned
              ? `${selectedCount} recurso${selectedCount === 1 ? '' : 's'} seleccionado${selectedCount === 1 ? '' : 's'} para migrar`
              : 'Pulsa "Escanear Medios Pendientes" para comenzar.'}
          </div>

          <div className="flex items-center gap-2">
            {isMigrating ? (
              <button
                type="button"
                onClick={() => {
                  cancelRef.current = true;
                }}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer"
              >
                <Square className="w-3.5 h-3.5 fill-white" />
                <span>Detener Migración</span>
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={onClose}
                  className={`px-4 py-2 rounded-xl text-xs font-bold border cursor-pointer ${
                    isClean
                      ? 'border-slate-300 text-slate-700 hover:bg-slate-100'
                      : 'border-white/10 text-slate-300 hover:bg-white/10'
                  }`}
                >
                  Cerrar
                </button>
                <button
                  type="button"
                  onClick={handleRunMigration}
                  disabled={!hasScanned || selectedCount === 0 || (status !== null && !status.configured)}
                  className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer shadow"
                >
                  <Cloud className="w-4 h-4" />
                  <Play className="w-3 h-3 fill-white" />
                  <span>Migrar Seleccionados ({selectedCount})</span>
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
