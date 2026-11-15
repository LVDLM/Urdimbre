import { DialogueBlock, DialogueOption, GameProject } from '../types';

export const GITHUB_MEDIA_OWNER = 'LVDLM';
export const GITHUB_MEDIA_REPO = 'Urdimbre_medios';
export const GITHUB_MEDIA_BRANCH = 'main';

export const MAX_DIRECT_UPLOAD_BYTES = 3 * 1024 * 1024; // 3 MB
export const MAX_MIRROR_BYTES = 5 * 1024 * 1024; // 5 MB

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function getProjectMediaFolderSlug(
  project?: { id?: string; title?: string },
  isShared?: boolean
): string {
  if (isShared) return 'compartidos';
  const raw = project?.title || project?.id || 'proyecto';
  const cleaned = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return cleaned || 'proyecto';
}

export function isExternalHttpUrl(value?: string): boolean {
  if (!value) return false;
  return /^https?:\/\//i.test(value.trim());
}

/**
 * Checks whether a URL already points to our dedicated GitHub media repository (via Pages, jsDelivr, or raw).
 */
export function isGitHubMediaUrl(value?: string): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  const ownerLower = GITHUB_MEDIA_OWNER.toLowerCase();
  const repoEsc = GITHUB_MEDIA_REPO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const pagesRe = new RegExp(`^https?://${ownerLower}\\.github\\.io/${repoEsc}/`, 'i');
  const jsdelivrRe = new RegExp(`^https?://cdn\\.jsdelivr\\.net/gh/${GITHUB_MEDIA_OWNER}/${repoEsc}(?:@[^/]+)?/`, 'i');
  const rawRe = new RegExp(`^https?://raw\\.githubusercontent\\.com/${GITHUB_MEDIA_OWNER}/${repoEsc}/`, 'i');

  return pagesRe.test(trimmed) || jsdelivrRe.test(trimmed) || rawRe.test(trimmed);
}

/**
 * Extracts the relative repo path from jsDelivr / raw / GitHub Pages URLs pointing to LVDLM/Urdimbre_medios.
 */
export function extractGitHubMediaRepoPath(value?: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const ownerLower = GITHUB_MEDIA_OWNER.toLowerCase();
  const repoEsc = GITHUB_MEDIA_REPO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const jsdelivrRe = new RegExp(`^https?://cdn\\.jsdelivr\\.net/gh/${GITHUB_MEDIA_OWNER}/${repoEsc}(?:@[^/]+)?/(.+)$`, 'i');
  const mJs = trimmed.match(jsdelivrRe);
  if (mJs?.[1]) return mJs[1];

  const rawRe = new RegExp(`^https?://raw\\.githubusercontent\\.com/${GITHUB_MEDIA_OWNER}/${repoEsc}/[^/]+/(.+)$`, 'i');
  const mRaw = trimmed.match(rawRe);
  if (mRaw?.[1]) return mRaw[1];

  const pagesRe = new RegExp(`^https?://${ownerLower}\\.github\\.io/${repoEsc}/(.+)$`, 'i');
  const mPages = trimmed.match(pagesRe);
  if (mPages?.[1]) return mPages[1];

  return null;
}

/**
 * Converts immediate-use CDN URLs (jsDelivr/raw) to the canonical GitHub Pages URL for story publication.
 */
export function toPublicationMediaUrl(url: string): string {
  const repoPath = extractGitHubMediaRepoPath(url);
  if (!repoPath) return url;
  return `https://${GITHUB_MEDIA_OWNER.toLowerCase()}.github.io/${GITHUB_MEDIA_REPO}/${repoPath}`;
}

/**
 * Converts a GitHub Pages URL back to the instant jsDelivr CDN URL if needed.
 */
export function toImmediateMediaUrl(url: string): string {
  const repoPath = extractGitHubMediaRepoPath(url);
  if (!repoPath) return url;
  return `https://cdn.jsdelivr.net/gh/${GITHUB_MEDIA_OWNER}/${GITHUB_MEDIA_REPO}@${GITHUB_MEDIA_BRANCH}/${repoPath}`;
}

function rewriteOption(opt: DialogueOption): DialogueOption {
  if (!opt.soundEffect || !isExternalHttpUrl(opt.soundEffect)) return opt;
  return { ...opt, soundEffect: toPublicationMediaUrl(opt.soundEffect) };
}

function rewriteDialogue(dlg?: DialogueBlock): DialogueBlock | undefined {
  if (!dlg) return dlg;
  return {
    ...dlg,
    options: dlg.options ? dlg.options.map(rewriteOption) : dlg.options,
    nodes: dlg.nodes
      ? dlg.nodes.map((node) => ({
          ...node,
          options: (node.options || []).map(rewriteOption),
        }))
      : dlg.nodes,
  };
}

/**
 * Returns a deep copy of a GameProject where all immediate GitHub media URLs
 * (cdn.jsdelivr.net / raw.githubusercontent.com) are rewritten to lvdlm.github.io for publication.
 * The author's draft (projectData) remains untouched for fast dynamic editing.
 */
export function rewriteProjectMediaUrlsForPublication(project: GameProject): GameProject {
  const copy = JSON.parse(JSON.stringify(project)) as GameProject;

  if (Array.isArray(copy.customSounds)) {
    copy.customSounds = copy.customSounds.map((s) =>
      s.url && isExternalHttpUrl(s.url) ? { ...s, url: toPublicationMediaUrl(s.url) } : s
    );
  }

  if (Array.isArray(copy.inventoryItems)) {
    copy.inventoryItems = copy.inventoryItems.map((item) =>
      item.imageUrl && isExternalHttpUrl(item.imageUrl)
        ? { ...item, imageUrl: toPublicationMediaUrl(item.imageUrl) }
        : item
    );
  }

  if (Array.isArray(copy.characters)) {
    copy.characters = copy.characters.map((ch) =>
      ch.imageUrl && isExternalHttpUrl(ch.imageUrl)
        ? { ...ch, imageUrl: toPublicationMediaUrl(ch.imageUrl) }
        : ch
    );
  }

  if (Array.isArray(copy.scenes)) {
    copy.scenes = copy.scenes.map((sc) => ({
      ...sc,
      sfx: sc.sfx && isExternalHttpUrl(sc.sfx) ? toPublicationMediaUrl(sc.sfx) : sc.sfx,
      textBlocks: (sc.textBlocks || []).map((b) => ({
        ...b,
        imageUrl: b.imageUrl && isExternalHttpUrl(b.imageUrl) ? toPublicationMediaUrl(b.imageUrl) : b.imageUrl,
        soundEffect:
          b.soundEffect && isExternalHttpUrl(b.soundEffect)
            ? toPublicationMediaUrl(b.soundEffect)
            : b.soundEffect,
        dialogue: rewriteDialogue(b.dialogue),
      })),
      hotspots: (sc.hotspots || []).map((hs) => ({
        ...hs,
        actions: (hs.actions || []).map((act) => ({
          ...act,
          soundEffect:
            act.soundEffect && isExternalHttpUrl(act.soundEffect)
              ? toPublicationMediaUrl(act.soundEffect)
              : act.soundEffect,
          failSoundEffect:
            act.failSoundEffect && isExternalHttpUrl(act.failSoundEffect)
              ? toPublicationMediaUrl(act.failSoundEffect)
              : act.failSoundEffect,
          dialogue: rewriteDialogue(act.dialogue),
        })),
      })),
    }));
  }

  return copy;
}
