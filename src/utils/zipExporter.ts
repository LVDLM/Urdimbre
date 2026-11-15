import JSZip from 'jszip';
import { DialogueBlock, DialogueOption, GameProject, SoundDefinition } from '../types';
import { generateStandaloneHTML } from './htmlExporter';

export interface ExportResult {
  isZip: boolean;
  blob: Blob;
  filename: string;
}

function isPackableUrlOrData(value?: string): boolean {
  if (!value) return false;
  return /^https?:\/\//i.test(value) || value.startsWith('data:');
}

/**
 * Checks if the project has any images attached (inventory items, scene blocks, or characters)
 */
export function projectHasImages(project: GameProject): boolean {
  for (const item of project.inventoryItems || []) {
    if (item.imageFileData || item.imageUrl) return true;
  }
  for (const ch of project.characters || []) {
    if (ch.imageFileData || ch.imageUrl) return true;
  }
  for (const scene of project.scenes || []) {
    for (const block of scene.textBlocks || []) {
      if (block.imageFileData || block.imageUrl) return true;
    }
  }
  return false;
}

/**
 * Sonidos del proyecto que son archivos de audio (por URL o subidos) y se pueden empaquetar
 */
function isPackableSound(sound: SoundDefinition): boolean {
  if (sound.sourceType !== 'url' || !sound.url) return false;
  return /^https?:\/\//i.test(sound.url) || sound.url.startsWith('data:audio/');
}

function hasDirectAudioUrl(val?: string): boolean {
  if (!val) return false;
  return /^https?:\/\//i.test(val) || val.startsWith('data:audio/');
}

/**
 * Checks if the project has audio files (added by URL or uploaded) that go into the sounds/ folder
 */
export function projectHasSounds(project: GameProject): boolean {
  if ((project.customSounds || []).some(isPackableSound)) return true;
  for (const sc of project.scenes || []) {
    if (hasDirectAudioUrl(sc.sfx)) return true;
    for (const b of sc.textBlocks || []) {
      if (hasDirectAudioUrl(b.soundEffect)) return true;
      if ((b.dialogue?.options || []).some((o) => hasDirectAudioUrl(o.soundEffect))) return true;
      if ((b.dialogue?.nodes || []).some((n) => (n.options || []).some((o) => hasDirectAudioUrl(o.soundEffect)))) {
        return true;
      }
    }
    for (const hs of sc.hotspots || []) {
      for (const act of hs.actions || []) {
        if (hasDirectAudioUrl(act.soundEffect) || hasDirectAudioUrl(act.failSoundEffect)) return true;
        if ((act.dialogue?.options || []).some((o) => hasDirectAudioUrl(o.soundEffect))) return true;
        if ((act.dialogue?.nodes || []).some((n) => (n.options || []).some((o) => hasDirectAudioUrl(o.soundEffect)))) {
          return true;
        }
      }
    }
  }
  return false;
}

const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
};

const AUDIO_MIME_EXTENSIONS: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/ogg': '.ogg',
  'application/ogg': '.ogg',
  'audio/webm': '.webm',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/flac': '.flac',
};

function getAudioExtension(src: string, mime?: string): string {
  if (src.startsWith('data:')) {
    const end = src.indexOf(';') > 0 ? src.indexOf(';') : src.indexOf(',');
    return AUDIO_MIME_EXTENSIONS[src.slice(5, end).toLowerCase()] || '.mp3';
  }
  const match = src.split(/[?#]/)[0].match(/\.(mp3|wav|ogg|oga|m4a|aac|flac|webm|opus)$/i);
  if (match) return `.${match[1].toLowerCase()}`;
  return AUDIO_MIME_EXTENSIONS[(mime || '').split(';')[0].trim().toLowerCase()] || '.mp3';
}

function getImageExtension(src: string, mime?: string): string {
  if (src.startsWith('data:')) {
    const end = src.indexOf(';') > 0 ? src.indexOf(';') : src.indexOf(',');
    return IMAGE_MIME_EXTENSIONS[src.slice(5, end).toLowerCase()] || '.png';
  }
  const match = src.split(/[?#]/)[0].match(/\.(png|jpg|jpeg|gif|webp|svg)$/i);
  if (match) return `.${match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase()}`;
  return IMAGE_MIME_EXTENSIONS[(mime || '').split(';')[0].trim().toLowerCase()] || '.png';
}

function safeAssetName(name: string, fallback: string): string {
  const clean = (name || fallback)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return clean || fallback;
}

function getCleanBaseNameFromUrlOrHint(src: string, hint?: string, fallback = 'recurso'): string {
  if (!src.startsWith('data:')) {
    try {
      const urlPath = new URL(src).pathname;
      const rawLast = decodeURIComponent(urlPath.split('/').pop() || '');
      const noExt = rawLast.replace(/\.[^.]+$/, '');
      if (noExt) return safeAssetName(noExt, fallback);
    } catch {}
  }
  if (hint) {
    const rawLast = hint.split('/').pop() || hint;
    const noExt = rawLast.replace(/\.[^.]+$/, '');
    if (noExt) return safeAssetName(noExt, fallback);
  }
  return safeAssetName(fallback, fallback);
}

/**
 * Packs both Base64 and remote HTTP(S) images into the ZIP's img/ folder.
 */
async function packImages(zip: JSZip, project: GameProject): Promise<string[]> {
  const failed: string[] = [];
  const used = new Set<string>();
  const cacheBySrc = new Map<string, string>(); // src -> fileName inside img/
  const imgFolder = zip.folder('img');
  if (!imgFolder) return failed;

  let imgCounter = 1;

  const packOneImage = async (
    src: string,
    hintName: string | undefined,
    fallbackPrefix: string,
    displayLabel: string
  ): Promise<string | null> => {
    const cached = cacheBySrc.get(src);
    if (cached) return cached;

    try {
      let data: Blob;
      let mime: string | undefined;

      if (src.startsWith('data:')) {
        data = await (await fetch(src)).blob();
        mime = data.type;
      } else if (/^https?:\/\//i.test(src)) {
        const res = await fetch(src);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.blob();
        mime = res.headers.get('content-type') || data.type;
      } else {
        return null;
      }

      const ext = getImageExtension(src, mime);
      const base = getCleanBaseNameFromUrlOrHint(src, hintName, `${fallbackPrefix}_${imgCounter++}`);
      let fileName = `${base}${ext}`;
      for (let n = 2; used.has(fileName); n++) {
        fileName = `${base}_${n}${ext}`;
      }
      used.add(fileName);

      imgFolder.file(fileName, data);
      cacheBySrc.set(src, fileName);
      return fileName;
    } catch (err) {
      console.warn(`No se pudo descargar la imagen "${displayLabel}" para el ZIP:`, err);
      failed.push(displayLabel);
      return null;
    }
  };

  for (const item of project.inventoryItems || []) {
    const src = item.imageFileData || item.imageUrl;
    if (!src || !isPackableUrlOrData(src)) continue;
    const packedName = await packOneImage(src, item.imageFileName, `item_${item.id}`, item.name || item.id);
    if (packedName) {
      item.imageFileName = packedName;
      item.imageUrl = `img/${packedName}`;
      item.imageFileData = undefined;
    } else {
      item.imageFileName = undefined;
    }
  }

  for (const ch of project.characters || []) {
    const src = ch.imageFileData || ch.imageUrl;
    if (!src || !isPackableUrlOrData(src)) continue;
    const packedName = await packOneImage(src, ch.imageFileName, `npc_${ch.id}`, ch.name || ch.id);
    if (packedName) {
      ch.imageFileName = packedName;
      ch.imageUrl = `img/${packedName}`;
      ch.imageFileData = undefined;
    } else {
      ch.imageFileName = undefined;
    }
  }

  for (const scene of project.scenes || []) {
    for (const block of scene.textBlocks || []) {
      const src = block.imageFileData || block.imageUrl;
      if (!src || !isPackableUrlOrData(src)) continue;
      const packedName = await packOneImage(
        src,
        block.imageFileName,
        `block_${block.id}`,
        `${scene.name || 'Escena'} (${block.id})`
      );
      if (packedName) {
        block.imageFileName = packedName;
        block.imageUrl = `img/${packedName}`;
        block.imageFileData = undefined;
      } else {
        block.imageFileName = undefined;
      }
    }
  }

  return failed;
}

/**
 * Copies every audio file of the project into the sounds/ folder of the ZIP and points the
 * project to the relative path. A sound that cannot be downloaded (e.g. the host blocks it)
 * keeps its original URL and is reported in the returned list.
 */
async function packSounds(zip: JSZip, project: GameProject): Promise<string[]> {
  const failed: string[] = [];
  const used = new Set<string>();
  const cacheBySrc = new Map<string, string>(); // src -> relative 'sounds/...'
  const folder = zip.folder('sounds');
  if (!folder) return failed;

  const packOneAudio = async (src: string, preferredId: string, label: string): Promise<string | null> => {
    const cached = cacheBySrc.get(src);
    if (cached) return cached;

    try {
      let data: Blob;
      let mime: string | undefined;
      if (src.startsWith('data:')) {
        data = await (await fetch(src)).blob();
        mime = data.type;
      } else {
        const response = await fetch(src);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        data = await response.blob();
        mime = response.headers.get('content-type') || data.type;
      }

      const ext = getAudioExtension(src, mime);
      const base = safeAssetName(preferredId, 'sonido');
      let fileName = `${base}${ext}`;
      for (let n = 2; used.has(fileName); n++) fileName = `${base}_${n}${ext}`;
      used.add(fileName);

      folder.file(fileName, data);
      const rel = `sounds/${fileName}`;
      cacheBySrc.set(src, rel);
      return rel;
    } catch (err) {
      console.warn(`No se pudo incluir el sonido "${label}" en el ZIP:`, err);
      failed.push(label);
      return null;
    }
  };

  for (const sound of project.customSounds || []) {
    if (!isPackableSound(sound)) continue;
    const src = sound.url as string;
    const rel = await packOneAudio(src, sound.id, sound.name || sound.id);
    if (rel) {
      sound.url = rel;
    }
  }

  const packDialogueAudio = async (dlg?: DialogueBlock) => {
    if (!dlg) return;
    const processOpt = async (opt: DialogueOption) => {
      if (hasDirectAudioUrl(opt.soundEffect)) {
        const rel = await packOneAudio(opt.soundEffect!, `dlg_${opt.id}`, `Audio diálogo (${opt.playerText.slice(0, 24)})`);
        if (rel) opt.soundEffect = rel;
      }
    };
    for (const opt of dlg.options || []) await processOpt(opt);
    for (const node of dlg.nodes || []) {
      for (const opt of node.options || []) await processOpt(opt);
    }
  };

  for (const sc of project.scenes || []) {
    if (hasDirectAudioUrl(sc.sfx)) {
      const rel = await packOneAudio(sc.sfx!, `scene_${sc.id}`, `Audio escena ${sc.name || sc.id}`);
      if (rel) sc.sfx = rel;
    }
    for (const b of sc.textBlocks || []) {
      if (hasDirectAudioUrl(b.soundEffect)) {
        const rel = await packOneAudio(b.soundEffect!, `block_${b.id}`, `Audio párrafo ${sc.name || sc.id}`);
        if (rel) b.soundEffect = rel;
      }
      await packDialogueAudio(b.dialogue);
    }
    for (const hs of sc.hotspots || []) {
      for (const act of hs.actions || []) {
        if (hasDirectAudioUrl(act.soundEffect)) {
          const rel = await packOneAudio(act.soundEffect!, `act_${act.id}`, `Audio acción ${hs.word}`);
          if (rel) act.soundEffect = rel;
        }
        if (hasDirectAudioUrl(act.failSoundEffect)) {
          const rel = await packOneAudio(act.failSoundEffect!, `act_fail_${act.id}`, `Audio fallo ${hs.word}`);
          if (rel) act.failSoundEffect = rel;
        }
        await packDialogueAudio(act.dialogue);
      }
    }
  }

  return failed;
}

/**
 * Exports project as a ZIP bundle containing index.html, an img/ folder with all images
 * and a sounds/ folder with the audio files.
 * `onAssetsNotPacked` receives the names of resources that could not be downloaded.
 */
export async function exportProjectAsZip(
  project: GameProject,
  onAssetsNotPacked?: (names: string[]) => void
): Promise<Blob> {
  const zip = new JSZip();
  const updatedProject = JSON.parse(JSON.stringify(project)) as GameProject;

  // Imágenes (Base64 + URLs externas/GitHub) -> carpeta img/
  const failedImages = await packImages(zip, updatedProject);

  // Sonidos (Base64 + URLs externas/GitHub) -> carpeta sounds/
  const failedSounds = await packSounds(zip, updatedProject);

  const allFailed = [...failedImages.map((n) => `Imagen: ${n}`), ...failedSounds.map((n) => `Sonido: ${n}`)];
  if (allFailed.length > 0 && onAssetsNotPacked) {
    onAssetsNotPacked(allFailed);
  }

  // Generate standalone HTML with updated relative paths (isForZip = true)
  const htmlContent = generateStandaloneHTML(updatedProject, true);
  zip.file('index.html', htmlContent);

  return await zip.generateAsync({ type: 'blob' });
}
