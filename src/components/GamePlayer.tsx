import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { GameProject, Hotspot, VerbType, ActionRule, InventoryItem, SaveSlotData, AppendedTextEntry, DialogueOption, DialogueBlock, GameCharacter, Scene } from '../types';
import { THEME_CONFIGS } from '../utils/themeStyles';
import { renderTextWithLinks, isWordMatchInText } from '../utils/textUtils';
import { ALL_VERBS, getProjectVerbs, renderVerbIcon } from '../utils/verbs';
import { playSound, playBlockSound, playSceneSounds, setActiveProjectSounds, stopAllAudio, stopMusic } from '../utils/audio';
import { applyItemEffects, canAfford, deliveryKey, getGrants, getRemovals, isDelivered, missingItems } from '../utils/itemRules';
import {
  Eye,
  Zap,
  DoorOpen,
  Hand,
  MessageSquare,
  Move,
  Footprints,
  Key,
  BookOpen,
  Flashlight,
  Box,
  RotateCcw,
  Sparkles,
  HelpCircle,
  X,
  CheckCircle2,
  Compass,
  Shield,
  PackageCheck,
  Save,
  Skull,
  Bookmark,
  ArrowRight,
  ArrowDown,
  Play,
  Info,
  Award,
  ChevronUp,
  ChevronDown,
  Volume2,
  VolumeX,
  Palette,
  Highlighter,
  FileText,
  LogOut,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { StarRatingDisplay, StoryRatingWidget } from './common/StarRating';
import { getStoryRating } from '../lib/firebase';
import { markStoryCompleted } from '../utils/storyProgress';

interface GamePlayerProps {
  project: GameProject;
  updateProject?: (fn: (prev: GameProject) => GameProject) => void;
  gameState: {
    currentSceneId: string;
    inventory: string[];
    flags: Record<string, boolean>;
    appendedTextsPerScene: Record<string, AppendedTextEntry[]>;
    history: { id: string; type: 'story' | 'response' | 'system'; text: string }[];
    usedHotspotIds?: string[];
    deliveredRuleKeys?: string[]; // Fuentes de entrega de escena que ya entregaron sus objetos
    verbUseCounts?: Record<string, number>;
    usedDialogueOptionIds?: string[];
    difficulty?: 'facil' | 'normal' | 'dificil';
    isGameOver?: boolean;
  };
  setGameState: React.Dispatch<React.SetStateAction<any>>;
  onReset: () => void;
  onExit?: () => void;
  onOpenSaveLoad?: () => void;
  isHeaderCollapsed?: boolean;
  setIsHeaderCollapsed?: (collapsed: boolean) => void;
  soundEnabled?: boolean;
  toggleSound?: () => void;
  isSceneTesting?: boolean;
  asistirResaltado?: boolean;
  toggleAsistirResaltado?: () => void;
  showDetailsModal?: boolean;
  setShowDetailsModal?: (show: boolean) => void;
}

const ICON_MAP: Record<string, React.FC<{ className?: string }>> = {
  Key: ({ className }) => <Key className={className} />,
  BookOpen: ({ className }) => <BookOpen className={className} />,
  Flashlight: ({ className }) => <Flashlight className={className} />,
  Box: ({ className }) => <Box className={className} />,
  Skull: ({ className }) => <Skull className={className} />,
};

// Determines if an inventory item is needed in the specified scene
const isItemNeededInScene = (item: InventoryItem, scene?: Scene): boolean => {
  if (!scene) return false;

  // 1. Explicitly required by any hotspot action
  const requiredByAction = (scene.hotspots || []).some((hs) =>
    (hs.actions || []).some((act) => act.requiredItemId === item.id)
  );
  if (requiredByAction) return true;

  // 2. Action removes or changes this item
  const touchesItemState = (scene.hotspots || []).some((hs) =>
    (hs.actions || []).some(
      (act) =>
        act.stateChange?.removeItemId === item.id ||
        act.stateChange?.removeItem2Id === item.id ||
        (act.stateChange?.removeItems?.[item.id] ?? 0) > 0
    )
  );
  if (touchesItemState) return true;

  // 3. Flags: scene hotspots require flags that this item provides
  const neededFlagsInScene = new Set<string>();
  (scene.hotspots || []).forEach((hs) => {
    if (hs.visibleIfFlags) Object.keys(hs.visibleIfFlags).forEach((f) => neededFlagsInScene.add(f));
    if (hs.hiddenIfFlags) Object.keys(hs.hiddenIfFlags).forEach((f) => neededFlagsInScene.add(f));
    (hs.actions || []).forEach((act) => {
      if (act.requiredFlags) Object.keys(act.requiredFlags).forEach((f) => neededFlagsInScene.add(f));
    });
  });

  if (item.useEffectAction?.stateChange?.setFlags) {
    for (const flagKey of Object.keys(item.useEffectAction.stateChange.setFlags)) {
      if (neededFlagsInScene.has(flagKey)) return true;
    }
  }

  if (item.combinations) {
    for (const combo of item.combinations) {
      if (combo.stateChange?.setFlags) {
        for (const flagKey of Object.keys(combo.stateChange.setFlags)) {
          if (neededFlagsInScene.has(flagKey)) return true;
        }
      }
    }
  }

  // 4. Mentioned by name in scene text or hotspots
  const itemNameLower = item.name.toLowerCase().trim();
  if (itemNameLower.length >= 2) {
    const inText = (scene.textBlocks || []).some((b) =>
      b.text.toLowerCase().includes(itemNameLower)
    );
    if (inText) return true;

    const inHotspot = (scene.hotspots || []).some(
      (hs) =>
        hs.word.toLowerCase().includes(itemNameLower) ||
        (hs.label && hs.label.toLowerCase().includes(itemNameLower)) ||
        (hs.actions || []).some((act) => act.responseMessage?.toLowerCase().includes(itemNameLower))
    );
    if (inHotspot) return true;
  }

  // 5. QTE step target
  if (scene.qteConfig?.sequence) {
    const isQteTarget = scene.qteConfig.sequence.some(
      (step) =>
        step.label.toLowerCase().includes(itemNameLower) ||
        (step.word && step.word.toLowerCase().includes(itemNameLower))
    );
    if (isQteTarget) return true;
  }

  return false;
};

const GAME_OVER_TAG_REGEX = /\[(?:Terminar \/ Cargar partida|Terminar|Cargar partida|Fin de partida)\]/i;

const cloneGameState = <T,>(st: T): T => {
  if (!st) return st;
  try {
    return JSON.parse(JSON.stringify(st));
  } catch {
    return { ...st };
  }
};

const isStateGameOverOrEnding = (
  scene: Scene | undefined,
  flags: Record<string, boolean>,
  inventory: string[],
  sceneAppended: (AppendedTextEntry | string)[] | undefined,
  isGameOverFlag?: boolean
): boolean => {
  if (isGameOverFlag) return true;
  if (!scene) return false;
  if (scene.type === 'final') return true;
  const hasBlockEnd = (scene.textBlocks || []).some((b) => {
    if (b.visibleIfFlags) {
      for (const [k, v] of Object.entries(b.visibleIfFlags)) {
        if (!!flags[k] !== !!v) return false;
      }
    }
    if (b.hiddenIfFlags) {
      for (const [k, v] of Object.entries(b.hiddenIfFlags)) {
        if (!!flags[k] === !!v) return false;
      }
    }
    const reqItems = b.requiredItemIds || (b.requiredItemId ? [b.requiredItemId] : []);
    if (reqItems.length > 0 && !reqItems.every((id) => inventory.includes(id))) {
      return false;
    }
    return b.isGameOver || b.type === 'final' || GAME_OVER_TAG_REGEX.test(b.text || '');
  });
  if (hasBlockEnd) return true;
  return (sceneAppended || []).some((t) => {
    const textVal = typeof t === 'string' ? t : t.text;
    return GAME_OVER_TAG_REGEX.test(textVal || '');
  });
};

// Filter progressive text for QTE scenes: [1] appears after action 1, [2] after action 2, etc.
// Preserves the author's original whitespace and inline flow without forcing newline breaks.
const filterQTEProgressiveText = (
  rawText: string,
  stepIndex: number,
  isFinished: boolean,
  activeMarkStep?: number
): string => {
  const sanitized = rawText.replace(/<\/?qte-mark>/gi, '');
  if (!/\[\d+\]/.test(sanitized)) {
    return sanitized;
  }

  // If the QTE is not yet finished, cut off the text at the first unrevealed [N] tag (where N > stepIndex)
  let visibleText = sanitized;
  if (!isFinished) {
    const regex = /\[(\d+)\]/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(sanitized)) !== null) {
      const stepNum = parseInt(match[1], 10);
      if (stepNum > stepIndex) {
        visibleText = sanitized.slice(0, match.index);
        break;
      }
    }
  }

  // Optionally mark the boundary of the newly unlocked [N] step so the player never loses sight of it below the fold
  if (activeMarkStep && activeMarkStep > 0) {
    visibleText = visibleText
      .replace(new RegExp(`\\s+\\[${activeMarkStep}\\](?=[,.;:!?])`, 'g'), '<qte-mark></qte-mark>')
      .replace(new RegExp(`\\[${activeMarkStep}\\][ \\t]?`, 'g'), '<qte-mark></qte-mark>');
  }

  // Remove revealed [N] tags cleanly:
  // 1. If preceded by whitespace and followed by punctuation (e.g. "agacharte [1],"), remove leading space too -> "agacharte,"
  // 2. Otherwise remove the tag and any single immediate trailing space/tab -> "agacharte [1] luego" -> "agacharte luego"
  return visibleText
    .replace(/\s+\[\d+\](?=[,.;:!?])/g, '')
    .replace(/\[\d+\][ \t]?/g, '')
    .trimEnd();
};

export const GamePlayer: React.FC<GamePlayerProps> = ({
  project,
  updateProject,
  gameState,
  setGameState,
  onReset,
  onExit,
  onOpenSaveLoad,
  isHeaderCollapsed: propIsHeaderCollapsed,
  setIsHeaderCollapsed: propSetIsHeaderCollapsed,
  soundEnabled = true,
  toggleSound,
  isSceneTesting = false,
  asistirResaltado: propAsistirResaltado,
  toggleAsistirResaltado: propToggleAsistirResaltado,
  showDetailsModal: propShowDetailsModal,
  setShowDetailsModal: propSetShowDetailsModal,
}) => {
  const projectVerbs = getProjectVerbs(project);
  const [activeVerb, setActiveVerb] = useState<VerbType | null>(null);
  const [selectedInventoryItemId, setSelectedInventoryItemId] = useState<string | null>(null);
  const [showSaveNotification, setShowSaveNotification] = useState(false);
  const [retryToast, setRetryToast] = useState<string | null>(null);
  const [showExitConfirmModal, setShowExitConfirmModal] = useState(false);
  const safeCheckpointRef = useRef<any>(null);
  const checkpointProjectIdRef = useRef<string | null>(null);
  const [modalFeedback, setModalFeedback] = useState<{
    type: 'action' | 'item' | 'gameover';
    title?: string;
    showTitle?: boolean;
    verbIconName?: string;
    isAutosaved?: boolean;
    isGameOver?: boolean;
    itemImageUrl?: string;
    message: string;
    onClose?: () => void;
  } | null>(null);
  const [modalQueue, setModalQueue] = useState<{
    type: 'action' | 'item' | 'gameover';
    title?: string;
    showTitle?: boolean;
    verbIconName?: string;
    isAutosaved?: boolean;
    isGameOver?: boolean;
    itemImageUrl?: string;
    message: string;
    onClose?: () => void;
  }[]>([]);

  const dismissModalFeedback = () => {
    const currentOnClose = modalFeedback?.onClose;
    if (modalQueue.length > 0) {
      const [nextModal, ...remainingQueue] = modalQueue;
      setModalFeedback(nextModal);
      setModalQueue(remainingQueue);
      if (currentOnClose) currentOnClose();
    } else {
      setModalFeedback(null);
      if (currentOnClose) currentOnClose();
    }
  };

  const queueModals = (modals: {
    type: 'action' | 'item' | 'gameover';
    title?: string;
    verbIconName?: string;
    isAutosaved?: boolean;
    isGameOver?: boolean;
    itemImageUrl?: string;
    message: string;
    onClose?: () => void;
  }[]) => {
    if (modals.length === 0) return;
    const [first, ...rest] = modals;
    setModalFeedback(first);
    setModalQueue(rest);
  };
  
  // Details & Credits modal state
  const [localShowDetailsModal, setLocalShowDetailsModal] = useState(false);
  const showDetailsModal = propShowDetailsModal !== undefined ? propShowDetailsModal : localShowDetailsModal;
  const setShowDetailsModal = propSetShowDetailsModal || setLocalShowDetailsModal;

  // Collapsible Header State
  const [localIsHeaderCollapsed, setLocalIsHeaderCollapsed] = useState(false);
  const isHeaderCollapsed = propIsHeaderCollapsed !== undefined ? propIsHeaderCollapsed : localIsHeaderCollapsed;
  const setIsHeaderCollapsed = propSetIsHeaderCollapsed || setLocalIsHeaderCollapsed;

  // Ayuda visual: resaltar siempre las palabras interactivas
  const [localAsistirResaltado, setLocalAsistirResaltado] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem('urdimbre_asistir_resaltado');
      if (stored === 'true' || stored === 'false') return stored === 'true';
      return window.matchMedia('(pointer: coarse)').matches;
    } catch {
      return false;
    }
  });

  const asistirResaltado = propAsistirResaltado !== undefined ? propAsistirResaltado : localAsistirResaltado;
  const toggleAsistirResaltado = propToggleAsistirResaltado || (() => {
    setLocalAsistirResaltado((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('urdimbre_asistir_resaltado', String(next));
      } catch {
        /* almacenamiento no disponible */
      }
      return next;
    });
  });

  // Direct click word context menu modal
  const [contextMenu, setContextMenu] = useState<{
    hotspotId: string;
    word: string;
    x: number;
    y: number;
  } | null>(null);

  // Active Pop-up Dialogue Modal state
  const [activeDialogue, setActiveDialogue] = useState<{
    character: GameCharacter;
    blockId?: string;
    currentNodeId: string;
    dialogueBlock: DialogueBlock;
    currentNpcReply?: string;
    lastTurnNotice?: string;
    receivedItemIds?: string[];
  } | null>(null);

  const closeActiveDialogue = (
    currentReceivedItems?: string[],
    closingMessage?: string,
    closingCharacter?: GameCharacter
  ) => {
    const itemsToNotify = currentReceivedItems || activeDialogue?.receivedItemIds || [];
    const trimmedClosing = closingMessage?.trim() || '';
    if (itemsToNotify.length > 0) {
      const lastItemId = itemsToNotify[itemsToNotify.length - 1];
      const itemObj = project.inventoryItems.find((i) => i.id === lastItemId);
      if (itemObj) {
        setModalFeedback({
          type: 'action',
          title: trimmedClosing && closingCharacter ? closingCharacter.name : 'OBJETO RECIBIDO',
          showTitle: !!(trimmedClosing && closingCharacter),
          verbIconName: 'Plus',
          isAutosaved: true,
          itemImageUrl: itemObj.imageFileData || itemObj.imageUrl,
          message: trimmedClosing
            ? `${trimmedClosing}\n\n¡Has conseguido: ${itemObj.name.toUpperCase()}!`
            : `¡Has conseguido: ${itemObj.name.toUpperCase()}!`,
        });
      }
    } else if (trimmedClosing) {
      setModalFeedback({
        type: 'action',
        title: closingCharacter?.name || 'Conversación',
        showTitle: !!closingCharacter?.name,
        verbIconName: 'MessageSquare',
        message: trimmedClosing,
      });
    }
    setActiveDialogue(null);
  };

  // Quick Time Event (QTE) State
  const [qteTimeLeft, setQteTimeLeft] = useState<number>(0);
  const [qteStepIndex, setQteStepIndex] = useState<number>(0);
  const [qteStatus, setQteStatus] = useState<'active' | 'success' | 'failed' | 'idle'>('idle');
  const [qteMistakeMsg, setQteMistakeMsg] = useState<string | null>(null);

  const currentTheme = project?.theme || 'sepia-parchment';
  const themeConfig = THEME_CONFIGS[currentTheme] || THEME_CONFIGS['sepia-parchment'];
  const isSepia = currentTheme === 'sepia-parchment';
  const currentScene = project.scenes.find((s) => s.id === gameState.currentSceneId) || project.scenes[0];
  const isPortada = Boolean(
    currentScene?.type === 'portada' ||
    ((gameState.currentSceneId === project.initialSceneId || (!project.initialSceneId && project.scenes[0]?.id === currentScene?.id)) &&
      currentScene?.type !== 'qte' && currentScene?.type !== 'final')
  );

  const isQTEScene = (currentScene?.type === 'qte' || !!currentScene?.qteConfig) && !!currentScene?.qteConfig?.sequence?.length;

  // Collapsible Document Blocks state: auto-expands on load/reveal, collapses on title click
  const [expandedDocBlocks, setExpandedDocBlocks] = useState<Record<string, boolean>>({});
  const prevVisibleDocIdsRef = useRef<Set<string>>(new Set());
  const prevDocSceneIdRef = useRef<string | null>(null);
  const prevDocProjectIdRef = useRef<string | null>(null);
  const prevDocHistoryLenRef = useRef<number>(0);

  const toggleDocBlock = (blockId: string) => {
    setExpandedDocBlocks((prev) => {
      const current = prev[blockId] !== undefined ? prev[blockId] : true;
      return { ...prev, [blockId]: !current };
    });
  };

  // Al cambiar de escena (o cargar la historia / una partida guardada) se vuelve al
  // inicio: tanto la página como la tarjeta narrativa, que en modo cabecera
  // colapsada en pantallas anchas es un contenedor con scroll propio.
  const narrativeRef = useRef<HTMLDivElement>(null);
  const qteHudRef = useRef<HTMLDivElement>(null);
  const lastClickedContainerIdRef = useRef<string | null>(null);
  const skipNextTopResetRef = useRef<boolean>(false);
  const pendingScrollModeRef = useRef<'reveal' | 'qte-origin'>('reveal');
  const qteRevealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const qteRevealCleanupRef = useRef<(() => void) | null>(null);
  const pendingQteRevealKeysRef = useRef<string[] | null>(null);
  const sceneVisitSnapshotsRef = useRef<Map<string, {
    visibleKeys: Set<string>;
    scrollTop: number;
    windowScrollY: number;
    lastDomId: string | null;
  }>>(new Map());
  const qteReturnAnchorRef = useRef<{
    originSceneId: string;
    qteSceneId: string;
    originDomId: string | null;
    originVisibleKeys: Set<string>;
    originScrollTop: number;
    originWindowScrollY: number;
  } | null>(null);
  const pendingFallbackScrollRef = useRef<{ top: number; windowY: number } | null>(null);

  const isSceneIdQTE = (sId?: string | null) => {
    if (!sId) return false;
    const sc = project.scenes.find((s) => s.id === sId);
    return !!(sc && (sc.type === 'qte' || sc.qteConfig) && sc.qteConfig?.sequence && sc.qteConfig.sequence.length > 0);
  };

  const resolveQteReturnAnchor = (
    projId: string | null,
    fromSceneId: string | null,
    toSceneId: string | null,
    histLen: number,
    snapHistLen: number,
    snapProjId: string | null
  ) => {
    if (snapProjId !== projId || !fromSceneId || !toSceneId || (histLen === 0 && snapHistLen > 0)) {
      return null;
    }
    const anchor = qteReturnAnchorRef.current;
    if (anchor && fromSceneId === anchor.qteSceneId && toSceneId === anchor.originSceneId) {
      return anchor;
    }
    if (isSceneIdQTE(fromSceneId) && !isSceneIdQTE(toSceneId)) {
      const prevVisit = sceneVisitSnapshotsRef.current.get(toSceneId);
      if (prevVisit) {
        return {
          originSceneId: toSceneId,
          qteSceneId: fromSceneId,
          originDomId: prevVisit.lastDomId,
          originVisibleKeys: new Set(prevVisit.visibleKeys),
          originScrollTop: prevVisit.scrollTop,
          originWindowScrollY: prevVisit.windowScrollY,
        };
      }
    }
    return null;
  };

  useEffect(() => {
    setActiveVerb(null);
    setSelectedInventoryItemId(null);
    setContextMenu(null);
    if (skipNextTopResetRef.current) {
      skipNextTopResetRef.current = false;
      return;
    }
    const anchor = qteReturnAnchorRef.current;
    if (!anchor || gameState.currentSceneId !== anchor.qteSceneId) {
      qteReturnAnchorRef.current = null;
    }
    narrativeRef.current?.scrollTo({ top: 0 });
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [gameState.currentSceneId]);

  // Detección de párrafos nuevos dentro de la misma escena (por flags, inventario o texto añadido),
  // con animación de aparición diferida si hay un mensaje/entrega de objeto abierto y foco automático al nuevo contenido.
  const [deferredRevealKeys, setDeferredRevealKeys] = useState<Set<string>>(() => new Set());
  const [highlightedRevealKeys, setHighlightedRevealKeys] = useState<Set<string>>(() => new Set());
  const [pendingScrollDomId, setPendingScrollDomId] = useState<string | null>(null);
  const prevRevealSnapshotRef = useRef<{
    projectId: string | null;
    sceneId: string | null;
    historyLen: number;
    keys: Set<string>;
  }>({
    projectId: null,
    sceneId: null,
    historyLen: 0,
    keys: new Set(),
  });

  const captureQteReturnAnchor = (targetSceneId?: string, explicitBlockId?: string | null) => {
    if (!targetSceneId || targetSceneId === gameState.currentSceneId) return;
    if (!isSceneIdQTE(targetSceneId)) return;

    const existing = qteReturnAnchorRef.current;
    if (existing && existing.qteSceneId === gameState.currentSceneId && isSceneIdQTE(gameState.currentSceneId)) {
      qteReturnAnchorRef.current = {
        ...existing,
        qteSceneId: targetSceneId,
      };
      return;
    }

    const originDomId =
      lastClickedContainerIdRef.current ||
      (explicitBlockId ? `block-${explicitBlockId}` : null);

    qteReturnAnchorRef.current = {
      originSceneId: gameState.currentSceneId,
      qteSceneId: targetSceneId,
      originDomId,
      originVisibleKeys: new Set(prevRevealSnapshotRef.current.keys),
      originScrollTop: narrativeRef.current?.scrollTop || 0,
      originWindowScrollY: window.scrollY || 0,
    };
  };

  const getStickySafeTopMargin = () => {
    const stickyTopBase = isHeaderCollapsed ? 48 : 62;
    if (isQTEScene && qteStatus === 'active' && qteHudRef.current) {
      return stickyTopBase + qteHudRef.current.getBoundingClientRect().height + 16;
    }
    return stickyTopBase + 16;
  };

  const scrollToRevealedElement = (el: HTMLElement, mode: 'reveal' | 'qte-origin' = 'reveal') => {
    const container = narrativeRef.current;
    const isContainerScrollable =
      container &&
      container.scrollHeight > container.clientHeight + 4 &&
      ['auto', 'scroll'].includes(window.getComputedStyle(container).overflowY);
    const bottomPadding = 112; // ~3-4 lines of breathing room below so added paragraphs & animations never start below fold

    if (isContainerScrollable && container) {
      const containerRect = container.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const elTopInContainer = container.scrollTop + (elRect.top - containerRect.top);
      const elBottomInContainer = elTopInContainer + elRect.height;
      const maxTopScroll = Math.max(0, elTopInContainer - 24);
      const neededBottomScroll = Math.max(0, elBottomInContainer + bottomPadding - container.clientHeight);

      let targetTop = maxTopScroll;
      if (elRect.height + bottomPadding + 24 <= container.clientHeight) {
        const midScroll = Math.max(
          0,
          elTopInContainer - Math.round((container.clientHeight - elRect.height) * 0.32)
        );
        targetTop = Math.min(maxTopScroll, Math.max(neededBottomScroll, midScroll));
      } else if (mode === 'qte-origin') {
        targetTop = neededBottomScroll;
      }

      container.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });

      const stickyTopBase = isHeaderCollapsed ? 52 : 68;
      if (containerRect.top < stickyTopBase) {
        window.scrollTo({
          top: Math.max(0, window.scrollY + containerRect.top - stickyTopBase - 8),
          behavior: 'smooth',
        });
      }
    } else {
      const elRect = el.getBoundingClientRect();
      const safeTop = getStickySafeTopMargin();
      const availH = Math.max(120, window.innerHeight - safeTop - bottomPadding);
      const elTopDoc = window.scrollY + elRect.top;
      const elBottomDoc = elTopDoc + elRect.height;
      const maxTopY = Math.max(0, elTopDoc - safeTop);
      const neededBottomY = Math.max(0, elBottomDoc + bottomPadding - window.innerHeight);

      let targetY = maxTopY;
      if (elRect.height <= availH) {
        const midY = Math.max(0, elTopDoc - safeTop - Math.round((availH - elRect.height) * 0.25));
        targetY = Math.min(maxTopY, Math.max(neededBottomY, midY));
      } else if (mode === 'qte-origin') {
        targetY = neededBottomY;
      }

      window.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });
    }
  };

  const ensureQteRevealVisible = (anchorEl: HTMLElement) => {
    const blockEl =
      (anchorEl.closest('[id^="block-"], [id^="unattached-appended-"]') as HTMLElement) ||
      anchorEl.parentElement ||
      anchorEl;
    const rawAnchorRect = anchorEl.getBoundingClientRect();
    const blockRect = blockEl.getBoundingClientRect();
    const anchorRect =
      rawAnchorRect.height === 0 && rawAnchorRect.top === 0 ? blockRect : rawAnchorRect;

    const container = narrativeRef.current;
    const isContainerScrollable =
      container &&
      container.scrollHeight > container.clientHeight + 4 &&
      ['auto', 'scroll'].includes(window.getComputedStyle(container).overflowY);

    if (isContainerScrollable && container) {
      const cRect = container.getBoundingClientRect();
      if (anchorRect.top < cRect.top + 12) {
        const targetTop = Math.max(0, container.scrollTop + (anchorRect.top - cRect.top) - 20);
        container.scrollTo({ top: targetTop, behavior: 'smooth' });
      } else if (blockRect.bottom > cRect.bottom - 12) {
        const neededDown = blockRect.bottom - (cRect.bottom - 16);
        const maxDown = Math.max(0, anchorRect.top - (cRect.top + 16));
        const delta = Math.min(neededDown, maxDown);
        if (delta > 2) {
          container.scrollTo({ top: container.scrollTop + delta, behavior: 'smooth' });
        }
      }
    } else {
      const safeTop = getStickySafeTopMargin();
      const safeBottom = window.innerHeight - 24;
      if (anchorRect.top < safeTop) {
        const targetY = Math.max(0, window.scrollY + anchorRect.top - safeTop);
        window.scrollTo({ top: targetY, behavior: 'smooth' });
      } else if (blockRect.bottom > safeBottom) {
        const neededDown = blockRect.bottom - safeBottom;
        const maxDown = Math.max(0, anchorRect.top - safeTop);
        const delta = Math.min(neededDown, maxDown);
        if (delta > 2) {
          window.scrollTo({ top: window.scrollY + delta, behavior: 'smooth' });
        }
      }
    }
  };

  // Fetch live accumulated rating for story
  useEffect(() => {
    if (project?.id) {
      getStoryRating(project.id).then((res) => {
        if (res && res.ratingAverage > 0 && updateProject) {
          updateProject((p) => ({
            ...p,
            ratingAverage: res.ratingAverage,
            ratingCount: res.ratingCount,
          }));
        }
      });
    }
  }, [project?.id]);

  // Mantener sincronizada la biblioteca de sonidos del proyecto en el motor de audio
  useEffect(() => {
    setActiveProjectSounds(project.customSounds || []);
  }, [project.customSounds]);

  // Detener música y efectos al salir o desmontar el reproductor (p. ej., al volver al editor)
  useEffect(() => {
    return () => {
      stopAllAudio();
      if (qteRevealTimerRef.current) {
        clearTimeout(qteRevealTimerRef.current);
        qteRevealTimerRef.current = null;
      }
      if (qteRevealCleanupRef.current) {
        qteRevealCleanupRef.current();
        qteRevealCleanupRef.current = null;
      }
    };
  }, []);

  const playedBlockSoundIdsRef = useRef<Set<string>>(new Set());
  const lastAudioSceneIdRef = useRef<string | null>(null);

  useEffect(() => {
    setQteMistakeMsg(null);
    const isNewScene = lastAudioSceneIdRef.current !== gameState.currentSceneId;
    if (currentScene) {
      if (isNewScene) {
        lastAudioSceneIdRef.current = gameState.currentSceneId;
        playedBlockSoundIdsRef.current.clear();
      }

      const visibleBlocks = (currentScene.textBlocks || []).filter((b) => {
        if (b.visibleIfFlags && Object.entries(b.visibleIfFlags).some(([k, v]) => !!gameState.flags[k] !== v)) return false;
        if (b.hiddenIfFlags && Object.entries(b.hiddenIfFlags).some(([k, v]) => !!gameState.flags[k] === v)) return false;
        if (b.requiredItemId && !gameState.inventory.includes(b.requiredItemId)) return false;
        if (b.requiredItemIds && b.requiredItemIds.some((id) => !gameState.inventory.includes(id))) return false;
        return true;
      });

      if (isNewScene) {
        const blockWithSound = visibleBlocks.find((b) => b.soundEffect && b.soundEffect !== 'none');
        if (blockWithSound) {
          playedBlockSoundIdsRef.current.add(blockWithSound.id);
        }
        // Al entrar en una nueva escena se evalúa la música de la escena o el primer párrafo con sonido.
        // Si ese primer párrafo tiene modo propio (Loop / 1 / SFX) se reproduce justo después, con su modo.
        playSceneSounds(
          blockWithSound?.soundEffect,
          currentScene.sfx,
          project.customSounds,
          blockWithSound?.soundMode
        );
        // El resto de párrafos visibles con modo explícito también suenan al entrar, en orden
        // (así una escena puede llevar, por ejemplo, un Loop de fondo y un SFX de goteo).
        visibleBlocks.forEach((b) => {
          if (b !== blockWithSound && b.soundMode && b.soundEffect && b.soundEffect !== 'none') {
            playedBlockSoundIdsRef.current.add(b.id);
            playBlockSound(b.soundEffect, b.soundMode, project.customSounds);
          }
        });
      } else {
        // Dentro de la misma escena: si un nuevo párrafo se ha revelado por flags o inventario y tiene sonido,
        // reproducirlo dinámicamente sin necesidad de cambiar de escena
        visibleBlocks.forEach((b) => {
          if (b.soundEffect && b.soundEffect !== 'none' && !playedBlockSoundIdsRef.current.has(b.id)) {
            playedBlockSoundIdsRef.current.add(b.id);
            playBlockSound(b.soundEffect, b.soundMode, project.customSounds);
          }
        });
      }
    }
    if (isNewScene) {
      if (currentScene && (currentScene.type === 'qte' || currentScene.qteConfig) && currentScene.qteConfig?.sequence?.length) {
        const timeLimit = currentScene.qteConfig.timeLimitSeconds || 10;
        setQteTimeLeft(timeLimit);
        setQteStepIndex(0);
        setQteStatus('active');
      } else {
        setQteStatus('idle');
      }
    }
  }, [gameState.currentSceneId, currentScene?.id, gameState.flags, gameState.inventory, project.customSounds]);

  useEffect(() => {
    const sceneId = currentScene?.id || null;
    const projId = project?.id || null;
    const histLen = gameState.history?.length || 0;
    const isProjectSwitch = prevDocProjectIdRef.current !== projId;
    const isSceneSwitch = prevDocSceneIdRef.current !== sceneId;
    const isRestartReset = !isSceneSwitch && histLen === 0 && prevDocHistoryLenRef.current > 0;

    prevDocProjectIdRef.current = projId;
    prevDocSceneIdRef.current = sceneId;
    prevDocHistoryLenRef.current = histLen;

    if (!currentScene) {
      prevVisibleDocIdsRef.current = new Set();
      if (isProjectSwitch) setExpandedDocBlocks({});
      return;
    }

    const visibleDocIds = (currentScene.textBlocks || [])
      .filter((b) => {
        if (b.type !== 'documento') return false;
        if (b.visibleIfFlags && Object.entries(b.visibleIfFlags).some(([k, v]) => !!gameState.flags[k] !== v)) return false;
        if (b.hiddenIfFlags && Object.entries(b.hiddenIfFlags).some(([k, v]) => !!gameState.flags[k] === v)) return false;
        const reqItems = b.requiredItemIds || (b.requiredItemId ? [b.requiredItemId] : []);
        if (reqItems.length > 0 && !reqItems.every((id) => gameState.inventory.includes(id))) return false;
        return true;
      })
      .map((b) => b.id);

    setExpandedDocBlocks((prev) => {
      if (isProjectSwitch || isRestartReset) {
        const fresh: Record<string, boolean> = {};
        visibleDocIds.forEach((id) => {
          fresh[id] = true;
        });
        return fresh;
      }

      let changed = false;
      const next = { ...prev };
      visibleDocIds.forEach((id) => {
        const newlyRevealed = !prevVisibleDocIdsRef.current.has(id);
        if (isSceneSwitch || newlyRevealed) {
          if (next[id] !== true) {
            next[id] = true;
            changed = true;
          }
        }
      });
      return changed ? next : prev;
    });

    prevVisibleDocIdsRef.current = new Set(visibleDocIds);
  }, [project?.id, currentScene, gameState.flags, gameState.inventory, gameState.history?.length]);

  useLayoutEffect(() => {
    const projId = project?.id || null;
    const sceneId = currentScene?.id || null;
    const histLen = gameState.history?.length || 0;
    const snap = prevRevealSnapshotRef.current;
    const isSameScene =
      snap.projectId === projId &&
      snap.sceneId === sceneId &&
      !(histLen === 0 && snap.historyLen > 0);

    const sceneAppendedList = gameState.appendedTextsPerScene[gameState.currentSceneId] || [];
    const blockAppendedMap: Record<string, string[]> = {};
    const unattachedAppended: string[] = [];

    sceneAppendedList.forEach((entry) => {
      const txt = typeof entry === 'string' ? entry : entry.text;
      const bId = typeof entry === 'string' ? undefined : entry.blockId;
      if (bId) {
        if (!blockAppendedMap[bId]) blockAppendedMap[bId] = [];
        blockAppendedMap[bId].push(txt);
      } else {
        unattachedAppended.push(txt);
      }
    });

    const currentRevealItems: { key: string; domId: string; hasContent: boolean }[] = [];
    if (currentScene) {
      (currentScene.textBlocks || []).forEach((b) => {
        if (!checkConditions(b.visibleIfFlags, b.hiddenIfFlags)) return;
        const reqItems = b.requiredItemIds || (b.requiredItemId ? [b.requiredItemId] : []);
        if (reqItems.length > 0 && !reqItems.every((id) => gameState.inventory.includes(id))) return;

        const hasBlockContent = !!(b.text?.trim() || b.imageFileData || b.imageUrl);
        currentRevealItems.push({ key: `block:${b.id}`, domId: `block-${b.id}`, hasContent: hasBlockContent });
        const attached = blockAppendedMap[b.id] || [];
        attached.forEach((txt, i) => {
          currentRevealItems.push({
            key: `app:${b.id}:${i}`,
            domId: `block-appended-${b.id}-${i}`,
            hasContent: !!txt?.trim(),
          });
        });
      });

      unattachedAppended.forEach((txt, i) => {
        currentRevealItems.push({
          key: `app:unattached:${i}`,
          domId: `unattached-appended-${i}`,
          hasContent: !!txt?.trim(),
        });
      });
    }

    const currentKeySet = new Set(currentRevealItems.map((it) => it.key));

    if (snap.projectId !== projId || (histLen === 0 && snap.historyLen > 0)) {
      sceneVisitSnapshotsRef.current.clear();
    } else if (!isSameScene && snap.sceneId && !isSceneIdQTE(snap.sceneId)) {
      const existingVisit = sceneVisitSnapshotsRef.current.get(snap.sceneId);
      sceneVisitSnapshotsRef.current.set(snap.sceneId, {
        visibleKeys: new Set(snap.keys),
        scrollTop: narrativeRef.current?.scrollTop || existingVisit?.scrollTop || 0,
        windowScrollY: window.scrollY || existingVisit?.windowScrollY || 0,
        lastDomId: lastClickedContainerIdRef.current || existingVisit?.lastDomId || null,
      });
    }

    if (!isSameScene) {
      const anchor = resolveQteReturnAnchor(projId, snap.sceneId, sceneId, histLen, snap.historyLen, snap.projectId);

      prevRevealSnapshotRef.current = {
        projectId: projId,
        sceneId,
        historyLen: histLen,
        keys: currentKeySet,
      };

      if (anchor) {
        qteReturnAnchorRef.current = null;
        skipNextTopResetRef.current = true;
        if (qteRevealTimerRef.current) {
          clearTimeout(qteRevealTimerRef.current);
          qteRevealTimerRef.current = null;
        }
        if (qteRevealCleanupRef.current) {
          qteRevealCleanupRef.current();
          qteRevealCleanupRef.current = null;
        }

        // Restore prior scroll position synchronously before paint so the view never jumps to top: 0
        if (narrativeRef.current && narrativeRef.current.scrollHeight > narrativeRef.current.clientHeight + 4) {
          narrativeRef.current.scrollTop = anchor.originScrollTop || 0;
        }
        window.scrollTo({ top: anchor.originWindowScrollY || 0, left: 0, behavior: 'auto' });

        const newlyAddedAfterQte = currentRevealItems.filter(
          (it) => !anchor.originVisibleKeys.has(it.key)
        );
        const hasBlockingModal = !!(modalFeedback || modalQueue.length > 0 || activeDialogue);

        if (newlyAddedAfterQte.length > 0) {
          const newKeys = newlyAddedAfterQte.map((it) => it.key);
          const firstTarget = newlyAddedAfterQte.find((it) => it.hasContent) || newlyAddedAfterQte[0];
          setDeferredRevealKeys(new Set(newKeys));
          pendingScrollModeRef.current = 'reveal';
          if (!hasBlockingModal) {
            pendingQteRevealKeysRef.current = newKeys;
            setPendingScrollDomId(firstTarget.domId);
          }
        } else {
          pendingQteRevealKeysRef.current = null;
          if (deferredRevealKeys.size > 0) setDeferredRevealKeys(new Set());
          pendingScrollModeRef.current = 'qte-origin';
          const matchedOriginItem = anchor.originDomId
            ? currentRevealItems.find((it) => it.domId === anchor.originDomId)
            : null;
          if (matchedOriginItem) {
            setHighlightedRevealKeys(new Set([matchedOriginItem.key]));
            setPendingScrollDomId(matchedOriginItem.domId);
          } else if (anchor.originDomId) {
            setPendingScrollDomId(anchor.originDomId);
          } else {
            pendingFallbackScrollRef.current = {
              top: anchor.originScrollTop,
              windowY: anchor.originWindowScrollY,
            };
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                const fb = pendingFallbackScrollRef.current;
                pendingFallbackScrollRef.current = null;
                if (!fb) return;
                if (narrativeRef.current && narrativeRef.current.scrollHeight > narrativeRef.current.clientHeight + 4) {
                  narrativeRef.current.scrollTo({ top: fb.top, behavior: 'smooth' });
                } else {
                  window.scrollTo({ top: fb.windowY, behavior: 'smooth' });
                }
              });
            });
          }
        }
        return;
      }

      if (qteRevealTimerRef.current) {
        clearTimeout(qteRevealTimerRef.current);
        qteRevealTimerRef.current = null;
      }
      if (qteRevealCleanupRef.current) {
        qteRevealCleanupRef.current();
        qteRevealCleanupRef.current = null;
      }
      pendingQteRevealKeysRef.current = null;
      skipNextTopResetRef.current = false;
      if (deferredRevealKeys.size > 0) setDeferredRevealKeys(new Set());
      if (highlightedRevealKeys.size > 0) setHighlightedRevealKeys(new Set());
      setPendingScrollDomId(null);
      return;
    }

    const newlyAdded = currentRevealItems.filter((it) => !snap.keys.has(it.key));
    prevRevealSnapshotRef.current = {
      projectId: projId,
      sceneId,
      historyLen: histLen,
      keys: currentKeySet,
    };

    const hasBlockingModal = !!(modalFeedback || modalQueue.length > 0 || activeDialogue);

    if (hasBlockingModal) {
      if (newlyAdded.length > 0) {
        setDeferredRevealKeys((prev) => {
          const next = new Set(prev);
          newlyAdded.forEach((it) => next.add(it.key));
          return next;
        });
      }
      return;
    }

    const readyKeys = new Set<string>(deferredRevealKeys);
    newlyAdded.forEach((it) => readyKeys.add(it.key));

    if (readyKeys.size > 0) {
      const readyList = Array.from(readyKeys);
      const firstReady =
        currentRevealItems.find((it) => readyKeys.has(it.key) && it.hasContent) ||
        currentRevealItems.find((it) => readyKeys.has(it.key));

      if (deferredRevealKeys.size > 0 && pendingQteRevealKeysRef.current) {
        // Already deferred for QTE return scroll; keep waiting until scroll settles
        return;
      }

      if (deferredRevealKeys.size > 0) {
        setDeferredRevealKeys(new Set());
      }
      setHighlightedRevealKeys((prev) => {
        const next = new Set(prev);
        readyList.forEach((k) => next.add(k));
        return next;
      });
      if (firstReady) {
        pendingScrollModeRef.current = 'reveal';
        setPendingScrollDomId(firstReady.domId);
      }
    }
  }, [
    project?.id,
    currentScene,
    gameState.currentSceneId,
    gameState.flags,
    gameState.inventory,
    gameState.appendedTextsPerScene,
    gameState.history?.length,
    modalFeedback,
    modalQueue.length,
    activeDialogue,
  ]);

  useEffect(() => {
    if (highlightedRevealKeys.size === 0) return;
    const timer = setTimeout(() => {
      setHighlightedRevealKeys(new Set());
    }, 1800);
    return () => clearTimeout(timer);
  }, [highlightedRevealKeys]);

  useEffect(() => {
    if (!pendingScrollDomId) return;
    let raf1 = 0;
    let raf2 = 0;
    const targetDomId = pendingScrollDomId;
    const mode = pendingScrollModeRef.current;
    const qteKeys = pendingQteRevealKeysRef.current;
    pendingQteRevealKeysRef.current = null;

    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const el = document.getElementById(targetDomId);
        setPendingScrollDomId(null);

        if (!el) {
          if (qteKeys && qteKeys.length > 0) {
            setDeferredRevealKeys(new Set());
            setHighlightedRevealKeys(new Set(qteKeys));
          }
          return;
        }

        scrollToRevealedElement(el, mode);

        // Re-center if remounted images shift layout while scrolling, and synchronize QTE reveal animation with viewport arrival
        if (qteRevealCleanupRef.current) {
          qteRevealCleanupRef.current();
          qteRevealCleanupRef.current = null;
        }

        const container = narrativeRef.current;
        const isContainerScrollable =
          container &&
          container.scrollHeight > container.clientHeight + 4 &&
          ['auto', 'scroll'].includes(window.getComputedStyle(container).overflowY);

        let revealed = false;
        let inView = false;
        let minTimePassed = false;
        let settleDelayTimer: ReturnType<typeof setTimeout> | null = null;
        let minTimer: ReturnType<typeof setTimeout> | null = null;
        let maxTimer: ReturnType<typeof setTimeout> | null = null;
        let layoutWatchTimer: ReturnType<typeof setTimeout> | null = null;
        let io: IntersectionObserver | null = null;
        let ro: ResizeObserver | null = null;
        const imgListeners: { img: HTMLImageElement; fn: () => void }[] = [];

        const stopLayoutWatch = () => {
          if (ro) {
            ro.disconnect();
            ro = null;
          }
          imgListeners.forEach(({ img, fn }) => img.removeEventListener('load', fn));
          imgListeners.length = 0;
          if (layoutWatchTimer) {
            clearTimeout(layoutWatchTimer);
            layoutWatchTimer = null;
          }
        };

        const cleanupAll = () => {
          stopLayoutWatch();
          if (io) {
            io.disconnect();
            io = null;
          }
          if (settleDelayTimer) {
            clearTimeout(settleDelayTimer);
            settleDelayTimer = null;
          }
          if (minTimer) {
            clearTimeout(minTimer);
            minTimer = null;
          }
          if (maxTimer) {
            clearTimeout(maxTimer);
            maxTimer = null;
          }
          if (qteRevealCleanupRef.current === cleanupAll) {
            qteRevealCleanupRef.current = null;
          }
        };

        const flushReveal = () => {
          if (revealed) return;
          revealed = true;
          if (io) {
            io.disconnect();
            io = null;
          }
          if (settleDelayTimer) {
            clearTimeout(settleDelayTimer);
            settleDelayTimer = null;
          }
          if (minTimer) {
            clearTimeout(minTimer);
            minTimer = null;
          }
          if (maxTimer) {
            clearTimeout(maxTimer);
            maxTimer = null;
          }
          if (qteKeys && qteKeys.length > 0) {
            setDeferredRevealKeys(new Set());
            setHighlightedRevealKeys(new Set(qteKeys));
          }
        };

        const maybeFlush = () => {
          if (revealed || !inView || !minTimePassed) return;
          if (settleDelayTimer) return;
          settleDelayTimer = setTimeout(flushReveal, 60);
        };

        if (container) {
          let initialHeight = container.scrollHeight;
          const handleShift = () => {
            if (!document.body.contains(el)) return;
            scrollToRevealedElement(el, mode);
          };
          if (typeof ResizeObserver !== 'undefined') {
            ro = new ResizeObserver(() => {
              if (Math.abs(container.scrollHeight - initialHeight) > 8) {
                initialHeight = container.scrollHeight;
                handleShift();
              }
            });
            ro.observe(container);
          }
          const imgs = container.querySelectorAll('img');
          imgs.forEach((img) => {
            if (!img.complete) {
              const onLoad = () => handleShift();
              img.addEventListener('load', onLoad, { once: true });
              imgListeners.push({ img, fn: onLoad });
            }
          });
          layoutWatchTimer = setTimeout(stopLayoutWatch, 750);
        }

        if (qteKeys && qteKeys.length > 0) {
          if (typeof IntersectionObserver !== 'undefined') {
            io = new IntersectionObserver(
              (entries) => {
                if (entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.08)) {
                  inView = true;
                  maybeFlush();
                }
              },
              {
                root: isContainerScrollable ? container : null,
                threshold: [0.08, 0.25],
              }
            );
            io.observe(el);
          } else {
            inView = true;
          }
          minTimer = setTimeout(() => {
            minTimePassed = true;
            maybeFlush();
          }, 160);
          maxTimer = setTimeout(flushReveal, 650);
        }

        qteRevealCleanupRef.current = () => {
          revealed = true;
          cleanupAll();
        };
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [pendingScrollDomId]);

  useEffect(() => {
    if (!currentScene?.qteConfig || qteStepIndex <= 0) return;
    if (qteStatus !== 'active' && qteStatus !== 'success') return;
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const anchor = narrativeRef.current?.querySelector('[data-qte-latest="true"]') as HTMLElement | null;
        if (anchor) {
          ensureQteRevealVisible(anchor);
        }
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [qteStepIndex, qteStatus, gameState.currentSceneId]);

  useEffect(() => {
    if (qteStatus !== 'active' || !currentScene?.qteConfig) return;

    const interval = setInterval(() => {
      setQteTimeLeft((prev) => {
        if (prev <= 0.1) {
          clearInterval(interval);
          handleQTEFail('¡Tiempo agotado!');
          return 0;
        }
        return +(prev - 0.1).toFixed(1);
      });
    }, 100);

    return () => clearInterval(interval);
  }, [qteStatus, gameState.currentSceneId, currentScene?.id]);

  const handleQTEFail = (reasonMsg?: string) => {
    setQteStatus('failed');
    playSound('error');
    const config = currentScene?.qteConfig;
    const failMsg = reasonMsg || config?.onFailMessage || '¡No lograste reaccionar a tiempo!';

    if (config?.onFailFlag || config?.isFailGameOver) {
      setGameState((prev: any) => ({
        ...prev,
        ...(config?.onFailFlag
          ? {
              flags: {
                ...prev.flags,
                [config.onFailFlag]: true,
              },
            }
          : {}),
        ...(config?.isFailGameOver ? { isGameOver: true } : {}),
      }));
    }

    if (config?.isFailGameOver) {
      setModalFeedback({
        type: 'gameover',
        title: 'Fin de partida',
        verbIconName: 'Skull',
        isGameOver: true,
        message: failMsg,
      });
    } else if (config?.onFailSceneId) {
      setModalFeedback({
        type: 'action',
        title: 'Tiempo agotado',
        verbIconName: 'Clock',
        message: failMsg,
        onClose: () => {
          setGameState((prev: any) => ({
            ...prev,
            currentSceneId: config.onFailSceneId,
          }));
        },
      });
    } else {
      setModalFeedback({
        type: 'action',
        title: 'Tiempo agotado',
        verbIconName: 'Clock',
        message: failMsg,
      });
    }
  };

  const handleQTESuccess = () => {
    setQteStatus('success');
    playSound('pickup');
    const config = currentScene?.qteConfig;
    const successMsg = config?.onSuccessMessage?.trim() || 'Has completado la secuencia a tiempo.';

    if (config?.onSuccessFlag) {
      setGameState((prev: any) => ({
        ...prev,
        flags: {
          ...prev.flags,
          [config.onSuccessFlag!]: true,
        },
      }));
    }

    // Entrega única: si este evento ya se superó antes (aunque el jugador haya gastado los objetos),
    // no se vuelven a entregar al repetirlo o al volver a la escena.
    const qteKey = deliveryKey(currentScene?.id, 'qte');
    const qteAlreadyDelivered = (gameState.deliveredRuleKeys || []).includes(qteKey);
    const itemIdsToGrant = qteAlreadyDelivered ? [] : (config?.onSuccessItemIds || []).filter(Boolean);
    if (itemIdsToGrant.length > 0) {
      setGameState((prev: any) => {
        if ((prev.deliveredRuleKeys || []).includes(qteKey)) return prev;
        return {
          ...prev,
          inventory: [...(prev.inventory || []), ...itemIdsToGrant],
          deliveredRuleKeys: [...(prev.deliveredRuleKeys || []), qteKey],
        };
      });
    }

    const itemsToGrant = itemIdsToGrant
      .map((id) => project.inventoryItems.find((it) => it.id === id))
      .filter((it): it is InventoryItem => !!it);

    const targetSceneId = config?.onSuccessSceneId;
    const transitionAction = targetSceneId
      ? () => {
          setGameState((prev: any) => ({
            ...prev,
            currentSceneId: targetSceneId,
          }));
        }
      : undefined;

    const modalsToShow: {
      type: 'action' | 'item' | 'gameover';
      title?: string;
      verbIconName?: string;
      isAutosaved?: boolean;
      isGameOver?: boolean;
      itemImageUrl?: string;
      message: string;
      onClose?: () => void;
    }[] = [];

    // 1. Success message (author's custom message for overcoming the scene, without emojis/icons)
    if (successMsg) {
      modalsToShow.push({
        type: 'action',
        title: 'Evento superado',
        message: successMsg,
        onClose: itemsToGrant.length === 0 ? transitionAction : undefined,
      });
    }

    // 2. Respective messages for each received object (same as normal scene pickups)
    itemsToGrant.forEach((item, index) => {
      const isLast = index === itemsToGrant.length - 1;
      modalsToShow.push({
        type: 'item',
        title: item.name,
        verbIconName: 'Hand',
        itemImageUrl: item.imageFileData || item.imageUrl,
        isAutosaved: true,
        message: `¡Has conseguido: ${item.name}!`,
        onClose: isLast ? transitionAction : undefined,
      });
    });

    if (modalsToShow.length > 0) {
      queueModals(modalsToShow);
    } else if (transitionAction) {
      transitionAction();
    }
  };

  const checkConditions = (visibleFlags?: Record<string, boolean>, hiddenFlags?: Record<string, boolean>) => {
    if (visibleFlags) {
      for (const [k, v] of Object.entries(visibleFlags)) {
        if (!!gameState.flags[k] !== !!v) return false;
      }
    }
    if (hiddenFlags) {
      for (const [k, v] of Object.entries(hiddenFlags)) {
        if (!!gameState.flags[k] === !!v) return false;
      }
    }
    return true;
  };

  const isSceneGameOver = isStateGameOverOrEnding(
    currentScene,
    gameState.flags || {},
    gameState.inventory || [],
    currentScene ? gameState.appendedTextsPerScene?.[currentScene.id] : undefined,
    gameState.isGameOver
  );

  // Guardar punto seguro previo a cualquier muerte o final para permitir "Reintentar"
  useEffect(() => {
    if (checkpointProjectIdRef.current !== project.id) {
      checkpointProjectIdRef.current = project.id;
      safeCheckpointRef.current = null;
    }
    if (!isSceneGameOver && !modalFeedback?.isGameOver && currentScene) {
      safeCheckpointRef.current = cloneGameState(gameState);
    }
  }, [
    project.id,
    currentScene,
    isSceneGameOver,
    modalFeedback?.isGameOver,
    gameState.currentSceneId,
    gameState.inventory,
    gameState.flags,
    gameState.appendedTextsPerScene,
    gameState.usedHotspotIds,
    gameState.deliveredRuleKeys,
    gameState.history?.length,
    gameState.difficulty,
    gameState.isGameOver,
  ]);

  const handleRetryBeforeDeath = () => {
    playSound('select');
    if (qteRevealCleanupRef.current) {
      qteRevealCleanupRef.current();
      qteRevealCleanupRef.current = null;
    }
    pendingQteRevealKeysRef.current = null;
    lastClickedContainerIdRef.current = null;
    setActiveVerb(null);
    setSelectedInventoryItemId(null);
    setContextMenu(null);
    setActiveDialogue(null);
    setModalFeedback(null);
    setModalQueue([]);
    setQteMistakeMsg(null);

    const checkpoint = safeCheckpointRef.current;
    if (checkpoint) {
      const restored = cloneGameState(checkpoint);
      restored.isGameOver = false;
      if (qteReturnAnchorRef.current?.qteSceneId !== restored.currentSceneId) {
        qteReturnAnchorRef.current = null;
      }
      const sameScene = restored.currentSceneId === gameState.currentSceneId;
      setGameState(restored);

      if (sameScene && currentScene && (currentScene.type === 'qte' || currentScene.qteConfig) && currentScene.qteConfig?.sequence?.length) {
        setQteTimeLeft(currentScene.qteConfig.timeLimitSeconds || 10);
        setQteStepIndex(0);
        setQteStatus('active');
      }

      setRetryToast('Has vuelto a la escena anterior');
      setTimeout(() => setRetryToast(null), 2600);
      return;
    }
    qteReturnAnchorRef.current = null;

    if (!isSceneTesting) {
      try {
        const autosaveStr = localStorage.getItem(`text_adventure_save_slot_${project.id}_autosave`);
        if (autosaveStr) {
          const slot = JSON.parse(autosaveStr) as SaveSlotData;
          const targetScene = project.scenes.find((s) => s.id === slot.currentSceneId);
          if (
            targetScene &&
            !isStateGameOverOrEnding(
              targetScene,
              slot.flags || {},
              slot.inventoryItemIds || [],
              slot.appendedTextsPerScene?.[slot.currentSceneId],
              false
            )
          ) {
            setGameState({
              currentSceneId: slot.currentSceneId,
              inventory: slot.inventoryItemIds || [],
              flags: slot.flags || {},
              history: slot.narrativeHistory || [],
              appendedTextsPerScene: slot.appendedTextsPerScene || {},
              usedHotspotIds: slot.usedHotspotIds || [],
              deliveredRuleKeys: slot.deliveredRuleKeys || [],
              difficulty: slot.difficulty || 'facil',
              isGameOver: false,
            });
            setRetryToast('Autoguardado anterior restaurado');
            setTimeout(() => setRetryToast(null), 2600);
            return;
          }
        }
      } catch {
        // Sin autoguardado válido disponible
      }
    }

    onReset();
  };

  const handleConfirmExitGame = () => {
    setShowExitConfirmModal(false);
    setModalFeedback(null);
    setModalQueue([]);
    setActiveDialogue(null);
    setContextMenu(null);
    stopAllAudio();
    if (onExit) {
      onExit();
    } else {
      onReset();
    }
  };

  const isGoodEndingReached =
    !isSceneTesting &&
    !gameState.isGameOver &&
    (
      currentScene?.type === 'final' ||
      (currentScene?.textBlocks || []).some((b) => {
        if (b.type !== 'final' || b.isGameOver) return false;
        if (!checkConditions(b.visibleIfFlags, b.hiddenIfFlags)) return false;
        const reqItems = b.requiredItemIds || (b.requiredItemId ? [b.requiredItemId] : []);
        if (reqItems.length > 0 && !reqItems.every((id) => gameState.inventory.includes(id))) {
          return false;
        }
        return true;
      })
    );

  useEffect(() => {
    if (isGoodEndingReached) {
      markStoryCompleted(project.id, project.title);
    }
  }, [isGoodEndingReached, project.id, project.title]);

  const handleSelectVerb = (verb: VerbType) => {
    playSound('select');
    if (activeVerb === verb) {
      setActiveVerb(null);
    } else {
      setActiveVerb(verb);
    }
  };

  const handleSelectInventoryItem = (itemId: string) => {
    playSound('select');
    const targetItem = project.inventoryItems.find((i) => i.id === itemId);
    if (!targetItem) return;

    if (selectedInventoryItemId === itemId) {
      // If clicking the same item while 'usar' is active or it has a direct effect, use it!
      if (activeVerb === 'usar' && targetItem.useEffectAction) {
        handleUseInventoryItemDirectly(targetItem);
        return;
      }
      setSelectedInventoryItemId(null);
      return;
    }

    if (selectedInventoryItemId && selectedInventoryItemId !== itemId) {
      const sourceItemId = selectedInventoryItemId;
      const sourceItem = project.inventoryItems.find((i) => i.id === sourceItemId);

      let rule = (targetItem.combinations || []).find((c) => c.requiredItemId === sourceItemId);
      if (!rule && sourceItem) {
        rule = (sourceItem.combinations || []).find((c) => c.requiredItemId === targetItem.id);
      }

      let flagsMatch = true;
      if (rule?.requiredFlags) {
        flagsMatch = Object.entries(rule.requiredFlags).every(([flagKey, expectedVal]) => {
          return !!gameState.flags[flagKey] === expectedVal;
        });
      }

      // No se puede combinar si faltan unidades de lo que la combinación gasta
      const comboMissing = rule && flagsMatch ? missingItems(rule.stateChange, gameState.inventory) : {};
      const comboAffordable = Object.keys(comboMissing).length === 0;

      if (rule && flagsMatch && comboAffordable) {
        const sc = rule.stateChange;
        const isGameOverCombo = !!rule.isGameOver || !!sc?.isGameOver;
        const soundToPlay = rule.soundEffect || 'pickup';
        playSound(soundToPlay, project.customSounds);
        if (sc?.goToSceneId) {
          captureQteReturnAnchor(sc.goToSceneId);
        }

        setGameState((prev: any) => {
          const newFlags = { ...prev.flags, ...(sc?.setFlags || {}) };
          let newInventory = [...prev.inventory];
          let nextSceneId = prev.currentSceneId;

          // Combinar objetos no es una entrega de escena: no lleva la protección anti-duplicados.
          // Gasta primero (con las cantidades indicadas) y entrega después.
          Object.entries(getRemovals(sc)).forEach(([id, count]) => {
            for (let i = 0; i < count; i++) {
              const idx = newInventory.indexOf(id);
              if (idx !== -1) newInventory.splice(idx, 1);
            }
          });
          Object.entries(getGrants(sc)).forEach(([id, count]) => {
            for (let i = 0; i < count; i++) newInventory.push(id);
          });

          if (sc?.goToSceneId) {
            nextSceneId = sc.goToSceneId;
          }

          return {
            ...prev,
            flags: newFlags,
            inventory: newInventory,
            currentSceneId: nextSceneId,
            isGameOver: prev.isGameOver || isGameOverCombo,
          };
        });

        setSelectedInventoryItemId(null);
        setActiveVerb(null);

        setModalFeedback({
          type: isGameOverCombo ? 'gameover' : 'item',
          title: `🧩 ${targetItem.name} + ${sourceItem?.name || ''}`,
          verbIconName: isGameOverCombo ? 'Skull' : 'Sparkles',
          isGameOver: isGameOverCombo,
          itemImageUrl: targetItem.imageFileData || targetItem.imageUrl || sourceItem?.imageFileData || sourceItem?.imageUrl,
          message: rule.responseMessage || 'Has combinado los objetos con éxito.',
        });
        return;
      }

      setSelectedInventoryItemId(null);
      setActiveVerb(null);

      if (rule && !flagsMatch && rule.failMessage) {
        setModalFeedback({
          type: 'item',
          title: 'Combinación no disponible',
          verbIconName: 'Info',
          message: rule.failMessage,
        });
      } else if (rule && flagsMatch && !comboAffordable) {
        const missingText = Object.entries(comboMissing)
          .map(([id, n]) => `${n}x ${project.inventoryItems.find((i) => i.id === id)?.name || id}`)
          .join(', ');
        setModalFeedback({
          type: 'item',
          title: 'Combinación no disponible',
          verbIconName: 'Info',
          message: rule.failMessage || `No tienes suficientes unidades. Te faltan: ${missingText}.`,
        });
      } else {
        setModalFeedback({
          type: 'item',
          title: 'Sin efecto',
          verbIconName: 'Info',
          message: `No parece ocurrir nada al usar ${sourceItem?.name || 'este objeto'} con ${targetItem.name}.`,
        });
      }
      return;
    }

    // If activeVerb is 'usar' and this item has a direct use effect: execute it immediately!
    if (activeVerb === 'usar' && targetItem.useEffectAction) {
      handleUseInventoryItemDirectly(targetItem);
      return;
    }

    setSelectedInventoryItemId(itemId);

    // If activeVerb is 'mirar', show the modal popup with item description
    if (activeVerb === 'mirar') {
      const isItemGameOver = !!targetItem.isGameOver || /\[Terminar|\[Cargar partida|\[Fin de partida\]/i.test(targetItem.description || '');
      const rawDesc = targetItem.description || 'Sin descripción adicional.';
      const cleanDesc = rawDesc.replace(/\[(?:Terminar \/ Cargar partida|Terminar|Cargar partida|Fin de partida)\]/gi, '').trim();

      setModalFeedback({
        type: isItemGameOver ? 'gameover' : 'item',
        title: targetItem.name,
        verbIconName: isItemGameOver ? 'Skull' : 'Eye',
        isGameOver: isItemGameOver,
        itemImageUrl: targetItem.imageFileData || targetItem.imageUrl,
        message: cleanDesc,
      });
    } else {
      // If activeVerb is 'usar' or any other verb (or no verb selected):
      // Set activeVerb to 'usar' so sentence bar reads "Usar [nombre de objeto] con"
      setActiveVerb('usar');
      // Do NOT show the modal feedback popup with object information!
    }
  };

  const handleUseInventoryItemDirectly = (targetItem: InventoryItem) => {
    playSound('select');
    const rule = targetItem.useEffectAction;

    if (!rule) {
      setModalFeedback({
        type: 'item',
        title: targetItem.name,
        verbIconName: 'Info',
        itemImageUrl: targetItem.imageFileData || targetItem.imageUrl,
        message: `No parece que puedas usar ${targetItem.name} por sí solo. Prueba a usarlo con alguna palabra interactiva de la escena o a combinarlo con otro objeto.`,
      });
      return;
    }

    let flagsMatch = true;
    if (rule.requiredFlags) {
      flagsMatch = Object.entries(rule.requiredFlags).every(([flagKey, expectedVal]) => {
        return !!gameState.flags[flagKey] === expectedVal;
      });
    }

    if (!flagsMatch) {
      playSound('error');
      setModalFeedback({
        type: 'item',
        title: targetItem.name,
        verbIconName: 'Info',
        itemImageUrl: targetItem.imageFileData || targetItem.imageUrl,
        message: rule.failMessage || 'No se cumplen las condiciones para usar este objeto en este momento.',
      });
      return;
    }

    // Effect conditions met!
    const sc = rule.stateChange;
    const isGameOverUse = !!rule.isGameOver || !!sc?.isGameOver;
    const soundToPlay = rule.soundEffect || 'pickup';
    playSound(soundToPlay, project.customSounds);
    if (sc?.goToSceneId) {
      captureQteReturnAnchor(sc.goToSceneId);
    }

    setGameState((prev: any) => {
      const newFlags = { ...prev.flags, ...(sc?.setFlags || {}) };
      let newInventory = [...prev.inventory];
      let nextSceneId = prev.currentSceneId;

      // Usar un objeto del inventario no es una entrega de escena: no lleva la protección anti-duplicados
      if (sc?.addItems && Object.keys(sc.addItems).length > 0) {
        Object.entries(sc.addItems).forEach(([id, qty]) => {
          const count = Math.max(0, Math.floor(Number(qty) || 0));
          for (let i = 0; i < count; i++) {
            newInventory.push(id);
          }
        });
      } else if (sc?.addItemId) {
        newInventory.push(sc.addItemId);
      }

      if (sc?.removeItems && Object.keys(sc.removeItems).length > 0) {
        Object.entries(sc.removeItems).forEach(([id, qty]) => {
          const count = Math.max(0, Math.floor(Number(qty) || 0));
          for (let i = 0; i < count; i++) {
            const idx = newInventory.indexOf(id);
            if (idx !== -1) newInventory.splice(idx, 1);
          }
        });
      } else if (sc?.removeItemId) {
        const idx = newInventory.indexOf(sc.removeItemId);
        if (idx !== -1) newInventory.splice(idx, 1);
      }
      if (sc?.goToSceneId) {
        nextSceneId = sc.goToSceneId;
      }

      let newAppended = { ...(prev.appendedTextsPerScene || {}) };
      if (sc?.appendStoryText && nextSceneId) {
        const currentList = newAppended[nextSceneId] || [];
        if (!currentList.some((t: any) => (typeof t === 'string' ? t : t.text) === sc.appendStoryText)) {
          newAppended = {
            ...newAppended,
            [nextSceneId]: [...currentList, { text: sc.appendStoryText }],
          };
        }
      }

      return {
        ...prev,
        flags: newFlags,
        inventory: newInventory,
        currentSceneId: nextSceneId,
        appendedTextsPerScene: newAppended,
        isGameOver: prev.isGameOver || isGameOverUse,
      };
    });

    setSelectedInventoryItemId(null);
    setActiveVerb(null);

    setModalFeedback({
      type: isGameOverUse ? 'gameover' : 'item',
      title: `✨ ${targetItem.name}`,
      verbIconName: isGameOverUse ? 'Skull' : 'Sparkles',
      isGameOver: isGameOverUse,
      itemImageUrl: targetItem.imageFileData || targetItem.imageUrl,
      message: rule.responseMessage || `Has usado ${targetItem.name}.`,
    });
  };

  const handleClearCommand = () => {
    playSound('click');
    setActiveVerb(null);
    setSelectedInventoryItemId(null);
    setContextMenu(null);
  };

  const handleExecuteAction = (hotspot: Hotspot, verbOverride?: VerbType) => {
    const verbToUse = verbOverride || activeVerb || 'mirar';
    playSound('click');

    // If Quick Time Event (QTE) is currently active on this scene
    if (qteStatus === 'active' && currentScene?.qteConfig && currentScene.qteConfig.sequence.length > 0) {
      const expectedStep = currentScene.qteConfig.sequence[qteStepIndex];
      if (expectedStep) {
        const isHotspotMatch = !expectedStep.hotspotId || expectedStep.hotspotId === hotspot.id;
        const isWordMatch = !expectedStep.word || expectedStep.word.toLowerCase() === hotspot.word.toLowerCase();
        const isVerbMatch = !expectedStep.expectedVerb || expectedStep.expectedVerb === verbToUse;

        if ((isHotspotMatch || isWordMatch) && isVerbMatch) {
          setQteMistakeMsg(null);
          const nextStep = qteStepIndex + 1;
          if (nextStep >= currentScene.qteConfig.sequence.length) {
            handleQTESuccess();
          } else {
            setQteStepIndex(nextStep);
            playSound('pickup');
            // Reset timer if per-action mode is active
            if (currentScene.qteConfig.timerMode === 'per_action') {
              setQteTimeLeft(currentScene.qteConfig.timeLimitSeconds || 10);
            }
          }
        } else {
          // Wrong action in QTE sequence -> Penalize time & show inline HUD feedback
          playSound('error');
          const penalty = 2.5;
          setQteMistakeMsg(`⚠️ ¡Acción o verbo incorrecto! (-${penalty}s)`);
          setTimeout(() => setQteMistakeMsg(null), 1800);

          let isTimeOut = false;
          setQteTimeLeft((prev) => {
            const pen = Math.max(0, +(prev - penalty).toFixed(1));
            if (pen <= 0) isTimeOut = true;
            return pen;
          });

          if (isTimeOut || qteTimeLeft - penalty <= 0) {
            handleQTEFail('¡Acción incorrecta y tiempo agotado!');
          }
        }
      }
      // Return early during active QTE so standard useless action modals do not interrupt countdown
      return;
    }

    const verbObj = projectVerbs.find((v) => v.id === verbToUse) || ALL_VERBS.find((v) => v.id === verbToUse);
    const verbIconName = verbObj?.iconName || 'Eye';

    const selectedItemObj = selectedInventoryItemId
      ? project.inventoryItems.find((i) => i.id === selectedInventoryItemId)
      : null;

    const targetWordLabel = hotspot.label || hotspot.word;
    let actionTitle = '';
    if (selectedItemObj) {
      actionTitle = `Usar ${selectedItemObj.name} con ${targetWordLabel}`;
    } else if (verbObj) {
      actionTitle = `${verbObj.label}: ${targetWordLabel}`;
    } else {
      actionTitle = targetWordLabel;
    }

    // Find all action rules for this verb
    const rulesForVerb = hotspot.actions.filter((a) => a.verb === verbToUse);

    // Filter rules that pass all required item, required flags, and visible/hidden flags
    const matchingRules = rulesForVerb.filter((a) => {
      // Check required item
      if (a.requiredItemId) {
        if (verbToUse === 'usar') {
          // Para el verbo "Usar", el jugador debe seleccionar explícitamente ese objeto del inventario y usarlo sobre la palabra
          if (selectedInventoryItemId !== a.requiredItemId) return false;
        } else if (selectedInventoryItemId) {
          if (selectedInventoryItemId !== a.requiredItemId) return false;
        } else {
          if (!gameState.inventory.includes(a.requiredItemId)) return false;
        }
      }
      // Check required flags & conditions
      if (a.requiredFlags && !checkConditions(a.requiredFlags)) return false;
      if (!checkConditions(a.visibleIfFlags, a.hiddenIfFlags)) return false;
      // No se puede gastar más de lo que se tiene: si faltan unidades, la acción no se cumple
      // (pasa a la rama "Si NO cumple requisitos"). Una acción que ya entregó sus objetos no vuelve a gastar.
      const alreadyDone = isDelivered(
        gameState.deliveredRuleKeys,
        a.stateChange,
        deliveryKey(gameState.currentSceneId, hotspot.id, a.id)
      );
      if (!alreadyDone && !canAfford(a.stateChange, gameState.inventory)) return false;
      return true;
    });

    // Sort passing rules so rules with specific required flags/items take precedence over unconditional fallback rules
    const getRuleScore = (r: ActionRule) =>
      (r.requiredFlags ? Object.keys(r.requiredFlags).length : 0) + (r.requiredItemId ? 1 : 0);

    matchingRules.sort((r1, r2) => getRuleScore(r2) - getRuleScore(r1));

    // Priority filter: rules with higher specificity/conditions must ALWAYS take precedence over fallback rules!
    const maxScore = matchingRules.length > 0 ? getRuleScore(matchingRules[0]) : 0;
    const topRules = matchingRules.filter((r) => getRuleScore(r) === maxScore);

    const useKey = `${hotspot.id}_${verbToUse}_${maxScore}`;
    const currentUseCount = gameState.verbUseCounts?.[useKey] || 0;
    const ruleIndex = topRules.length > 0 ? Math.min(currentUseCount, topRules.length - 1) : -1;
    const rule = ruleIndex >= 0 ? topRules[ruleIndex] : null;

    const currentSceneObj = project.scenes.find((s) => s.id === gameState.currentSceneId);
    const currentSceneAppended = gameState.appendedTextsPerScene[gameState.currentSceneId] || [];
    const parentBlock = currentSceneObj?.textBlocks.find((b) => {
      if (isWordMatchInText(hotspot.word, b.text)) return true;
      return currentSceneAppended.some((entry: any) => {
        if (typeof entry !== 'string' && entry.blockId === b.id) {
          return isWordMatchInText(hotspot.word, entry.text);
        }
        return false;
      });
    });

    if (verbToUse === 'hablar' && rule) {
      let dialogueToStart: DialogueBlock | null = rule.dialogue || parentBlock?.dialogue || null;
      let characterToStart: GameCharacter | null =
        (rule.characterId ? project.characters?.find((c) => c.id === rule.characterId) : null) ||
        (dialogueToStart?.characterId ? project.characters?.find((c) => c.id === dialogueToStart.characterId) : null) ||
        (parentBlock?.characterId ? project.characters?.find((c) => c.id === parentBlock.characterId) : null) ||
        null;

      if (!characterToStart) {
        const searchWord = (hotspot.label || hotspot.word).toLowerCase();
        const matchedChar = project.characters?.find((c) =>
          c.name.toLowerCase().includes(searchWord) || searchWord.includes(c.name.toLowerCase())
        );

        if (matchedChar) {
          characterToStart = matchedChar;
          if (!dialogueToStart) {
            const blockWithDialogue = currentSceneObj?.textBlocks.find(
              (b) => b.characterId === matchedChar.id && b.dialogue
            );
            dialogueToStart = blockWithDialogue?.dialogue || null;
          }
        }
      }

      if (dialogueToStart && !characterToStart) {
        const charName = hotspot.label || hotspot.word;
        characterToStart = {
          id: dialogueToStart.characterId || `char_dyn_${hotspot.id}`,
          name: charName.charAt(0).toUpperCase() + charName.slice(1),
          description: 'Personaje de la historia.',
        };
      }

      if (characterToStart && dialogueToStart) {
        handleStartDialogue(characterToStart, dialogueToStart, parentBlock?.id);
        setActiveVerb(null);
        setSelectedInventoryItemId(null);
        setContextMenu(null);
        return;
      }
    }

    let messageToShow: string | null = null;

    if (rule) {
      const sc = rule.stateChange;

      // Identify items that this rule grants
      const itemIdsFromRule: string[] = [];
      if (sc?.addItems && Object.keys(sc.addItems).length > 0) {
        Object.entries(sc.addItems).forEach(([id, qty]) => {
          if (Number(qty) > 0) itemIdsFromRule.push(id);
        });
      } else if (sc?.addItemId) {
        itemIdsFromRule.push(sc.addItemId);
      }

      const firstAddedItemId = itemIdsFromRule[0];
      const itemObj = firstAddedItemId ? project.inventoryItems.find((i) => i.id === firstAddedItemId) : null;
      const hasItemGains = itemIdsFromRule.length > 0;

      // Esta acción de escena ya entregó sus objetos antes (hace un momento o en una visita anterior).
      // Lo que cuenta es la fuente de la entrega, no que el jugador conserve o no el objeto.
      const ruleDeliveryKey = deliveryKey(gameState.currentSceneId, hotspot.id, rule.id);
      const alreadyDelivered = isDelivered(gameState.deliveredRuleKeys, sc, ruleDeliveryKey);

      if (rule.soundEffect && rule.soundEffect !== 'none') {
        playSound(rule.soundEffect, project.customSounds);
      } else if (rule.stateChange?.addItemId && !alreadyDelivered) {
        playSound('pickup');
      } else if (rule.stateChange?.goToSceneId) {
        playSound('door');
      } else {
        playSound('select');
      }

      if (alreadyDelivered) {
        // Player already has the object(s) in inventory:
        // Do not repeat the pickup modal or duplicate the item.
        // Instead, display the object's description extracted from its item card.
        const itemDesc = itemObj?.description?.trim();
        if (itemDesc) {
          messageToShow = itemDesc;
        } else if (rule.responseMessage) {
          messageToShow = rule.responseMessage;
        } else {
          messageToShow = `Ya has recogido ${itemObj?.name || 'este objeto'}.`;
        }
      } else if (rule.stateChange?.appendStoryText) {
        // If action appends text to paragraph, display full paragraph directly in story (no response popup message)
        messageToShow = null;
      } else if (rule.responseMessage) {
        messageToShow = rule.responseMessage;
      } else if (verbToUse === 'hablar' && !rule.stateChange?.goToSceneId && !hasItemGains && !rule.isGameOver && !rule.stateChange?.isGameOver) {
        messageToShow =
          (hotspot.customDefaultResponses && hotspot.customDefaultResponses['hablar']) ||
          (project.defaultResponses && project.defaultResponses['hablar']) ||
          verbObj?.defaultText ||
          'No parece que vaya a responderte.';
      }

      const willPickupItem = hasItemGains && !alreadyDelivered;
      const isRuleGameOver =
        !!rule.isGameOver ||
        !!rule.stateChange?.isGameOver ||
        GAME_OVER_TAG_REGEX.test(rule.responseMessage || '') ||
        GAME_OVER_TAG_REGEX.test(sc?.appendStoryText || '');
      const predictedNextSceneId = sc?.goToSceneId || gameState.currentSceneId;
      const predictedTargetScene = project.scenes.find((s) => s.id === predictedNextSceneId);
      const predictedFlags = { ...gameState.flags, ...(sc?.setFlags || {}) };
      const predictedInv = applyItemEffects([...gameState.inventory], gameState.deliveredRuleKeys, sc, ruleDeliveryKey).inventory;
      const predictedAppended = sc?.appendStoryText && predictedNextSceneId === gameState.currentSceneId
        ? [...(gameState.appendedTextsPerScene[gameState.currentSceneId] || []), { text: sc.appendStoryText }]
        : (gameState.appendedTextsPerScene[predictedNextSceneId] || []);
      const isPredictedTerminal = isStateGameOverOrEnding(
        predictedTargetScene,
        predictedFlags,
        predictedInv,
        predictedAppended,
        !!gameState.isGameOver || isRuleGameOver
      );
      const isAutosaveTriggered = !isSceneTesting && !isPredictedTerminal && (willPickupItem || !!sc?.goToSceneId);
      if (sc?.goToSceneId) {
        captureQteReturnAnchor(sc.goToSceneId, parentBlock?.id);
      }

      setGameState((prev: any) => {
        const newFlags = { ...prev.flags, ...(sc?.setFlags || {}) };
        let newInventory = [...prev.inventory];
        let nextSceneId = prev.currentSceneId;
        const newAppended = { ...prev.appendedTextsPerScene };

        const currentUsedHotspots = prev.usedHotspotIds || [];
        const newUsedHotspots = currentUsedHotspots.includes(hotspot.id)
          ? currentUsedHotspots
          : [...currentUsedHotspots, hotspot.id];

        const newVerbUseCounts = {
          ...(prev.verbUseCounts || {}),
          [useKey]: (prev.verbUseCounts?.[useKey] || 0) + 1,
        };

        // Gasta y entrega con la lógica compartida. Se vuelve a comprobar con el estado más reciente (prev)
        // para que un doble clic rápido no pueda entregar dos veces.
        const itemResult = applyItemEffects(newInventory, prev.deliveredRuleKeys, sc, ruleDeliveryKey);
        newInventory = itemResult.inventory;
        const newDeliveredKeys = itemResult.deliveredRuleKeys;

        if (sc?.appendStoryText) {
          const currentList = newAppended[prev.currentSceneId] || [];
          const parentBlock = currentSceneObj?.textBlocks.find((b) => {
            if (isWordMatchInText(hotspot.word, b.text)) return true;
            return currentList.some((t: any) => {
              if (typeof t !== 'string' && t.blockId === b.id) {
                return isWordMatchInText(hotspot.word, t.text);
              }
              return false;
            });
          });
          const isAlreadyAppended = currentList.some((t) => (typeof t === 'string' ? t : t.text) === sc.appendStoryText);
          if (!isAlreadyAppended) {
            const entryObj: AppendedTextEntry = parentBlock
              ? { text: sc.appendStoryText, blockId: parentBlock.id }
              : { text: sc.appendStoryText };
            newAppended[prev.currentSceneId] = [...currentList, entryObj];
          }
        }

        if (sc?.goToSceneId) {
          nextSceneId = sc.goToSceneId;
        }

        const newHistory = [
          ...prev.history,
          { id: Date.now().toString(), type: 'response', text: messageToShow || rule.responseMessage || 'Acción ejecutada' },
        ];

        const nextIsGameOver = !!(prev.isGameOver || isRuleGameOver);
        const targetSceneObj = project.scenes.find((s) => s.id === nextSceneId);
        const isNextStateTerminal = isStateGameOverOrEnding(
          targetSceneObj,
          newFlags,
          newInventory,
          newAppended[nextSceneId],
          nextIsGameOver
        );

        // Trigger Autosave side-effects ONLY on safe states (never on death / bad ending / scene testing)
        if (isAutosaveTriggered && !isNextStateTerminal) {
          setTimeout(() => {
            setShowSaveNotification(true);
            setTimeout(() => setShowSaveNotification(false), 2400);
          }, 0);

          const autosaveData: SaveSlotData = {
            id: 'autosave',
            timestamp: new Date().toLocaleString('es-ES'),
            gameId: project.id,
            gameTitle: project.title,
            currentSceneId: nextSceneId,
            currentSceneName: targetSceneObj?.name || 'Escena',
            inventoryItemIds: newInventory,
            flags: newFlags,
            narrativeHistory: newHistory,
            appendedTextsPerScene: newAppended,
            usedHotspotIds: newUsedHotspots,
            usedDialogueOptionIds: prev.usedDialogueOptionIds || [],
            deliveredRuleKeys: newDeliveredKeys,
            difficulty: prev.difficulty || 'facil',
          };
          try {
            localStorage.setItem(
              `text_adventure_save_slot_${project.id}_autosave`,
              JSON.stringify(autosaveData)
            );
          } catch (e) {
            console.error('Error in autosave:', e);
          }
        }

        return {
          ...prev,
          flags: newFlags,
          inventory: newInventory,
          currentSceneId: nextSceneId,
          appendedTextsPerScene: newAppended,
          usedHotspotIds: newUsedHotspots,
          deliveredRuleKeys: newDeliveredKeys,
          verbUseCounts: newVerbUseCounts,
          isGameOver: nextIsGameOver,
          history: newHistory,
        };
      });

      if (isRuleGameOver) {
        playSound('error');
        const rawMsg = messageToShow || rule.responseMessage || 'Has alcanzado un desenlace fatal.';
        setModalFeedback({
          type: 'gameover',
          title: 'FIN DE PARTIDA',
          verbIconName: 'Skull',
          isGameOver: true,
          message: rawMsg.replace(/\[(?:Terminar \/ Cargar partida|Terminar|Cargar partida|Fin de partida)\]/gi, '').trim(),
        });
      } else if (willPickupItem && (itemObj || (sc?.addItems && Object.keys(sc.addItems).length > 0))) {
        if (!rule.soundEffect || rule.soundEffect === 'none') {
          playSound('pickup');
        }
        let itemMsg = '';
        if (sc?.addItems && Object.keys(sc.addItems).length > 0) {
          const list = Object.entries(sc.addItems).map(([id, qty]) => {
            const it = project.inventoryItems.find((i) => i.id === id);
            const name = it?.name || id;
            return qty > 1 ? `${qty}x ${name}` : name;
          }).join(', ');
          itemMsg = `¡Has conseguido: ${list}!`;
        } else if (itemObj) {
          itemMsg = `¡Has conseguido: ${itemObj.name}!`;
        }
        setModalFeedback({
          type: 'item',
          title: itemObj?.name || 'Objetos recibidos',
          verbIconName: 'Hand',
          isAutosaved: !isSceneTesting && !isPredictedTerminal,
          itemImageUrl: itemObj?.imageFileData || itemObj?.imageUrl,
          message: messageToShow ? `${messageToShow}\n\n${itemMsg}` : itemMsg,
        });
      } else if (messageToShow) {
        setModalFeedback({
          type: 'action',
          title: (alreadyDelivered && itemObj?.name) ? itemObj.name : actionTitle,
          showTitle: alreadyDelivered,
          verbIconName: (alreadyDelivered && !verbIconName) ? 'Eye' : verbIconName,
          itemImageUrl: (alreadyDelivered && itemObj) ? (itemObj.imageFileData || itemObj.imageUrl) : undefined,
          message: messageToShow.replace(/\[(?:Terminar \/ Cargar partida|Terminar|Cargar partida|Fin de partida)\]/gi, '').trim(),
        });
      }

      if (sc?.goToSceneId) {
        playSound('door');
      }
    } else {
      // Fallback response - check if any rule for this verb specifies fail configurations (failMessage, failStateChange, failIsGameOver, failSoundEffect)
      const failedRule = rulesForVerb.find((a) => a.failMessage || a.failStateChange || a.failIsGameOver || a.failSoundEffect);

      let lookCharDesc: string | null = null;
      if (verbToUse === 'mirar') {
        const searchWord = (hotspot.label || hotspot.word).toLowerCase();
        const matchedChar = project.characters?.find((c) =>
          c.name.toLowerCase().includes(searchWord) || searchWord.includes(c.name.toLowerCase())
        );
        if (matchedChar && matchedChar.description) {
          lookCharDesc = matchedChar.description;
        }
      }

      const fallbackText =
        failedRule?.failMessage ||
        lookCharDesc ||
        (hotspot.customDefaultResponses && hotspot.customDefaultResponses[verbToUse]) ||
        (selectedItemObj ? `No parece ocurrir nada al usar ${selectedItemObj.name} con ${hotspot.label || hotspot.word}.` : null) ||
        (project.defaultResponses && project.defaultResponses[verbToUse]) ||
        verbObj?.defaultText ||
        'Eso no parece surtir efecto.';

      const fsc = failedRule?.failStateChange;
      const isFailGameOver =
        !!failedRule?.failIsGameOver ||
        !!fsc?.isGameOver ||
        /\[(?:Terminar \/ Cargar partida|Terminar|Cargar partida|Fin de partida)\]/i.test(failedRule?.failMessage || '');

      if (failedRule?.failSoundEffect && failedRule.failSoundEffect !== 'none') {
        playSound(failedRule.failSoundEffect, project.customSounds);
      } else {
        playSound('error');
      }
      if (fsc?.goToSceneId) {
        captureQteReturnAnchor(fsc.goToSceneId, parentBlock?.id);
      }

      setGameState((prev: any) => {
        const currentUsedHotspots = prev.usedHotspotIds || [];
        const newUsedHotspots = currentUsedHotspots.includes(hotspot.id)
          ? currentUsedHotspots
          : [...currentUsedHotspots, hotspot.id];

        let newFlags = { ...prev.flags, ...(fsc?.setFlags || {}) };
        let newInventory = [...prev.inventory];
        let nextSceneId = prev.currentSceneId;
        const newAppended = { ...prev.appendedTextsPerScene };

        // Las consecuencias del fallo también entregan una sola vez por escena y acción.
        // Aquí el gasto no bloquea nada: ya estamos en la rama de fallo, así que se retira lo que haya.
        const failResult = applyItemEffects(
          newInventory,
          prev.deliveredRuleKeys,
          fsc,
          deliveryKey(prev.currentSceneId, hotspot.id, failedRule?.id, 'fail')
        );
        newInventory = failResult.inventory;
        const newDeliveredKeys = failResult.deliveredRuleKeys;

        if (fsc?.appendStoryText) {
          const currentList = newAppended[prev.currentSceneId] || [];
          const parentBlock = currentSceneObj?.textBlocks.find((b) => {
            if (isWordMatchInText(hotspot.word, b.text)) return true;
            return currentList.some((t: any) => {
              if (typeof t !== 'string' && t.blockId === b.id) {
                return isWordMatchInText(hotspot.word, t.text);
              }
              return false;
            });
          });
          const isAlreadyAppended = currentList.some((t) => (typeof t === 'string' ? t : t.text) === fsc.appendStoryText);
          if (!isAlreadyAppended) {
            const entryObj: AppendedTextEntry = parentBlock
              ? { text: fsc.appendStoryText, blockId: parentBlock.id }
              : { text: fsc.appendStoryText };
            newAppended[prev.currentSceneId] = [...currentList, entryObj];
          }
        }

        if (fsc?.goToSceneId) {
          nextSceneId = fsc.goToSceneId;
        }

        const newHistory = [
          ...prev.history,
          { id: Date.now().toString(), type: 'response', text: fallbackText },
        ];

        return {
          ...prev,
          flags: newFlags,
          inventory: newInventory,
          currentSceneId: nextSceneId,
          appendedTextsPerScene: newAppended,
          usedHotspotIds: newUsedHotspots,
          deliveredRuleKeys: newDeliveredKeys,
          isGameOver: prev.isGameOver || isFailGameOver,
          history: newHistory,
        };
      });

      const cleanMsg = fallbackText.replace(/\[(?:Terminar \/ Cargar partida|Terminar|Cargar partida|Fin de partida)\]/gi, '').trim();

      if (isFailGameOver) {
        setModalFeedback({
          type: 'gameover',
          title: 'FIN DE PARTIDA',
          verbIconName: 'Skull',
          isGameOver: true,
          message: cleanMsg || 'Has alcanzado un desenlace fatal.',
        });
      } else {
        setModalFeedback({
          type: 'action',
          title: actionTitle,
          verbIconName,
          message: cleanMsg,
        });
      }
    }

    // Reset command state
    setActiveVerb(null);
    setSelectedInventoryItemId(null);
    setContextMenu(null);
  };

  const handleWordClick = (hotspot: Hotspot, e: React.MouseEvent) => {
    e.stopPropagation();
    if (isSceneGameOver || gameState.isGameOver || modalFeedback?.isGameOver) return;

    const clickedContainerEl = (e.currentTarget as HTMLElement).closest(
      '[id^="block-"], [id^="unattached-appended-"]'
    );
    lastClickedContainerIdRef.current = clickedContainerEl ? clickedContainerEl.id : null;

    // Fast QTE action: If QTE is active and current step accepts any verb (no expectedVerb specified),
    // clicking the action word directly triggers the action without needing to pick a verb first!
    if (isQTEScene && qteStatus === 'active') {
      const expectedStep = currentScene?.qteConfig?.sequence?.[qteStepIndex];
      if (!expectedStep?.expectedVerb) {
        handleExecuteAction(hotspot, undefined);
        return;
      }
    }

    if (activeVerb) {
      // Direct action execution
      handleExecuteAction(hotspot, activeVerb);
    } else {
      // Show context popover
      const rect = e.currentTarget.getBoundingClientRect();
      setContextMenu({
        hotspotId: hotspot.id,
        word: hotspot.word,
        x: Math.min(rect.left, window.innerWidth - 220),
        y: rect.bottom + 8,
      });
      playSound('select');
    }
  };

  // Render text with highlighted interactive words depending on difficulty mode
  const renderInteractiveText = (text: string) => {
    if (!text) return text;
    if (isSceneGameOver || gameState.isGameOver) return text;
    if (!currentScene || !currentScene.hotspots) return text;

    // Visible hotspots
    const activeHotspots = currentScene.hotspots.filter((h) => {
      if (!h.initialVisible) return false;
      return checkConditions(h.visibleIfFlags, h.hiddenIfFlags);
    });

    if (activeHotspots.length === 0) return text;

    // Create a regex matching any hotspot word with exact word boundaries
    const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const isWordChar = (char: string) => /[\p{L}\p{N}_]/u.test(char);
    const sortedHotspots = [...activeHotspots].sort((a, b) => b.word.length - a.word.length);

    const hotspotPatterns = sortedHotspots.map((h) => {
      const escaped = escapeRegExp(h.word);
      const startChar = h.word.charAt(0);
      const endChar = h.word.charAt(h.word.length - 1);
      const prefix = isWordChar(startChar) ? '(?<![\\p{L}\\p{N}_])' : '';
      const suffix = isWordChar(endChar) ? '(?![\\p{L}\\p{N}_])' : '';
      return `${prefix}${escaped}${suffix}`;
    });

    const pattern = new RegExp(`(${hotspotPatterns.join('|')})`, 'giu');

    const parts = text.split(pattern);
    const isNormalMode = gameState.difficulty === 'normal';
    const isHardMode = gameState.difficulty === 'dificil';
    const usedHotspots = gameState.usedHotspotIds || [];

    return parts.map((part, idx) => {
      const matchedHotspot = sortedHotspots.find(
        (h) => h.word.toLowerCase() === part.toLowerCase()
      );

      if (matchedHotspot) {
        const isUsed = usedHotspots.includes(matchedHotspot.id);

        if (!asistirResaltado && (isHardMode || (isNormalMode && !isUsed))) {
          // Hard mode or Normal mode before being used (and sin ayuda visual): render like standard text, clickable but without highlight or cursor hint
          return (
            <span
              key={idx}
              onClick={(e) => handleWordClick(matchedHotspot, e)}
              className="inline"
            >
              {part}
            </span>
          );
        } else {
          // Easy mode, OR Normal mode after being used: render highlighted
          return (
            <span
              key={idx}
              role="button"
              tabIndex={0}
              onClick={(e) => handleWordClick(matchedHotspot, e)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleWordClick(matchedHotspot, e as unknown as React.MouseEvent);
                }
              }}
              className={`${themeConfig.hotspotClass} ${themeConfig.hotspotHoverClass} inline cursor-pointer transition-colors duration-150 touch-manipulation py-1`}
              title={`Clic para interactuar con "${matchedHotspot.label || matchedHotspot.word}"`}
              aria-label={`${part}: interactuar con ${matchedHotspot.label || matchedHotspot.word}`}
            >
              {part}
            </span>
          );
        }
      }
      return <React.Fragment key={idx}>{part}</React.Fragment>;
    });
  };

  const handleStartDialogue = (
    character: GameCharacter,
    dialogueBlock: DialogueBlock,
    blockId?: string
  ) => {
    playSound('select');
    const initialNodeId =
      dialogueBlock.initialNodeId ||
      dialogueBlock.nodes?.[0]?.id ||
      'node_root';
    setActiveDialogue({
      character,
      blockId,
      currentNodeId: initialNodeId,
      dialogueBlock,
    });
  };

  const handleSelectDialogueOption = (
    option: DialogueOption,
    character: GameCharacter,
    blockId?: string
  ) => {
    playSound(option.soundEffect || 'select', project.customSounds);

    // Item giving (+Objeto)
    const giveItemObj = option.giveItemId
      ? project.inventoryItems.find((i) => i.id === option.giveItemId)
      : null;

    const dialogueItemIds: string[] = [];
    if (option.giveItems && Object.keys(option.giveItems).length > 0) {
      Object.entries(option.giveItems).forEach(([id, qty]) => {
        if (Number(qty) > 0) dialogueItemIds.push(id);
      });
    } else if (option.giveItemId) {
      dialogueItemIds.push(option.giveItemId);
    }
    // Cada opción de diálogo entrega sus objetos una sola vez por escena (aunque el jugador ya los haya gastado)
    const dialogueDeliveryKey = deliveryKey(gameState.currentSceneId, 'dialogue', option.id);
    const dialogueAlreadyDelivered = dialogueItemIds.length > 0 && (gameState.deliveredRuleKeys || []).includes(dialogueDeliveryKey);

    // Item consuming (-Objeto)
    const consumeItemObj =
      option.requiredItemId && option.consumeRequiredItem
        ? project.inventoryItems.find((i) => i.id === option.requiredItemId)
        : null;

    const shouldInsertTranscript = !!activeDialogue?.dialogueBlock?.insertConversationInStory;

    // Prepare item exchange notices
    let receivedSummary = '';
    if (!dialogueAlreadyDelivered) {
      if (option.giveItems && Object.keys(option.giveItems).length > 0) {
        receivedSummary = Object.entries(option.giveItems)
          .map(([id, qty]) => {
            const item = project.inventoryItems.find((i) => i.id === id);
            const name = item?.name || id;
            return Number(qty) > 1 ? `${qty}x ${name}` : name;
          })
          .join(', ');
      } else if (giveItemObj) {
        receivedSummary = giveItemObj.name;
      }
    }
    const deliveredSummary = consumeItemObj && !dialogueAlreadyDelivered ? consumeItemObj.name : '';

    // Prepare optional story transcript text (only inserted if dialogueBlock.insertConversationInStory is enabled)
    let responseText = '';
    if (shouldInsertTranscript) {
      if (option.playerText) {
        responseText += `— ${option.playerText}\n\n`;
      }
      if (option.npcResponse) {
        responseText += `${character.name}: ${option.npcResponse}`;
      }
      if (receivedSummary) {
        responseText += `\n\n[Recibido: ${receivedSummary}]`;
      }
      if (deliveredSummary) {
        responseText += `\n\n[Entregado: ${deliveredSummary}]`;
      }
    }

    const turnItemNoticeParts: string[] = [];
    if (receivedSummary) turnItemNoticeParts.push(`Recibido: ${receivedSummary}`);
    if (deliveredSummary) turnItemNoticeParts.push(`Entregado: ${deliveredSummary}`);
    const turnItemNotice = turnItemNoticeParts.length > 0 ? turnItemNoticeParts.join(' · ') : undefined;

    // Track items received during this dialogue session
    const currentReceived = activeDialogue?.receivedItemIds || [];
    const itemsToAdd = !dialogueAlreadyDelivered
      ? dialogueItemIds
      : [];
    const updatedReceived = [...currentReceived, ...itemsToAdd];
    if (option.goToSceneId) {
      captureQteReturnAnchor(option.goToSceneId, activeDialogue?.blockId);
    }

    const dlgTargetScene = option.goToSceneId
      ? project.scenes.find((s) => s.id === option.goToSceneId)
      : currentScene;
    const predictedDlgFlags = { ...gameState.flags, ...(option.setFlags || {}) };
    const predictedDlgInv = applyItemEffects(
      [...gameState.inventory],
      gameState.deliveredRuleKeys,
      {
        addItems: option.giveItems,
        addItemId: option.giveItemId,
        removeItemId: option.requiredItemId && option.consumeRequiredItem ? option.requiredItemId : undefined,
      },
      dialogueDeliveryKey
    ).inventory;
    const dlgTargetFatal = !!option.isGameOver || isStateGameOverOrEnding(
      dlgTargetScene,
      predictedDlgFlags,
      predictedDlgInv,
      option.goToSceneId ? gameState.appendedTextsPerScene[option.goToSceneId] : gameState.appendedTextsPerScene[gameState.currentSceneId],
      !!gameState.isGameOver || !!option.isGameOver
    );
    const shouldAutosaveDialogue =
      !isSceneTesting && !dlgTargetFatal && ((!dialogueAlreadyDelivered && dialogueItemIds.length > 0) || !!option.goToSceneId);

    setGameState((prev: any) => {
      const newFlags = { ...prev.flags, ...(option.setFlags || {}) };
      let newInventory = [...prev.inventory];
      let nextSceneId = prev.currentSceneId;

      // Entrega y consumo con la lógica compartida (entrega única por opción y escena)
      const dialogueResult = applyItemEffects(
        newInventory,
        prev.deliveredRuleKeys,
        {
          addItems: option.giveItems,
          addItemId: option.giveItemId,
          removeItemId: option.requiredItemId && option.consumeRequiredItem ? option.requiredItemId : undefined,
        },
        dialogueDeliveryKey
      );
      newInventory = dialogueResult.inventory;
      const newDeliveredKeys = dialogueResult.deliveredRuleKeys;

      if (option.goToSceneId) {
        nextSceneId = option.goToSceneId;
      }

      // Only mark an option as spent when explicitly configured as one-time (isOneTime)
      const usedDialogueOptionIds = [...(prev.usedDialogueOptionIds || [])];
      if (option.isOneTime && !usedDialogueOptionIds.includes(option.id)) {
        usedDialogueOptionIds.push(option.id);
      }

      const newAppended = { ...prev.appendedTextsPerScene };
      if (shouldInsertTranscript && responseText.trim()) {
        const sceneAppended = newAppended[prev.currentSceneId] || [];
        newAppended[prev.currentSceneId] = [
          ...sceneAppended,
          { text: responseText, blockId },
        ];
      }

      if (option.appendStoryText) {
        const sceneAppended = newAppended[prev.currentSceneId] || [];
        const isAlreadyAppended = sceneAppended.some(
          (t: AppendedTextEntry) => (typeof t === 'string' ? t : t.text) === option.appendStoryText
        );
        if (!isAlreadyAppended) {
          newAppended[prev.currentSceneId] = [
            ...sceneAppended,
            { text: option.appendStoryText, blockId },
          ];
        }
      }

      const nextIsGameOver = !!(option.isGameOver || prev.isGameOver);
      const targetSceneObj = project.scenes.find((s) => s.id === nextSceneId);
      const isNextStateTerminal = isStateGameOverOrEnding(
        targetSceneObj,
        newFlags,
        newInventory,
        newAppended[nextSceneId],
        nextIsGameOver
      );

      if (shouldAutosaveDialogue && !isNextStateTerminal) {
        const autosaveData: SaveSlotData = {
          id: 'autosave',
          timestamp: new Date().toLocaleString('es-ES'),
          gameId: project.id,
          gameTitle: project.title,
          currentSceneId: nextSceneId,
          currentSceneName: targetSceneObj?.name || 'Escena',
          inventoryItemIds: newInventory,
          flags: newFlags,
          narrativeHistory: prev.history || [],
          appendedTextsPerScene: newAppended,
          usedHotspotIds: prev.usedHotspotIds || [],
          usedDialogueOptionIds,
          deliveredRuleKeys: newDeliveredKeys,
          difficulty: prev.difficulty || 'facil',
        };
        try {
          localStorage.setItem(
            `text_adventure_save_slot_${project.id}_autosave`,
            JSON.stringify(autosaveData)
          );
        } catch (e) {
          console.error('Error in dialogue autosave:', e);
        }
      }

      return {
        ...prev,
        flags: newFlags,
        inventory: newInventory,
        currentSceneId: nextSceneId,
        usedDialogueOptionIds,
        deliveredRuleKeys: newDeliveredKeys,
        appendedTextsPerScene: newAppended,
        isGameOver: nextIsGameOver,
      };
    });

    // Advance tree node, update current reply, or close dialogue pop-up
    if (option.isGameOver) {
      setActiveDialogue(null);
      playSound('error');
      setModalFeedback({
        type: 'gameover',
        title: 'FIN DE PARTIDA',
        verbIconName: 'Skull',
        isGameOver: true,
        message: option.npcResponse?.trim() || option.appendStoryText?.trim() || 'Has alcanzado un desenlace fatal.',
      });
    } else if (option.endConversation || option.nextNodeId === 'end' || option.goToSceneId) {
      const closingReply =
        !option.goToSceneId && !shouldInsertTranscript && option.npcResponse?.trim()
          ? option.npcResponse.trim()
          : undefined;
      closeActiveDialogue(updatedReceived, closingReply, character);
    } else if (option.nextNodeId && option.nextNodeId !== activeDialogue?.currentNodeId) {
      const nextNode = activeDialogue?.dialogueBlock?.nodes?.find((n) => n.id === option.nextNodeId);
      const replyTrimmed = option.npcResponse?.trim() || '';
      const nextPromptTrimmed = nextNode?.npcPrompt?.trim() || '';
      const combinedReply =
        replyTrimmed && nextPromptTrimmed && nextPromptTrimmed !== replyTrimmed
          ? `${replyTrimmed}\n\n${nextPromptTrimmed}`
          : replyTrimmed || undefined;

      setActiveDialogue((prev) =>
        prev
          ? {
              ...prev,
              currentNodeId: option.nextNodeId!,
              currentNpcReply: combinedReply,
              lastTurnNotice: !shouldInsertTranscript ? turnItemNotice : undefined,
              receivedItemIds: updatedReceived,
            }
          : null
      );
    } else {
      setActiveDialogue((prev) =>
        prev
          ? {
              ...prev,
              currentNpcReply: option.npcResponse?.trim() || undefined,
              lastTurnNotice: !shouldInsertTranscript ? turnItemNotice : undefined,
              receivedItemIds: updatedReceived,
            }
          : null
      );
    }

    if (shouldAutosaveDialogue) {
      setShowSaveNotification(true);
      setTimeout(() => setShowSaveNotification(false), 2500);
    }
  };

  // Parses HTML formatting tags (h1, h2, b, i, u, p, etc.) and renders styled elements while maintaining interactive hotspot words and line breaks
  const renderFormattedAndInteractiveText = (rawText: string) => {
    if (!rawText) return null;

    const normalizedText = rawText.replace(/\r\n/g, '\n');

    if (typeof window === 'undefined' || typeof DOMParser === 'undefined') {
      return (
        <div className="whitespace-pre-line leading-relaxed">
          {renderInteractiveText(normalizedText)}
        </div>
      );
    }

    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(`<div>${normalizedText}</div>`, 'text/html');
      const container = doc.body.firstChild;
      if (!container) {
        return (
          <div className="whitespace-pre-line leading-relaxed">
            {renderInteractiveText(normalizedText)}
          </div>
        );
      }

      const renderNode = (node: Node, keyIndex: string): React.ReactNode => {
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.nodeValue || '';
          return <React.Fragment key={keyIndex}>{renderInteractiveText(text)}</React.Fragment>;
        }

        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as HTMLElement;
          const tagName = el.tagName.toLowerCase();
          const children = Array.from(el.childNodes).map((child, i) =>
            renderNode(child, `${keyIndex}-${i}`)
          );

          switch (tagName) {
            case 'qte-mark':
              return (
                <span key={keyIndex} data-qte-latest="true" aria-hidden="true">
                  &#8203;
                </span>
              );
            case 'h1':
              return (
                <h1 key={keyIndex} className={`text-2xl sm:text-3xl font-extrabold my-3 tracking-tight border-b pb-1 ${isSepia ? 'text-[#822b16] border-[#822b16]/30' : 'text-amber-300 border-amber-500/20'}`}>
                  {children}
                </h1>
              );
            case 'h2':
              return (
                <h2 key={keyIndex} className={`text-xl sm:text-2xl font-bold my-2.5 ${isSepia ? 'text-[#822b16]' : 'text-amber-200'}`}>
                  {children}
                </h2>
              );
            case 'h3':
              return (
                <h3 key={keyIndex} className={`text-lg font-bold my-2 ${isSepia ? 'text-[#5a1d0d]' : 'text-amber-100'}`}>
                  {children}
                </h3>
              );
            case 'b':
            case 'strong':
              return (
                <strong key={keyIndex} className={`font-bold ${isSepia ? 'text-[#3b2d1d]' : 'text-amber-100'}`}>
                  {children}
                </strong>
              );
            case 'i':
            case 'em':
              return (
                <em key={keyIndex} className={`italic ${isSepia ? 'text-[#5a422a]' : 'text-slate-200'}`}>
                  {children}
                </em>
              );
            case 'u':
              return (
                <u key={keyIndex} className={`underline underline-offset-4 ${isSepia ? 'decoration-[#822b16]/60 text-[#822b16]' : 'decoration-amber-500/50'}`}>
                  {children}
                </u>
              );
            case 'p':
              return (
                <p key={keyIndex} className="my-2 leading-relaxed">
                  {children}
                </p>
              );
            case 'br':
              return <br key={keyIndex} />;
            default:
              return <span key={keyIndex}>{children}</span>;
          }
        }

        return null;
      };

      return (
        <div className="whitespace-pre-line leading-relaxed">
          {Array.from(container.childNodes).map((childNode, i) =>
            renderNode(childNode, `root-${i}`)
          )}
        </div>
      );
    } catch (e) {
      console.error('Error parsing formatted text:', e);
      return (
        <div className="whitespace-pre-line leading-relaxed">
          {renderInteractiveText(normalizedText)}
        </div>
      );
    }
  };

  // Parses [Terminar / Cargar partida] or similar bracket tags into interactive End Game action bars
  const renderTextWithTags = (rawText: string, isBlockGameOver?: boolean, isBlockFinal?: boolean) => {
    if (!rawText) return null;

    let processedText = rawText;
    if (isQTEScene) {
      const isFinished = qteStatus === 'success';
      const activeMarkStep = qteStepIndex > 0 && (qteStatus === 'active' || qteStatus === 'success') ? qteStepIndex : 0;
      processedText = filterQTEProgressiveText(rawText, qteStepIndex, isFinished, activeMarkStep);
    } else {
      // In non-QTE scenes, strip [N] tags so they never appear to players
      processedText = rawText
        .replace(/\s+\[\d+\](?=[,.;:!?])/g, '')
        .replace(/\[\d+\][ \t]?/g, '');
    }

    if (!processedText.trim()) return null;

    const tagRegex = /(\[(?:Terminar \/ Cargar partida|Terminar|Cargar partida|Fin de partida)\])/gi;
    const parts = processedText.split(tagRegex);
    const hasTag = /\[(?:Terminar \/ Cargar partida|Terminar|Cargar partida|Fin de partida)\]/i.test(processedText);

    const renderedContent = parts.map((part, index) => {
      const matchTag = part.match(/\[(?:Terminar \/ Cargar partida|Terminar|Cargar partida|Fin de partida)\]/i);
      if (matchTag) {
        const tagText = matchTag[0].toLowerCase();
        const showRestart = tagText.includes('terminar') || tagText.includes('fin');
        const showLoad = tagText.includes('cargar') || tagText.includes('terminar');

        return (
          <div
            key={index}
            className="my-4 p-4 rounded-2xl bg-rose-950/60 border border-rose-500/50 flex flex-wrap items-center justify-between gap-3 shadow-xl backdrop-blur-sm"
          >
            <div className="flex items-center gap-2.5 text-rose-300 font-bold text-xs uppercase tracking-wider">
              <Skull className="w-4 h-4 text-rose-400 shrink-0 animate-pulse" />
              <span>Fin de la Historia</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {showRestart && (
                <button
                  onClick={handleRetryBeforeDeath}
                  title="Volver a la escena anterior a la muerte"
                  className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-xl text-xs font-black transition-all shadow-lg flex items-center gap-1.5 cursor-pointer active:scale-95"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Reintentar</span>
                </button>
              )}
              {showLoad && onOpenSaveLoad && (
                <button
                  onClick={onOpenSaveLoad}
                  className="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 text-white rounded-xl text-xs font-bold transition-all shadow-lg flex items-center gap-1.5 cursor-pointer active:scale-95"
                >
                  <Bookmark className="w-3.5 h-3.5 text-emerald-300" />
                  <span>Cargar partida</span>
                </button>
              )}
              {showRestart && (
                <button
                  onClick={() => setShowExitConfirmModal(true)}
                  title={isSceneTesting ? 'Salir de la prueba y volver al editor' : 'Cerrar partida y salir a la biblioteca'}
                  className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white rounded-xl text-xs font-bold transition-all shadow-lg flex items-center gap-1.5 cursor-pointer active:scale-95"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Terminar</span>
                </button>
              )}
            </div>
          </div>
        );
      }
      return (
        <React.Fragment key={index}>
          {renderFormattedAndInteractiveText(part)}
        </React.Fragment>
      );
    });

    if (isBlockGameOver && !hasTag) {
      return (
        <>
          {renderedContent}
          <div className="my-4 p-4 rounded-2xl bg-rose-950/60 border border-rose-500/50 flex flex-wrap items-center justify-between gap-3 shadow-xl backdrop-blur-sm">
            <div className="flex items-center gap-2.5 text-rose-300 font-bold text-xs uppercase tracking-wider">
              <Skull className="w-4 h-4 text-rose-400 shrink-0 animate-pulse" />
              <span>Fin de la Historia</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={handleRetryBeforeDeath}
                title="Volver a la escena anterior a la muerte"
                className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-xl text-xs font-black transition-all shadow-lg flex items-center gap-1.5 cursor-pointer active:scale-95"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reintentar</span>
              </button>
              {onOpenSaveLoad && (
                <button
                  onClick={onOpenSaveLoad}
                  className="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 text-white rounded-xl text-xs font-bold transition-all shadow-lg flex items-center gap-1.5 cursor-pointer active:scale-95"
                >
                  <Bookmark className="w-3.5 h-3.5 text-emerald-300" />
                  <span>Cargar partida</span>
                </button>
              )}
              <button
                onClick={() => setShowExitConfirmModal(true)}
                title={isSceneTesting ? 'Salir de la prueba y volver al editor' : 'Cerrar partida y salir a la biblioteca'}
                className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white rounded-xl text-xs font-bold transition-all shadow-lg flex items-center gap-1.5 cursor-pointer active:scale-95"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Terminar</span>
              </button>
            </div>
          </div>
        </>
      );
    }

    if (isBlockFinal) {
      const finalTitle = project.gameCompleteTitle?.trim() || '¡FIN DE LA AVENTURA!';
      const finalSubtitle = project.gameCompleteSubtitle?.trim() || 'Has completado felizmente la historia.';

      return (
        <>
          {renderedContent}
          <div className="my-6 p-5 rounded-2xl bg-slate-900 border border-amber-500/40 flex flex-wrap items-center justify-between gap-4 shadow-xl">
            <div>
              <div className="text-base font-black text-amber-300 uppercase tracking-wide">{finalTitle}</div>
              <div className="text-xs text-slate-300 font-normal mt-0.5">{finalSubtitle}</div>
            </div>
            <div className="flex items-center gap-2.5">
              <button
                onClick={onReset}
                className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black rounded-xl text-xs transition-all shadow-lg flex items-center gap-1.5 cursor-pointer active:scale-95"
              >
                <RotateCcw className="w-4 h-4" />
                <span>Volver a jugar</span>
              </button>
              {onOpenSaveLoad && (
                <button
                  onClick={onOpenSaveLoad}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-amber-200 border border-amber-500/30 rounded-xl text-xs font-bold transition-all shadow-md flex items-center gap-1.5 cursor-pointer active:scale-95"
                >
                  <Bookmark className="w-4 h-4 text-amber-400" />
                  <span>Cargar partida</span>
                </button>
              )}
            </div>
          </div>

          {/* 5-Star Story Rating Widget (Visible exclusively upon reaching good ending) */}
          <div className="my-6">
            <StoryRatingWidget
              storyId={project.id || 'current_story'}
              initialAverage={project.ratingAverage}
              initialCount={project.ratingCount}
              theme={isSepia ? 'sepia' : 'dark'}
              onRatingSubmitted={(res) => {
                if (updateProject) {
                  updateProject((p) => ({
                    ...p,
                    ratingAverage: res.ratingAverage,
                    ratingCount: res.ratingCount,
                  }));
                }
              }}
            />
          </div>
        </>
      );
    }

    return renderedContent;
  };

  const getVerbIcon = (iconName: string) => {
    return renderVerbIcon(iconName, 'w-5 h-5');
  };

  // Selected item object
  const selectedItemObj = project.inventoryItems.find((i) => i.id === selectedInventoryItemId);

  return (
    <div className={`min-h-[calc(100vh-60px)] ${themeConfig.bgClass} ${themeConfig.fontFamily} py-6 px-4 transition-colors duration-300`}>
      <div className="max-w-4xl mx-auto flex flex-col gap-5">

        {/* Floating Auto-save & Retry Notification Toasts */}
        <AnimatePresence>
          {showSaveNotification && (
            <motion.div
              initial={{ opacity: 0, y: -20, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -20, scale: 0.9 }}
              className="fixed top-16 right-6 z-50 bg-slate-900/95 border border-emerald-500/40 text-emerald-300 px-3.5 py-2 rounded-xl font-mono text-xs shadow-xl backdrop-blur-md flex items-center gap-2.5"
            >
              <motion.div
                animate={{ rotate: [0, -15, 15, 0], scale: [1, 1.25, 1] }}
                transition={{ repeat: Infinity, duration: 1.8, ease: "easeInOut" }}
              >
                <Save className="w-4 h-4 text-emerald-400" />
              </motion.div>
              <span className="font-bold text-[11px] uppercase tracking-wider text-emerald-300">
                Progreso Autoguardado
              </span>
            </motion.div>
          )}
          {retryToast && (
            <motion.div
              initial={{ opacity: 0, y: -20, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -20, scale: 0.9 }}
              className="fixed top-28 right-6 z-50 bg-slate-900/95 border border-amber-500/50 text-amber-200 px-3.5 py-2 rounded-xl font-mono text-xs shadow-xl backdrop-blur-md flex items-center gap-2.5"
            >
              <RotateCcw className="w-4 h-4 text-amber-400" />
              <span className="font-bold text-[11px] uppercase tracking-wider text-amber-200">
                {retryToast}
              </span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Mobile & Desktop Header Controls when expanded */}
        {!isHeaderCollapsed && (
          <>
            {/* Mobile Top Minimal Bar - Shown ONLY on Portada (Cover scene) */}
            {isPortada && (
              <div className={`md:hidden flex items-center justify-between gap-2 p-2.5 rounded-2xl mb-2 shadow-lg border ${themeConfig.buttonBgClass} ${themeConfig.buttonBorderClass}`}>
                {/* Visual Style Selector Button (Tema) integrated with active theme */}
                <div className="relative flex items-center shrink-0">
                  <div
                    className={`px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all shadow-sm flex items-center gap-1.5 cursor-pointer ${themeConfig.themeButtonClass}`}
                  >
                    <Palette className={`w-3.5 h-3.5 ${themeConfig.accentClass} shrink-0`} />
                    <span>Tema</span>
                    <ChevronDown className="w-3 h-3 ml-0.5 opacity-75 shrink-0" />
                  </div>
                  <select
                    value={currentTheme}
                    onChange={(e) => {
                      if (updateProject) {
                        updateProject((prev) => ({ ...prev, theme: e.target.value as any }));
                      }
                    }}
                    aria-label="Seleccionar tema visual"
                    className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
                  >
                    <option value="sepia-parchment" className={isSepia ? 'bg-[#ebdcb9] text-[#3b2d1d]' : 'bg-slate-900 text-white'}>📜 Pergamino Sepia</option>
                    <option value="classic-retro" className={isSepia ? 'bg-[#ebdcb9] text-[#3b2d1d]' : 'bg-slate-900 text-white'}>🕹️ LucasArts Retro</option>
                    <option value="modern-dark" className={isSepia ? 'bg-[#ebdcb9] text-[#3b2d1d]' : 'bg-slate-900 text-white'}>🌙 Oscuro Elegante</option>
                    <option value="cyber-terminal" className={isSepia ? 'bg-[#ebdcb9] text-[#3b2d1d]' : 'bg-slate-900 text-white'}>💻 Terminal Cyber</option>
                    <option value="emerald-vintage" className={isSepia ? 'bg-[#ebdcb9] text-[#3b2d1d]' : 'bg-slate-900 text-white'}>🌲 Esmeralda Vintage</option>
                  </select>
                </div>

                <div className="flex items-center gap-1.5">
                  {/* Destacar palabras interactivas (Highlighter) */}
                  <button
                    onClick={toggleAsistirResaltado}
                    aria-pressed={asistirResaltado}
                    aria-label="Destacar palabras interactivas"
                    title={asistirResaltado ? 'Resaltado de palabras activado' : 'Destacar palabras interactivas'}
                    className={`p-2 rounded-xl border cursor-pointer transition-colors ${
                      asistirResaltado
                        ? `${themeConfig.verbActiveBg} ${themeConfig.verbActiveText} border-amber-400 shadow`
                        : `${themeConfig.buttonBgClass} ${themeConfig.buttonBorderClass} ${themeConfig.buttonTextClass} ${themeConfig.buttonHoverClass}`
                    }`}
                  >
                    <Highlighter className="w-4 h-4" />
                  </button>

                  {toggleSound && (
                    <button
                      onClick={toggleSound}
                      className={`p-2 rounded-xl border cursor-pointer transition-colors ${themeConfig.buttonBgClass} ${themeConfig.buttonBorderClass} ${themeConfig.buttonTextClass} ${themeConfig.buttonHoverClass}`}
                      title={soundEnabled ? 'Sonido Activado' : 'Sonido Desactivado'}
                      aria-label={soundEnabled ? 'Silenciar sonido' : 'Activar sonido'}
                    >
                      {soundEnabled ? <Volume2 className="w-4 h-4 text-amber-500" /> : <VolumeX className={`w-4 h-4 ${themeConfig.textMutedClass}`} />}
                    </button>
                  )}
                  <button
                    onClick={() => setShowDetailsModal(true)}
                    className={`p-2 rounded-xl border cursor-pointer transition-colors ${
                      isSepia
                        ? 'bg-[#822b16]/15 border-[#822b16]/40 text-[#822b16] hover:bg-[#822b16]/25'
                        : 'bg-amber-500/10 border-amber-500/30 text-amber-400 hover:text-amber-300'
                    }`}
                    title="Detalles y Créditos"
                    aria-label="Detalles y créditos"
                  >
                    <Info className="w-4 h-4" />
                  </button>
                  <button
                    onClick={onReset}
                    className={`p-2 rounded-xl border cursor-pointer transition-colors ${themeConfig.buttonBgClass} ${themeConfig.buttonBorderClass} ${themeConfig.buttonTextClass} ${themeConfig.buttonHoverClass}`}
                    title="Reiniciar historia"
                    aria-label="Reiniciar historia"
                  >
                    <RotateCcw className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}

            {/* Mobile Portada Version & Rating Badge */}
            {isPortada && (
              <div className={`md:hidden flex items-center justify-between px-3 py-1.5 mb-2.5 rounded-xl border ${themeConfig.buttonBgClass} ${themeConfig.buttonBorderClass}`}>
                <span className={`font-mono text-xs ${themeConfig.textMutedClass}`}>
                  v{project.version || '1.0'}
                </span>
                <StarRatingDisplay
                  rating={project.ratingAverage}
                  count={project.ratingCount}
                  size="xs"
                  theme={isSepia ? 'sepia' : 'dark'}
                />
              </div>
            )}

            {/* PC Scene Header with Difficulty Selector */}
            <div className={`hidden md:flex flex-wrap items-center justify-between gap-3 border-b pb-3 ${themeConfig.cardBorderClass}`}>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <Compass className={`w-5 h-5 ${themeConfig.accentClass}`} />
                  <h2 className={`font-bold text-xl ${themeConfig.textMainClass}`}>
                    {currentScene?.name || 'Escena'}
                  </h2>
                </div>

                {isPortada && (
                  <div className={`flex items-center gap-2 px-2.5 py-1 rounded-xl border ${themeConfig.buttonBgClass} ${themeConfig.buttonBorderClass}`}>
                    <span className={`font-mono text-xs ${themeConfig.textMutedClass}`}>
                      v{project.version || '1.0'}
                    </span>
                    <span className="opacity-30">•</span>
                    <StarRatingDisplay
                      rating={project.ratingAverage}
                      count={project.ratingCount}
                      size="xs"
                      theme={isSepia ? 'sepia' : 'dark'}
                    />
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2.5 flex-wrap">
                {/* Audio Toggle Button (In text-game header) */}
                {toggleSound && (
                  <button
                    onClick={toggleSound}
                    className={`p-2 rounded-xl border transition-colors cursor-pointer flex items-center justify-center ${themeConfig.buttonBgClass} ${themeConfig.buttonBorderClass} ${themeConfig.buttonTextClass} ${themeConfig.buttonHoverClass}`}
                    title={soundEnabled ? 'Sonido Activado' : 'Sonido Desactivado'}
                  >
                    {soundEnabled ? <Volume2 className="w-4 h-4 text-amber-500" /> : <VolumeX className={`w-4 h-4 ${themeConfig.textMutedClass}`} />}
                  </button>
                )}

                {/* Visual Style Selector (Test / Play mode) */}
                <div className={`flex items-center gap-1.5 border rounded-xl px-2.5 py-1 text-xs shadow-inner ${themeConfig.buttonBgClass} ${themeConfig.buttonBorderClass}`}>
                  <Palette className={`w-3.5 h-3.5 ${themeConfig.accentClass} shrink-0`} />
                  <select
                    value={currentTheme}
                    onChange={(e) => {
                      if (updateProject) {
                        updateProject((prev) => ({ ...prev, theme: e.target.value as any }));
                      }
                    }}
                    className={`bg-transparent text-xs focus:outline-none cursor-pointer font-medium ${themeConfig.buttonTextClass}`}
                    title="Estilo Visual del Texto-Juego (Modo Prueba)"
                  >
                    <option value="classic-retro" className={isSepia ? 'bg-[#ebdcb9] text-[#3b2d1d]' : 'bg-slate-900 text-white'}>🕹️ LucasArts Retro</option>
                    <option value="modern-dark" className={isSepia ? 'bg-[#ebdcb9] text-[#3b2d1d]' : 'bg-slate-900 text-white'}>🌙 Oscuro Elegante</option>
                    <option value="sepia-parchment" className={isSepia ? 'bg-[#ebdcb9] text-[#3b2d1d]' : 'bg-slate-900 text-white'}>📜 Pergamino Sepia</option>
                    <option value="cyber-terminal" className={isSepia ? 'bg-[#ebdcb9] text-[#3b2d1d]' : 'bg-slate-900 text-white'}>💻 Terminal Cyber</option>
                    <option value="emerald-vintage" className={isSepia ? 'bg-[#ebdcb9] text-[#3b2d1d]' : 'bg-slate-900 text-white'}>🌲 Esmeralda Vintage</option>
                  </select>
                </div>

                {/* Difficulty Selector */}
                <div className={`flex items-center border rounded-xl p-1 text-xs shadow-inner ${themeConfig.buttonBgClass} ${themeConfig.buttonBorderClass}`}>
                  <span className={`text-[10px] uppercase font-mono font-bold ${themeConfig.textMutedClass} px-2 flex items-center gap-1`}>
                    <Shield className={`w-3 h-3 ${themeConfig.accentClass}`} />
                    Modo:
                  </span>
                  <button
                    onClick={() => setGameState((prev: any) => ({ ...prev, difficulty: 'facil' }))}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                      (gameState.difficulty || 'facil') === 'facil'
                        ? `${themeConfig.verbActiveBg} ${themeConfig.verbActiveText} shadow`
                        : `${themeConfig.textMutedClass} ${themeConfig.buttonHoverClass}`
                    }`}
                    title="Modo Fácil: Palabras con acción destacadas siempre"
                  >
                    Fácil
                  </button>
                  <button
                    onClick={() => setGameState((prev: any) => ({ ...prev, difficulty: 'normal' }))}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                      gameState.difficulty === 'normal'
                        ? `${themeConfig.verbActiveBg} ${themeConfig.verbActiveText} shadow`
                        : `${themeConfig.textMutedClass} ${themeConfig.buttonHoverClass}`
                    }`}
                    title="Modo Normal: Palabras sin destacar hasta ser usadas"
                  >
                    Normal
                  </button>
                  <button
                    onClick={() => setGameState((prev: any) => ({ ...prev, difficulty: 'dificil' }))}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                      gameState.difficulty === 'dificil'
                        ? `${themeConfig.verbActiveBg} ${themeConfig.verbActiveText} shadow`
                        : `${themeConfig.textMutedClass} ${themeConfig.buttonHoverClass}`
                    }`}
                    title="Modo Difícil: Las palabras usables no están marcadas ni quedan marcadas tras usarse"
                  >
                    Difícil
                  </button>
                </div>

                <button
                  onClick={() => setShowDetailsModal(true)}
                  className={`text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-xl border transition-colors cursor-pointer ${
                    isSepia
                      ? 'bg-[#822b16]/12 border-[#822b16]/40 text-[#822b16] hover:bg-[#822b16]/20 font-bold'
                      : 'text-amber-300 hover:text-amber-200 bg-amber-500/10 border-amber-500/30'
                  }`}
                  title="Ver detalles, sinopsis y créditos del autor"
                >
                  <Info className={`w-3.5 h-3.5 ${isSepia ? 'text-[#822b16]' : 'text-amber-400'}`} />
                  <span>Detalles y Créditos</span>
                </button>

                <button
                  onClick={onReset}
                  className={`text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-xl border transition-colors cursor-pointer ${themeConfig.buttonBgClass} ${themeConfig.buttonBorderClass} ${themeConfig.buttonTextClass} ${themeConfig.buttonHoverClass}`}
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Reiniciar</span>
                </button>
              </div>
            </div>
          </>
        )}

        {/* Sentence Builder Bar (LucasArts Style Command Bar) - Hidden in final / game-over scenes */}
        {!isSceneGameOver && (
          <div className={`${(activeVerb || selectedItemObj) ? 'flex' : 'hidden md:flex'} p-3 rounded-xl border ${themeConfig.accentBorderClass} ${themeConfig.actionBoxBgClass} items-center justify-between gap-3 shadow-sm`}>
            <div className="flex items-center gap-2 font-bold text-sm sm:text-base tracking-wide flex-wrap">
              <span className={`text-xs font-semibold uppercase tracking-wider ${themeConfig.accentClass}`}>Acción:</span>
              <span className={themeConfig.actionBoxTextClass}>
                {selectedItemObj && activeVerb === 'usar'
                  ? `Usar ${selectedItemObj.name} con`
                  : selectedItemObj && activeVerb === 'mirar'
                  ? `Mirar ${selectedItemObj.name}`
                  : selectedItemObj
                  ? `Usar ${selectedItemObj.name} con`
                  : activeVerb
                  ? (projectVerbs.find((v) => v.id === activeVerb)?.label.toUpperCase() || ALL_VERBS.find((v) => v.id === activeVerb)?.label.toUpperCase() || activeVerb.toUpperCase())
                  : 'SELECCIONAR ACCIÓN...'}
              </span>
              {!activeVerb && !selectedItemObj && (
                <span className={`text-xs font-normal ${themeConfig.textMutedClass} italic hidden sm:inline`}>
                  (Haz clic en un verbo abajo o en una palabra destacada)
                </span>
              )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {(activeVerb || selectedItemObj) && (
                <button
                  onClick={handleClearCommand}
                  className={`px-2.5 py-1 rounded-lg border text-xs transition-colors cursor-pointer ${themeConfig.buttonBgClass} ${themeConfig.buttonBorderClass} ${themeConfig.buttonTextClass} ${themeConfig.buttonHoverClass}`}
                >
                  Cancelar
                </button>
              )}
              {/* Ayuda visual (solo móvil): resalta las palabras interactivas cuando no está el selector de dificultad */}
              <button
                onClick={toggleAsistirResaltado}
                aria-pressed={asistirResaltado}
                aria-label="Resaltar palabras interactivas"
                title={asistirResaltado ? 'Resaltado de palabras activado' : 'Resaltar palabras interactivas'}
                className={`flex md:hidden items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-semibold transition-colors cursor-pointer touch-manipulation ${
                  asistirResaltado
                    ? `${themeConfig.verbActiveBg} ${themeConfig.verbActiveText} border-amber-400`
                    : `${themeConfig.buttonBgClass} ${themeConfig.buttonBorderClass} ${themeConfig.buttonTextClass} ${themeConfig.buttonHoverClass}`
                }`}
              >
                <Highlighter className="w-4 h-4" />
                <span className="hidden sm:inline">Resaltar</span>
              </button>
            </div>
          </div>
        )}

        {/* Quick Time Event (QTE) Live HUD Banner - Sticky outside narrative card so it stays visible while scrolling */}
        {isQTEScene && qteStatus === 'active' && currentScene?.qteConfig && (
          <div
            ref={qteHudRef}
            className={`sticky ${isHeaderCollapsed ? 'top-[46px]' : 'top-[58px]'} z-20 bg-gradient-to-r from-amber-950 via-red-950 to-amber-950 border-2 border-amber-500/80 rounded-2xl p-3.5 sm:p-4 shadow-[0_14px_34px_rgba(0,0,0,0.65)] space-y-2.5 sm:space-y-3 animate-pulse-subtle`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2 text-amber-300 font-black text-xs sm:text-sm uppercase tracking-wider">
              <div className="flex items-center gap-2">
                <Zap className="w-5 h-5 text-amber-400 animate-bounce shrink-0" />
                <span>⚡ QUICK TIME EVENT EN CURSO</span>
              </div>
              <div className={`font-mono text-base sm:text-lg px-3 py-1 rounded-xl border font-black flex items-center gap-1.5 ${
                qteTimeLeft <= 3
                  ? 'bg-rose-600 text-white border-rose-400 animate-ping'
                  : 'bg-black/70 text-amber-300 border-amber-500/50'
              }`}>
                <span>⏱️</span>
                <span>{qteTimeLeft.toFixed(1)}s</span>
                {currentScene.qteConfig.timerMode === 'per_action' && (
                  <span className="text-[10px] text-amber-300/80 font-sans font-bold bg-amber-500/20 px-1.5 py-0.5 rounded border border-amber-500/30 ml-1">
                    / acción
                  </span>
                )}
              </div>
            </div>

            {/* Countdown Progress Bar */}
            <div className="w-full h-3.5 bg-black/70 rounded-full overflow-hidden border border-amber-500/40 p-0.5 shadow-inner">
              <div
                className={`h-full rounded-full transition-all duration-100 ${
                  qteTimeLeft <= 3 ? 'bg-rose-500' : qteTimeLeft <= 6 ? 'bg-amber-400' : 'bg-emerald-400'
                }`}
                style={{
                  width: `${Math.max(0, Math.min(100, (qteTimeLeft / (currentScene.qteConfig.timeLimitSeconds || 10)) * 100))}%`,
                }}
              />
            </div>

            {/* Mistake warning message indicator */}
            {qteMistakeMsg && (
              <div className="bg-rose-600/95 text-white font-bold text-xs px-3 py-1.5 rounded-xl border border-rose-400 shadow-md flex items-center justify-center gap-2 animate-bounce">
                <span>{qteMistakeMsg}</span>
              </div>
            )}

            {/* Step indicator - Centered instruction */}
            <div className="flex flex-col sm:flex-row items-center justify-center gap-2.5 text-xs border-t border-amber-500/20 pt-2.5 text-center">
              <span className="text-amber-200/80 font-medium">
                Paso <strong className="text-amber-300 text-sm font-black">{qteStepIndex + 1}</strong> de {currentScene.qteConfig.sequence.length}
              </span>
              <span className="hidden sm:inline text-amber-500/50">•</span>
              <span className="bg-amber-500/25 text-amber-200 border border-amber-500/50 px-4 py-1.5 rounded-full font-bold shadow-sm text-xs sm:text-sm text-center inline-block">
                {currentScene.qteConfig.sequence[qteStepIndex]?.label || '¡Realiza la acción requerida!'}
              </span>
            </div>
          </div>
        )}

        {/* Main Narrative Card (~60% height in focus mode) */}
        {/* En móvil no se usa scroll anidado: la tarjeta crece y scrollea la página */}
        <div ref={narrativeRef} className={`p-5 sm:p-7 rounded-2xl border ${themeConfig.cardBorderClass} ${themeConfig.cardBgClass} shadow-xl relative overflow-hidden transition-colors ${
          isHeaderCollapsed
            ? (isQTEScene && qteStatus === 'active'
                ? 'md:max-h-[44dvh] md:min-h-[200px] md:overflow-y-auto'
                : 'md:max-h-[58dvh] md:min-h-[260px] md:overflow-y-auto')
            : ''
        }`}>
          {/* Subtle grid pattern background */}
          <div
            className="absolute inset-0 opacity-5 pointer-events-none"
            style={{
              backgroundImage: 'radial-gradient(circle at center, #ffffff 1px, transparent 1px)',
              backgroundSize: '40px 40px',
            }}
          />

          {/* Main Story Text Blocks & Interleaved Appended Paragraphs */}
          <div className={`space-y-6 text-lg leading-relaxed ${themeConfig.textMainClass} relative z-10`}>
            {(() => {
              const sceneAppendedList = gameState.appendedTextsPerScene[gameState.currentSceneId] || [];
              const blockAppendedMap: Record<string, string[]> = {};
              const unattachedAppended: string[] = [];

              sceneAppendedList.forEach((entry) => {
                const txt = typeof entry === 'string' ? entry : entry.text;
                const bId = typeof entry === 'string' ? undefined : entry.blockId;
                if (bId) {
                  if (!blockAppendedMap[bId]) blockAppendedMap[bId] = [];
                  blockAppendedMap[bId].push(txt);
                } else {
                  unattachedAppended.push(txt);
                }
              });

              const hasBlockingModal = !!(modalFeedback || modalQueue.length > 0 || activeDialogue);
              const snap = prevRevealSnapshotRef.current;
              const isSameSceneContext =
                snap.projectId === (project?.id || null) &&
                snap.sceneId === (currentScene?.id || null) &&
                !((gameState.history?.length || 0) === 0 && snap.historyLen > 0);

              const returningAnchor = !isSameSceneContext
                ? resolveQteReturnAnchor(
                    project?.id || null,
                    snap.sceneId,
                    currentScene?.id || null,
                    gameState.history?.length || 0,
                    snap.historyLen,
                    snap.projectId
                  )
                : null;
              const isQteReturningNow = !!returningAnchor;

              const getRevealState = (revealKey: string) => {
                const justAppearedNow = isSameSceneContext && !snap.keys.has(revealKey);
                const justAppearedFromQte =
                  isQteReturningNow && !returningAnchor!.originVisibleKeys.has(revealKey);
                const isPendingReveal =
                  deferredRevealKeys.has(revealKey) ||
                  justAppearedFromQte ||
                  (justAppearedNow && hasBlockingModal);
                const shouldAnimateAppear =
                  !isPendingReveal &&
                  (justAppearedNow ||
                    highlightedRevealKeys.has(revealKey) ||
                    deferredRevealKeys.has(revealKey));
                const isHighlighted = !isPendingReveal && highlightedRevealKeys.has(revealKey);
                return { justAppearedNow, isPendingReveal, shouldAnimateAppear, isHighlighted };
              };

              return (
                <>
                  {currentScene?.textBlocks.map((block, index) => {
                    if (!checkConditions(block.visibleIfFlags, block.hiddenIfFlags)) {
                      return null;
                    }
                    const reqItems = block.requiredItemIds || (block.requiredItemId ? [block.requiredItemId] : []);
                    if (reqItems.length > 0 && !reqItems.every((id) => gameState.inventory.includes(id))) {
                      return null;
                    }
                    const blockImg = block.imageFileData || block.imageUrl;
                    const isPortada = block.type === 'portada' || currentScene?.type === 'portada';
                    const isFinal = block.type === 'final' || (currentScene?.type === 'final' && index === currentScene.textBlocks.length - 1);
                    const hasText = !!(block.text && block.text.trim().length > 0);
                    const attachedTexts = blockAppendedMap[block.id] || [];

                    const isDocumento = block.type === 'documento';
                    const isDocExpanded = isDocumento ? (expandedDocBlocks[block.id] ?? true) : true;
                    const docTitle = block.documentTitle?.trim() || 'Documento citado';
                    const blockReveal = getRevealState(`block:${block.id}`);

                    return (
                      <React.Fragment key={block.id}>
                        {isDocumento ? (
                          <motion.div
                            id={`block-${block.id}`}
                            initial={
                              blockReveal.isPendingReveal || blockReveal.shouldAnimateAppear
                                ? { opacity: 0, y: 12 }
                                : false
                            }
                            animate={
                              blockReveal.isPendingReveal
                                ? { opacity: 0, y: 12 }
                                : { opacity: 1, y: 0 }
                            }
                            transition={{ duration: 0.48, ease: [0.22, 1, 0.36, 1] }}
                            className={`tracking-wide transition-all duration-700 ${themeConfig.docContainerClass} ${
                              blockReveal.isHighlighted ? themeConfig.revealHighlightClass : ''
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => toggleDocBlock(block.id)}
                              aria-expanded={isDocExpanded}
                              className={themeConfig.docHeaderClass}
                            >
                              <span className={themeConfig.docTitleClass}>
                                <FileText className="w-4 h-4 shrink-0 opacity-85" />
                                <span className="truncate">{docTitle}</span>
                              </span>
                              <span className={themeConfig.docHintClass}>
                                <span className="hidden sm:inline">
                                  {isDocExpanded ? 'Replegar' : 'Leer'}
                                </span>
                                {isDocExpanded ? (
                                  <ChevronUp className="w-4 h-4 shrink-0" />
                                ) : (
                                  <ChevronDown className="w-4 h-4 shrink-0" />
                                )}
                              </span>
                            </button>

                            {isDocExpanded && (
                              <div className={themeConfig.docBodyClass}>
                                {blockImg && (
                                  <div className="w-full text-center my-2">
                                    <img
                                      src={blockImg}
                                      alt={docTitle}
                                      className="w-auto max-w-full h-auto max-h-[80vh] object-contain rounded-xl border border-white/10 shadow-lg mx-auto block"
                                    />
                                  </div>
                                )}

                                {hasText && renderTextWithTags(block.text, block.isGameOver, isFinal)}
                              </div>
                            )}
                          </motion.div>
                        ) : (
                          <motion.div
                            id={`block-${block.id}`}
                            initial={
                              blockReveal.isPendingReveal || blockReveal.shouldAnimateAppear
                                ? { opacity: 0, y: 12 }
                                : false
                            }
                            animate={
                              blockReveal.isPendingReveal
                                ? { opacity: 0, y: 12 }
                                : { opacity: 1, y: 0 }
                            }
                            transition={{ duration: 0.48, ease: [0.22, 1, 0.36, 1] }}
                            className={`tracking-wide space-y-3 rounded-xl transition-all duration-700 ${
                              blockReveal.isHighlighted ? themeConfig.revealHighlightClass : ''
                            }`}
                          >
                            {blockImg && (
                              <div className="w-full text-center my-3">
                                <img
                                  src={blockImg}
                                  alt="Ilustración"
                                  className={
                                    isPortada
                                      ? 'w-auto max-w-full h-auto max-h-[85vh] object-contain rounded-2xl border-2 border-amber-500/50 shadow-2xl mx-auto block'
                                      : 'w-auto max-w-full h-auto max-h-[80vh] object-contain rounded-xl border border-white/10 shadow-lg mx-auto block'
                                  }
                                />
                              </div>
                            )}

                            {hasText && renderTextWithTags(block.text, block.isGameOver, isFinal)}
                          </motion.div>
                        )}

                        {/* Appended Story Paragraphs attached to THIS block */}
                        {attachedTexts.map((appended, i) => {
                          const appReveal = getRevealState(`app:${block.id}:${i}`);
                          return (
                            <motion.div
                              id={`block-appended-${block.id}-${i}`}
                              initial={
                                appReveal.isPendingReveal || appReveal.shouldAnimateAppear
                                  ? { opacity: 0, y: 12 }
                                  : false
                              }
                              animate={
                                appReveal.isPendingReveal
                                  ? { opacity: 0, y: 12 }
                                  : { opacity: 1, y: 0 }
                              }
                              transition={{ duration: 0.48, ease: [0.22, 1, 0.36, 1] }}
                              key={`block-appended-${block.id}-${i}`}
                              className={`tracking-wide rounded-xl transition-all duration-700 ${
                                appReveal.isHighlighted ? themeConfig.revealHighlightClass : ''
                              }`}
                            >
                              {renderTextWithTags(appended)}
                            </motion.div>
                          );
                        })}
                      </React.Fragment>
                    );
                  })}

                  {/* Unattached Appended Story Paragraphs */}
                  {unattachedAppended.map((appended, i) => {
                    const appReveal = getRevealState(`app:unattached:${i}`);
                    return (
                      <motion.div
                        id={`unattached-appended-${i}`}
                        initial={
                          appReveal.isPendingReveal || appReveal.shouldAnimateAppear
                            ? { opacity: 0, y: 12 }
                            : false
                        }
                        animate={
                          appReveal.isPendingReveal
                            ? { opacity: 0, y: 12 }
                            : { opacity: 1, y: 0 }
                        }
                        transition={{ duration: 0.48, ease: [0.22, 1, 0.36, 1] }}
                        key={`unattached-appended-${i}`}
                        className={`tracking-wide rounded-xl transition-all duration-700 ${
                          appReveal.isHighlighted ? themeConfig.revealHighlightClass : ''
                        }`}
                      >
                        {renderTextWithTags(appended)}
                      </motion.div>
                    );
                  })}
                </>
              );
            })()}
          </div>
        </div>

        {/* Action & Item Outcome Pop-up Modal */}
        <AnimatePresence>
          {modalFeedback && (
            <div
              className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 cursor-pointer"
              onClick={() => dismissModalFeedback()}
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.92, y: 15 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.92, y: 15 }}
                onClick={(e) => e.stopPropagation()}
                className={`w-[calc(100vw-1.5rem)] max-w-lg p-4 sm:p-6 rounded-2xl border cursor-default max-h-[85vh] overflow-y-auto font-sans break-words ${
                  modalFeedback.type === 'gameover' || modalFeedback.isGameOver
                    ? isSepia
                      ? 'border-2 border-rose-800/80 bg-[#ebdcb9] text-[#3b2d1d] shadow-2xl'
                      : 'border-2 border-rose-500 bg-slate-950/95 text-slate-100 shadow-[0_0_35px_rgba(244,63,94,0.35)]'
                    : `${themeConfig.cardBorderClass} ${themeConfig.cardBgClass} ${themeConfig.textMainClass} shadow-2xl border-2`
                } space-y-4`}
              >
                <div className={`flex items-center justify-between border-b pb-3 ${
                  modalFeedback.type === 'gameover' || modalFeedback.isGameOver
                    ? isSepia ? 'border-[#cbb382]' : 'border-rose-500/30'
                    : themeConfig.cardBorderClass
                }`}>
                  <div className="flex items-center gap-2.5">
                    {modalFeedback.type === 'gameover' || modalFeedback.isGameOver ? (
                      <Skull className="w-5 h-5 text-rose-500 shrink-0 animate-bounce" />
                    ) : modalFeedback.type === 'item' ? (
                      <PackageCheck className={`w-5 h-5 ${themeConfig.accentClass} shrink-0`} />
                    ) : (
                      <div className={`w-5 h-5 ${themeConfig.accentClass} flex items-center justify-center shrink-0`}>
                        {getVerbIcon(modalFeedback.verbIconName || 'Eye')}
                      </div>
                    )}

                    {(modalFeedback.type !== 'action' || modalFeedback.showTitle) && (
                      <h3
                        className={`font-bold text-base ${
                          modalFeedback.type === 'gameover' || modalFeedback.isGameOver
                            ? isSepia ? 'text-rose-900' : 'text-rose-300'
                            : themeConfig.accentClass
                        }`}
                      >
                        {modalFeedback.title ||
                          (modalFeedback.type === 'gameover' || modalFeedback.isGameOver
                            ? 'FIN DE PARTIDA'
                            : modalFeedback.type === 'item'
                            ? 'Objeto'
                            : '')}
                      </h3>
                    )}

                    {modalFeedback.isAutosaved && (
                      <motion.div
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono border shadow-sm ${
                          isSepia
                            ? 'bg-[#822b16]/15 border-[#822b16]/40 text-[#822b16]'
                            : 'bg-emerald-500/15 border border-emerald-500/40 text-emerald-400'
                        }`}
                        title="Partida guardada automáticamente"
                      >
                        <motion.div
                          animate={{ scale: [1, 1.25, 1], rotate: [0, -12, 12, 0] }}
                          transition={{ repeat: Infinity, duration: 2, ease: 'easeInOut' }}
                          className="flex items-center justify-center"
                        >
                          <Save className={`w-3.5 h-3.5 ${isSepia ? 'text-[#822b16]' : 'text-emerald-400'}`} />
                        </motion.div>
                        <span className={`text-[10px] font-bold uppercase tracking-wider ${isSepia ? 'text-[#822b16]' : 'text-emerald-300'}`}>
                          Guardado
                        </span>
                      </motion.div>
                    )}
                  </div>
                  <button
                    onClick={() => dismissModalFeedback()}
                    className={`p-1 rounded-lg transition-colors ${themeConfig.textMutedClass} ${themeConfig.buttonHoverClass}`}
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <div className="py-2 space-y-3">
                  {modalFeedback.itemImageUrl && (
                    <div className="w-full text-center py-1">
                      <img
                        src={modalFeedback.itemImageUrl}
                        alt={modalFeedback.title || 'Objeto'}
                        className={`max-h-48 max-w-full rounded-xl border object-contain mx-auto shadow-lg ${themeConfig.cardBorderClass}`}
                      />
                    </div>
                  )}
                  <p
                    className={`text-base leading-relaxed whitespace-pre-line ${
                      modalFeedback.type === 'gameover' || modalFeedback.isGameOver
                        ? isSepia ? 'text-rose-950 font-bold' : 'text-rose-100 font-medium'
                        : themeConfig.textMainClass
                    }`}
                  >
                    {modalFeedback.message}
                  </p>
                </div>

                <div className={`flex flex-wrap items-center justify-end gap-2.5 pt-3 border-t ${
                  modalFeedback.type === 'gameover' || modalFeedback.isGameOver
                    ? isSepia ? 'border-[#cbb382]' : 'border-white/10'
                    : themeConfig.cardBorderClass
                }`}>
                  {modalFeedback.type === 'gameover' || modalFeedback.isGameOver ? (
                    <>
                      <button
                        onClick={handleRetryBeforeDeath}
                        title="Volver a la escena anterior a la muerte"
                        className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black rounded-xl text-xs shadow-md transition-colors flex items-center gap-1.5 cursor-pointer"
                      >
                        <RotateCcw className="w-4 h-4" />
                        <span>Reintentar</span>
                      </button>
                      {onOpenSaveLoad && (
                        <button
                          onClick={() => {
                            dismissModalFeedback();
                            onOpenSaveLoad();
                          }}
                          className={`px-4 py-2 font-bold rounded-xl text-xs shadow-md transition-colors flex items-center gap-1.5 cursor-pointer ${
                            isSepia ? 'bg-[#822b16] hover:bg-[#6b2210] text-[#fbf5e8]' : 'bg-emerald-700 hover:bg-emerald-600 text-white'
                          }`}
                        >
                          <Bookmark className={`w-4 h-4 ${isSepia ? 'text-[#fbf5e8]' : 'text-emerald-300'}`} />
                          <span>Cargar partida</span>
                        </button>
                      )}
                      <button
                        onClick={() => setShowExitConfirmModal(true)}
                        title={isSceneTesting ? 'Salir de la prueba y volver al editor' : 'Cerrar partida y salir a la biblioteca'}
                        className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white font-bold rounded-xl text-xs shadow-md transition-colors flex items-center gap-1.5 cursor-pointer"
                      >
                        <LogOut className="w-4 h-4" />
                        <span>Terminar</span>
                      </button>
                      <button
                        onClick={() => dismissModalFeedback()}
                        className={`px-3.5 py-2 rounded-xl text-xs transition-colors border ${themeConfig.buttonBgClass} ${themeConfig.buttonBorderClass} ${themeConfig.buttonTextClass} ${themeConfig.buttonHoverClass}`}
                      >
                        Cerrar
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => dismissModalFeedback()}
                      className={`px-5 py-2 font-bold rounded-xl text-xs shadow-md transition-colors cursor-pointer ${themeConfig.verbActiveBg} ${themeConfig.verbActiveText}`}
                    >
                      Entendido
                    </button>
                  )}
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Verbs Palette & Inventory Grid - Hidden in final / game-over scenes */}
        {!isSceneGameOver && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          
          {/* SCUMM Verbs Panel (2 columns) */}
          <div className={`md:col-span-2 p-5 rounded-2xl border ${themeConfig.cardBorderClass} ${themeConfig.cardBgClass} shadow-lg`}>
            <div className="flex items-center justify-between mb-3">
              <h3 className={`text-xs font-bold uppercase tracking-wider ${themeConfig.textMutedClass}`}>
                Acciones de Aventura (Verbos)
              </h3>
              <span className="text-[11px] text-slate-500">Haz clic para activar acción</span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
              {projectVerbs.map((v) => {
                const isActive = activeVerb === v.id;
                return (
                  <button
                    key={v.id}
                    onClick={() => handleSelectVerb(v.id)}
                    className={`flex items-center gap-2 px-2.5 py-2 sm:px-3 sm:py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition-all duration-150 border cursor-pointer ${
                      isActive
                        ? `${themeConfig.verbActiveBg} ${themeConfig.verbActiveText} border-amber-400 shadow-md scale-[1.02]`
                        : `${themeConfig.buttonBgClass} ${themeConfig.buttonBorderClass} ${themeConfig.buttonTextClass} ${themeConfig.buttonHoverClass}`
                    }`}
                  >
                    {getVerbIcon(v.iconName)}
                    <span>{v.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Inventory Panel (1 column) */}
          <div className={`p-5 rounded-2xl border ${themeConfig.cardBorderClass} ${themeConfig.cardBgClass} shadow-lg flex flex-col justify-between`}>
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className={`text-xs font-bold uppercase tracking-wider ${themeConfig.textMutedClass}`}>
                  Inventario {isSceneTesting ? `(Modo Prueba: ${project.inventoryItems.length} objetos)` : `(${gameState.inventory.length})`}
                </h3>
              </div>

              {isSceneTesting && (
                <div className="flex flex-wrap items-center gap-2 mb-3 text-[10px] bg-black/60 px-2.5 py-1.5 rounded-xl border border-white/10">
                  <span className="font-bold text-white/70">Prueba:</span>
                  <span className="inline-flex items-center gap-1 text-emerald-400 font-semibold">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-sm shadow-emerald-500/50"></span>
                    Obtenido
                  </span>
                  <span className="inline-flex items-center gap-1 text-blue-400 font-semibold">
                    <span className="w-2 h-2 rounded-full bg-blue-500 shadow-sm shadow-blue-500/50"></span>
                    Necesario en escena
                  </span>
                  <span className="inline-flex items-center gap-1 text-rose-400 font-semibold">
                    <span className="w-2 h-2 rounded-full bg-rose-500 shadow-sm shadow-rose-500/50"></span>
                    No obtenido
                  </span>
                </div>
              )}

              {(() => {
                const uniqueInventoryIds = Array.from(new Set(gameState.inventory));
                const itemsToDisplay: InventoryItem[] = isSceneTesting
                  ? project.inventoryItems
                  : (uniqueInventoryIds
                      .map((itemId: string) => project.inventoryItems.find((i) => i.id === itemId))
                      .filter(Boolean) as InventoryItem[]);

                if (itemsToDisplay.length === 0) {
                  return (
                    <div className={`text-center py-6 border border-dashed rounded-xl ${themeConfig.cardBorderClass}`}>
                      <Box className={`w-7 h-7 mx-auto mb-2 ${themeConfig.textMutedClass}`} />
                      <p className={`text-xs italic ${themeConfig.textMutedClass}`}>No hay ningún objeto disponible.</p>
                    </div>
                  );
                }

                return (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 max-h-52 overflow-y-auto pr-1">
                    {itemsToDisplay.map((item) => {
                      const isSelected = selectedInventoryItemId === item.id;
                      const itemImg = item.imageFileData || item.imageUrl;
                      const quantity = gameState.inventory.filter((id: string) => id === item.id).length;
                      const isObtained = quantity > 0;
                      const isNeeded = isItemNeededInScene(item, currentScene);

                      let slotBorderClass = `${themeConfig.buttonBgClass} ${themeConfig.buttonBorderClass} ${themeConfig.buttonTextClass} ${themeConfig.buttonHoverClass}`;

                      if (isSelected) {
                        slotBorderClass = `${themeConfig.verbActiveBg} ${themeConfig.verbActiveText} border-amber-400 font-bold shadow-md scale-[1.03] ring-2 ring-amber-400/50`;
                      } else if (isSceneTesting) {
                        if (isObtained) {
                          slotBorderClass = 'bg-emerald-950/30 border-2 border-emerald-500 ring-1 ring-emerald-500/40 text-emerald-200 shadow-sm';
                        } else if (isNeeded) {
                          slotBorderClass = 'bg-blue-950/30 border-2 border-blue-500 ring-1 ring-blue-500/40 text-blue-200 shadow-sm';
                        } else {
                          slotBorderClass = 'bg-rose-950/20 border-2 border-rose-500/80 ring-1 ring-rose-500/30 text-rose-300/70 opacity-75 shadow-sm';
                        }
                      }

                      return (
                        <div key={item.id} className="relative group">
                          <button
                            type="button"
                            onClick={() => handleSelectInventoryItem(item.id)}
                            className={`w-full flex items-center justify-center p-2 rounded-xl text-xs font-medium border transition-all cursor-pointer relative min-h-[44px] ${slotBorderClass}`}
                            title={quantity > 1 ? `${item.name} (${quantity} unidades)` : item.name}
                          >
                            {/* Mobile view (< sm): SHOW ONLY TEXT */}
                            <span className="sm:hidden truncate text-xs font-semibold px-1 text-center">
                              {item.name}
                              {quantity > 1 ? ` (x${quantity})` : ''}
                            </span>

                            {/* Desktop view (>= sm): SHOW ONLY MINIATURE THUMBNAIL IMAGE */}
                            <div className="hidden sm:flex items-center justify-center w-12 h-12 relative rounded-lg bg-slate-950/80 border border-amber-500/30 overflow-hidden shadow-sm shrink-0">
                              {itemImg ? (
                                <img
                                  src={itemImg}
                                  alt={item.name}
                                  className="w-full h-full object-contain p-0.5"
                                />
                              ) : (
                                <div className="w-full h-full bg-gradient-to-br from-amber-900/40 via-slate-900 to-amber-950/60 flex items-center justify-center text-amber-300 font-black text-xs uppercase">
                                  {item.name.substring(0, 2)}
                                </div>
                              )}

                              {isSelected && (
                                <span className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-amber-400 rounded-full border-2 border-slate-900 shadow animate-pulse z-10" />
                              )}

                              {/* Number in bottom-right corner ONLY when quantity > 1 (never show 1) */}
                              {quantity > 1 && (
                                <span className="absolute bottom-0.5 right-0.5 bg-slate-950/95 border border-amber-400 text-amber-300 font-black font-mono text-[10px] min-w-[16px] h-4 px-1 rounded flex items-center justify-center shadow-lg leading-none z-10 select-none">
                                  {quantity}
                                </span>
                              )}
                            </div>

                            {/* Status indicator badge in testing mode */}
                            {isSceneTesting && (
                              <span
                                className={`absolute -top-1 -left-1 w-3 h-3 rounded-full border border-slate-950 shadow-sm z-20 ${
                                  isObtained ? 'bg-emerald-500' : isNeeded ? 'bg-blue-500' : 'bg-rose-500'
                                }`}
                                title={isObtained ? (quantity > 1 ? `Obtenido (${quantity})` : 'Obtenido') : isNeeded ? 'Necesario en esta escena' : 'No obtenido'}
                              />
                            )}
                          </button>

                          {/* Hover Tooltip showing item name and testing status on desktop */}
                          <div className="hidden sm:block opacity-0 group-hover:opacity-100 pointer-events-none transition-all duration-200 absolute -top-10 left-1/2 -translate-x-1/2 z-30 bg-slate-950/95 border border-amber-400/60 text-amber-200 text-[11px] font-bold px-2.5 py-1 rounded-lg shadow-xl whitespace-nowrap backdrop-blur-md">
                            <span>{item.name}{quantity > 1 ? ` (x${quantity})` : ''}</span>
                            {isSceneTesting && (
                              <span className={`ml-1.5 text-[10px] ${
                                isObtained ? 'text-emerald-400' : isNeeded ? 'text-blue-400' : 'text-rose-400'
                              }`}>
                                • {isObtained ? (quantity > 1 ? `🟢 Obtenido (x${quantity})` : '🟢 Obtenido') : isNeeded ? '🔵 Necesario en escena' : '🔴 No obtenido'}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>

            {selectedItemObj && (
              <div className={`mt-3 p-3 rounded-xl border text-xs ${themeConfig.actionBoxBgClass} ${themeConfig.cardBorderClass} ${themeConfig.textMainClass} space-y-2`}>
                <div className="flex items-start justify-between gap-2.5">
                  <div className="min-w-0 flex-1">
                    <p className={`font-bold text-sm ${themeConfig.accentClass}`}>
                      {selectedItemObj.name}
                      {(() => {
                        const qty = gameState.inventory.filter((id: string) => id === selectedItemObj.id).length;
                        return qty > 1 ? ` (x${qty})` : '';
                      })()}
                    </p>
                    <p className={`text-[11px] leading-relaxed mt-0.5 ${themeConfig.textMutedClass}`}>{selectedItemObj.description}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleUseInventoryItemDirectly(selectedItemObj)}
                    className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 active:scale-95 text-slate-950 font-bold rounded-xl text-xs flex items-center gap-1.5 shadow-md transition-all cursor-pointer shrink-0"
                    title={`Usar ${selectedItemObj.name}`}
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>Usar</span>
                  </button>
                </div>

                {isSceneTesting && (
                  <div className="pt-2 border-t border-white/10 flex items-center justify-between gap-2">
                    <span className="text-[10px] text-slate-400 font-mono">
                      Estado:{' '}
                      <strong className={
                        gameState.inventory.includes(selectedItemObj.id)
                          ? 'text-emerald-400'
                          : isItemNeededInScene(selectedItemObj, currentScene)
                          ? 'text-blue-400'
                          : 'text-rose-400'
                      }>
                        {gameState.inventory.includes(selectedItemObj.id)
                          ? '🟢 Obtenido'
                          : isItemNeededInScene(selectedItemObj, currentScene)
                          ? '🔵 Necesario en escena'
                          : '🔴 No obtenido'}
                      </strong>
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setGameState((prev: any) => ({
                          ...prev,
                          inventory: prev.inventory.includes(selectedItemObj.id)
                            ? prev.inventory.filter((id: string) => id !== selectedItemObj.id)
                            : [...prev.inventory, selectedItemObj.id],
                        }));
                      }}
                      className={`px-2.5 py-1 rounded-lg text-[10px] font-bold border transition-colors cursor-pointer ${
                        gameState.inventory.includes(selectedItemObj.id)
                          ? 'bg-rose-950/70 border-rose-500/40 text-rose-300 hover:bg-rose-900'
                          : 'bg-emerald-950/70 border-emerald-500/40 text-emerald-300 hover:bg-emerald-900'
                      }`}
                    >
                      {gameState.inventory.includes(selectedItemObj.id) ? '✕ Quitar de inventario' : '+ Añadir a inventario'}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>

      {/* Interactive Word Direct Click Context Popover Menu */}
      {contextMenu && (() => {
        const ctxHotspot = currentScene?.hotspots.find((h) => h.id === contextMenu.hotspotId);

        // En modo Fácil solo se ofrecen los verbos que ese objeto realmente admite
        // (más "mirar", que siempre está disponible). En Normal y Difícil se muestran
        // todos para no dar pistas. Si el filtro dejara el menú vacío, se muestran todos.
        let ctxVerbs = projectVerbs;
        if (ctxHotspot && (gameState.difficulty || 'facil') === 'facil') {
          const verbsWithAction = new Set(
            (ctxHotspot.actions || [])
              .filter((a) => checkConditions(a.visibleIfFlags, a.hiddenIfFlags))
              .map((a) => a.verb)
          );
          const filtered = projectVerbs.filter((v) => verbsWithAction.has(v.id as VerbType) || v.id === 'mirar');
          if (filtered.length > 0) ctxVerbs = filtered;
        }

        return (
          <div
            className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center sm:p-4 cursor-pointer"
            onClick={() => setContextMenu(null)}
          >
            {/* Hoja inferior en móvil (al alcance del pulgar); ventana centrada desde sm */}
            <motion.div
              initial={{ opacity: 0, y: 40 }}
              animate={{ opacity: 1, y: 0 }}
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-label={`Acciones para ${contextMenu.word}`}
              className={`w-full sm:max-w-sm border-2 border-b-0 sm:border-b-2 rounded-t-2xl sm:rounded-2xl shadow-2xl p-4 pb-[max(1rem,env(safe-area-inset-bottom))] space-y-3 cursor-default ${themeConfig.cardBgClass} ${themeConfig.cardBorderClass} ${themeConfig.textMainClass}`}
            >
              <div className={`flex items-center justify-between border-b pb-2 ${themeConfig.cardBorderClass}`}>
                <span className={`text-sm font-extrabold ${themeConfig.accentClass}`}>
                  ¿Qué quieres hacer con "{contextMenu.word}"?
                </span>
                <button
                  onClick={() => setContextMenu(null)}
                  aria-label="Cerrar"
                  className={`p-2 -m-1 rounded-lg transition-colors ${themeConfig.textMutedClass} ${themeConfig.buttonHoverClass}`}
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2 max-h-[60dvh] overflow-y-auto pr-1">
                {ctxVerbs.map((v) => (
                  <button
                    key={v.id}
                    onClick={() => {
                      if (ctxHotspot) handleExecuteAction(ctxHotspot, v.id);
                    }}
                    className={`flex items-center gap-2 px-3 min-h-12 py-2.5 rounded-xl text-sm sm:text-xs font-semibold border transition-all cursor-pointer touch-manipulation ${themeConfig.buttonBgClass} ${themeConfig.buttonBorderClass} ${themeConfig.buttonTextClass} ${themeConfig.buttonHoverClass}`}
                  >
                    {getVerbIcon(v.iconName)}
                    <span>{v.label}</span>
                  </button>
                ))}
              </div>
            </motion.div>
          </div>
        );
      })()}

      {/* Details and Credits Modal */}
      <AnimatePresence>
        {showDetailsModal && (
          <div
            className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 cursor-pointer"
            onClick={() => setShowDetailsModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 15 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 15 }}
              onClick={(e) => e.stopPropagation()}
              className={`border rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden cursor-default ${
                isSepia
                  ? 'bg-[#f5ebd7] border-[#822b16]/40 text-[#3b2d1d]'
                  : 'bg-slate-900 border-amber-500/40 text-slate-200'
              }`}
            >
              {/* Header */}
              <div className={`px-6 py-4 border-b flex items-center justify-between ${
                isSepia ? 'bg-[#e4d2ad] border-[#c2aa79]' : 'bg-slate-950 border-slate-800'
              }`}>
                <div className="flex items-center gap-2.5">
                  <BookOpen className={`w-5 h-5 ${isSepia ? 'text-[#822b16]' : 'text-amber-400'}`} />
                  <div>
                    <h3 className={`font-bold text-base ${isSepia ? 'text-[#3b2d1d]' : 'text-slate-100'}`}>{project.title}</h3>
                    <div className="flex items-center gap-2 flex-wrap mt-0.5">
                      <p className={`text-xs ${isSepia ? 'text-[#786146]' : 'text-slate-400'}`}>Por {project.author || 'Autor anónimo'} • v{project.version || '1.0'}</p>
                      <StarRatingDisplay
                        rating={project.ratingAverage}
                        count={project.ratingCount}
                        size="xs"
                        theme={isSepia ? 'sepia' : 'dark'}
                      />
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => setShowDetailsModal(false)}
                  className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                    isSepia ? 'text-[#786146] hover:text-[#3b2d1d] hover:bg-[#ebdcb9]' : 'text-slate-400 hover:text-white hover:bg-slate-800'
                  }`}
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Content */}
              <div className="p-6 overflow-y-auto space-y-6 text-xs sm:text-sm leading-relaxed">
                {/* Synopsis */}
                <div className={`space-y-2 p-4 rounded-xl border ${
                  isSepia ? 'bg-[#ebdcb9] border-[#c2aa79]' : 'bg-slate-950/60 border-slate-800'
                }`}>
                  <h4 className={`font-bold text-xs uppercase tracking-wider flex items-center gap-1.5 ${
                    isSepia ? 'text-[#822b16]' : 'text-amber-400'
                  }`}>
                    <Sparkles className="w-4 h-4" />
                    Sinopsis de la Historia
                  </h4>
                  <p className={`text-xs sm:text-sm leading-relaxed whitespace-pre-line ${
                    isSepia ? 'text-[#3b2d1d]' : 'text-slate-200'
                  }`}>
                    {project.synopsis || project.description || 'Sin sinopsis disponible.'}
                  </p>
                </div>

                {/* Credits */}
                <div className={`space-y-2 p-4 rounded-xl border ${
                  isSepia ? 'bg-[#ebdcb9] border-[#c2aa79]' : 'bg-slate-950/60 border-slate-800'
                }`}>
                  <h4 className={`font-bold text-xs uppercase tracking-wider flex items-center gap-1.5 ${
                    isSepia ? 'text-[#822b16]' : 'text-amber-400'
                  }`}>
                    <Award className="w-4 h-4" />
                    Créditos Finales, Fuentes de Imágenes y Colaboradores
                  </h4>
                  {project.credits ? (
                    <p className={`text-xs font-mono leading-relaxed whitespace-pre-line p-3 rounded-lg border ${
                      isSepia ? 'bg-[#dfceaa] border-[#c2aa79] text-[#3b2d1d]' : 'bg-slate-900 border-slate-800 text-slate-300'
                    }`}>
                      {renderTextWithLinks(project.credits)}
                    </p>
                  ) : (
                    <p className={`italic text-xs ${isSepia ? 'text-[#786146]' : 'text-slate-500'}`}>
                      No se han registrado créditos adicionales para este texto-juego.
                    </p>
                  )}
                </div>

                {/* Technical Specs */}
                <div className="grid grid-cols-2 gap-3 pt-2">
                  <div className={`p-3 rounded-xl border text-center ${
                    isSepia ? 'bg-[#ebdcb9] border-[#c2aa79]' : 'bg-slate-950 border-slate-800'
                  }`}>
                    <span className={`block text-[10px] uppercase font-bold ${isSepia ? 'text-[#786146]' : 'text-slate-400'}`}>Escenas</span>
                    <span className={`font-bold text-xs ${isSepia ? 'text-[#3b2d1d]' : 'text-slate-200'}`}>{project.scenes.length} escenas</span>
                  </div>
                  <div className={`p-3 rounded-xl border text-center ${
                    isSepia ? 'bg-[#ebdcb9] border-[#c2aa79]' : 'bg-slate-950 border-slate-800'
                  }`}>
                    <span className={`block text-[10px] uppercase font-bold ${isSepia ? 'text-[#786146]' : 'text-slate-400'}`}>Objetos</span>
                    <span className={`font-bold text-xs ${isSepia ? 'text-[#3b2d1d]' : 'text-slate-200'}`}>{project.inventoryItems.length} objetos</span>
                  </div>
                </div>
              </div>

              {/* Footer */}
              <div className={`px-6 py-3.5 border-t flex items-center justify-end ${
                isSepia ? 'bg-[#e4d2ad] border-[#c2aa79]' : 'bg-slate-950 border-slate-800'
              }`}>
                <button
                  onClick={() => setShowDetailsModal(false)}
                  className={`px-4 py-2 font-bold rounded-xl text-xs transition-colors cursor-pointer ${
                    isSepia ? 'bg-[#822b16] hover:bg-[#6b2210] text-[#fbf5e8]' : 'bg-amber-500 hover:bg-amber-400 text-slate-950'
                  }`}
                >
                  Cerrar
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Pop-up Conversation Modal (Aventura Gráfica Style) */}
      {activeDialogue && (() => {
        const { character, dialogueBlock, currentNodeId, blockId, currentNpcReply } = activeDialogue;

        // Get active node or fallback to root
        const nodes = dialogueBlock.nodes && dialogueBlock.nodes.length > 0
          ? dialogueBlock.nodes
          : [
              {
                id: 'node_root',
                title: 'Inicio',
                npcPrompt: dialogueBlock.greeting || '¿Qué deseas?',
                options: dialogueBlock.options || [],
              },
            ];

        const currentNode = nodes.find((n) => n.id === currentNodeId) || nodes[0];
        const npcPrompt = currentNpcReply || currentNode?.npcPrompt || dialogueBlock.greeting || 'Te observa en silencio...';

        // Filter available player options based on flags and one-time used options
        const availableOptions = (currentNode?.options || []).filter((opt) => {
          if (opt.isOneTime && gameState.usedDialogueOptionIds?.includes(opt.id)) {
            return false;
          }
          if (opt.requiredItemId && !gameState.inventory.includes(opt.requiredItemId)) {
            return false;
          }
          if (opt.requiredFlags && !checkConditions(opt.requiredFlags)) {
            return false;
          }
          if (!checkConditions(opt.visibleIfFlags, opt.hiddenIfFlags)) {
            return false;
          }
          return true;
        });

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
            <div className={`w-full max-w-lg border rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh] ${themeConfig.cardBgClass} ${themeConfig.cardBorderClass} ${themeConfig.textMainClass}`}>
              
              {/* Modal Header */}
              <div className={`px-5 py-3.5 border-b flex items-center justify-between gap-3 shrink-0 ${themeConfig.buttonBgClass} ${themeConfig.cardBorderClass}`}>
                <div className="flex items-center gap-3">
                  {character.imageFileData || character.imageUrl ? (
                    <img
                      src={character.imageFileData || character.imageUrl}
                      alt={character.name}
                      className={`w-10 h-10 object-cover rounded-lg border shadow shrink-0 ${themeConfig.cardBorderClass}`}
                    />
                  ) : (
                    <div className={`w-10 h-10 rounded-lg font-bold flex items-center justify-center shrink-0 text-base shadow border ${themeConfig.accentBgClass} ${themeConfig.accentClass} ${themeConfig.accentBorderClass}`}>
                      {character.name.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <h3 className={`font-bold text-base ${themeConfig.accentClass}`}>{character.name}</h3>
                </div>

                <button
                  onClick={() => closeActiveDialogue()}
                  className={`p-1.5 rounded-lg transition-colors cursor-pointer ${themeConfig.textMutedClass} ${themeConfig.buttonHoverClass}`}
                  title="Cerrar conversación"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Modal Body: NPC Prompt + Player Options */}
              <div className="p-5 overflow-y-auto space-y-4 flex-1">
                {/* NPC Dialogue Prompt Box */}
                <div className={`p-4 rounded-xl border text-base leading-relaxed shadow-inner whitespace-pre-line ${themeConfig.actionBoxBgClass} ${themeConfig.cardBorderClass} ${themeConfig.textMainClass}`}>
                  <span className={`font-bold mr-2 ${themeConfig.accentClass}`}>{character.name}:</span>
                  "{npcPrompt}"
                  {activeDialogue.lastTurnNotice && (
                    <div className={`mt-2.5 text-xs font-semibold ${themeConfig.accentClass}`}>
                      [{activeDialogue.lastTurnNotice}]
                    </div>
                  )}
                </div>

                {/* Clickable Player Options List (Clean, without numbers or headers) */}
                {availableOptions.length > 0 ? (
                  <div className="space-y-2 pt-1">
                    {availableOptions.map((opt) => (
                      <button
                        key={opt.id}
                        onClick={() => handleSelectDialogueOption(opt, character, blockId)}
                        className={`w-full text-left p-3.5 rounded-xl border text-sm font-medium transition-all group cursor-pointer shadow-sm ${themeConfig.buttonBgClass} ${themeConfig.buttonBorderClass} ${themeConfig.buttonTextClass} ${themeConfig.buttonHoverClass}`}
                      >
                        <span className="group-hover:translate-x-1 transition-transform inline-block leading-snug">
                          "{opt.playerText || '...'}"
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className={`text-xs italic text-center py-2 ${themeConfig.textMutedClass}`}>
                    (No hay más opciones de respuesta. Puedes despedirte).
                  </p>
                )}
              </div>

              {/* Modal Footer */}
              <div className={`px-5 py-3 border-t flex items-center justify-end ${themeConfig.buttonBgClass} ${themeConfig.cardBorderClass}`}>
                <button
                  onClick={() => closeActiveDialogue()}
                  className={`px-4 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${themeConfig.verbActiveBg} ${themeConfig.verbActiveText}`}
                >
                  Despedirse
                </button>
              </div>

            </div>
          </div>
        );
      })()}

      {/* Confirmación para terminar la partida y volver a la biblioteca */}
      <AnimatePresence>
        {showExitConfirmModal && (
          <div
            className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 cursor-pointer"
            onClick={() => setShowExitConfirmModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 12 }}
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-label="Confirmar salida del juego"
              className={`max-w-sm w-full rounded-2xl border-2 p-6 shadow-2xl space-y-4 cursor-default ${
                isSepia
                  ? 'bg-[#f5ebd7] border-[#822b16]/50 text-[#3b2d1d]'
                  : `${themeConfig.cardBgClass} ${themeConfig.cardBorderClass} ${themeConfig.textMainClass}`
              }`}
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-rose-600/20 border border-rose-500/40 flex items-center justify-center shrink-0">
                  <LogOut className="w-5 h-5 text-rose-400" />
                </div>
                <div>
                  <h3 className="font-bold text-base">
                    {isSceneTesting ? '¿Salir de la prueba?' : '¿Terminar la partida?'}
                  </h3>
                  <p className={`text-xs mt-0.5 ${isSepia ? 'text-[#6c553b]' : themeConfig.textMutedClass}`}>
                    {isSceneTesting
                      ? 'Se cerrará la vista previa de esta escena y volverás al editor.'
                      : 'Se cerrará la historia actual y volverás a la biblioteca.'}
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setShowExitConfirmModal(false)}
                  className={`px-4 py-2 rounded-xl text-xs font-semibold border transition-colors cursor-pointer ${themeConfig.buttonBgClass} ${themeConfig.buttonBorderClass} ${themeConfig.buttonTextClass} ${themeConfig.buttonHoverClass}`}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={handleConfirmExitGame}
                  className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white rounded-xl text-xs font-bold shadow-md transition-colors flex items-center gap-1.5 cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>{isSceneTesting ? 'Volver al editor' : 'Salir a la biblioteca'}</span>
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};
