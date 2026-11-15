const STORAGE_KEY = 'urdimbre_completed_stories';
const PROGRESS_EVENT = 'urdimbre:story-progress-updated';

interface StoryProgressState {
  completedIds: string[];
  tutorialCompleted: boolean;
  updatedAt?: string;
}

const DEFAULT_STATE: StoryProgressState = {
  completedIds: [],
  tutorialCompleted: false,
};

export function normalizeStoryTitle(title?: string): string {
  return (title || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

export function getTutorialPriority(title?: string): number {
  const normalized = normalizeStoryTitle(title);
  if (!normalized) return 0;
  if (normalized === 'tutorial') return 2;
  if (
    normalized.startsWith('tutorial:') ||
    normalized.startsWith('tutorial -') ||
    normalized.startsWith('tutorial ')
  ) {
    return 1;
  }
  return 0;
}

export function isTutorialTitle(title?: string): boolean {
  return getTutorialPriority(title) > 0;
}

function readProgressState(): StoryProgressState {
  if (typeof window === 'undefined' || !window.localStorage) {
    return DEFAULT_STATE;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as Partial<StoryProgressState>;
    return {
      completedIds: Array.isArray(parsed.completedIds)
        ? parsed.completedIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : [],
      tutorialCompleted: Boolean(parsed.tutorialCompleted),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined,
    };
  } catch {
    return DEFAULT_STATE;
  }
}

function writeProgressState(nextState: StoryProgressState): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
    window.dispatchEvent(new CustomEvent(PROGRESS_EVENT));
  } catch {
    // Ignore storage quota or private-mode access errors
  }
}

export function markStoryCompleted(storyId?: string, title?: string): void {
  const current = readProgressState();
  const cleanId = (storyId || '').trim();
  const isTut = isTutorialTitle(title);

  const alreadyHasId = !cleanId || current.completedIds.includes(cleanId);
  const alreadyTut = !isTut || current.tutorialCompleted;

  if (alreadyHasId && alreadyTut) {
    return;
  }

  const nextCompletedIds =
    cleanId && !current.completedIds.includes(cleanId)
      ? [...current.completedIds, cleanId]
      : current.completedIds;

  writeProgressState({
    completedIds: nextCompletedIds,
    tutorialCompleted: current.tutorialCompleted || isTut,
    updatedAt: new Date().toISOString(),
  });
}

export function isTutorialCompleted(): boolean {
  return readProgressState().tutorialCompleted;
}

export function isStoryCompleted(storyId?: string): boolean {
  if (!storyId) return false;
  return readProgressState().completedIds.includes(storyId);
}

export function subscribeStoryProgress(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const handleStorage = (e: StorageEvent) => {
    if (!e.key || e.key === STORAGE_KEY) {
      onChange();
    }
  };
  const handleCustom = () => {
    onChange();
  };

  window.addEventListener('storage', handleStorage);
  window.addEventListener(PROGRESS_EVENT, handleCustom);
  return () => {
    window.removeEventListener('storage', handleStorage);
    window.removeEventListener(PROGRESS_EVENT, handleCustom);
  };
}
