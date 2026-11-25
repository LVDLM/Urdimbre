import React, { useState, useRef, useMemo, useLayoutEffect, useEffect } from 'react';
import {
  GameProject,
  DialogueBlock,
  DialogueNode,
  DialogueOption,
  SoundEffectType,
  GameCharacter,
} from '../../types';
import { getAllMergedSounds } from '../../utils/audio';
import { AutoGrowTextarea } from '../common/AutoGrowTextarea';
import {
  MessageSquare,
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  CornerDownLeft,
  ArrowRight,
  Play,
  RotateCcw,
  Maximize2,
  ZoomIn,
  ZoomOut,
  LayoutGrid,
  Lock,
  Gift,
  Flag,
  DoorOpen,
  Square,
  Copy,
  UserPlus,
  Map as MapIcon,
} from 'lucide-react';

interface DialogueEditorProps {
  project: GameProject;
  dialogue?: DialogueBlock;
  onChange: (updated: DialogueBlock | undefined) => void;
  webAspect?: 'clean' | 'classic';
  suggestedCharacterName?: string;
  onEnsureCharacter?: (name: string, description?: string) => GameCharacter;
}

const NODE_WIDTH = 288;
const NODE_COL_GAP = 365;
const NODE_ROW_GAP = 42;
const CANVAS_PAD_X = 140;
const CANVAS_PAD_Y = 72;

function estimateNodeHeight(node: DialogueNode): number {
  const headerAndPrompt = 104;
  if (node.nodeType === 'npc_only') {
    return headerAndPrompt + 44;
  }
  const opts = node.options || [];
  if (opts.length === 0) return headerAndPrompt + 68;
  const optsHeight = opts.reduce((sum, o) => sum + (o.npcResponse?.trim() ? 56 : 36), 0);
  return headerAndPrompt + optsHeight + 36;
}

function computeAutoLayout(
  nodes: DialogueNode[],
  initialNodeId: string
): Record<string, { x: number; y: number; layer: number }> {
  const result: Record<string, { x: number; y: number; layer: number }> = {};
  if (nodes.length === 0) return result;

  const nodeMap = new Map<string, DialogueNode>();
  nodes.forEach((n) => nodeMap.set(n.id, n));

  const rootId = nodeMap.has(initialNodeId) ? initialNodeId : nodes[0].id;
  const layerMap = new Map<string, number>();
  const queue: string[] = [rootId];
  layerMap.set(rootId, 0);

  while (queue.length > 0) {
    const curId = queue.shift()!;
    const cur = nodeMap.get(curId);
    if (!cur) continue;
    const curLayer = layerMap.get(curId) ?? 0;

    const neighbors: string[] = [];
    if (cur.nodeType === 'npc_only') {
      if (cur.autoNextNodeId && nodeMap.has(cur.autoNextNodeId)) {
        neighbors.push(cur.autoNextNodeId);
      }
    } else {
      (cur.options || []).forEach((opt) => {
        if (!opt.endConversation && opt.nextNodeId && opt.nextNodeId !== 'end' && nodeMap.has(opt.nextNodeId)) {
          neighbors.push(opt.nextNodeId);
        }
      });
    }

    neighbors.forEach((nbId) => {
      if (!layerMap.has(nbId)) {
        layerMap.set(nbId, curLayer + 1);
        queue.push(nbId);
      }
    });
  }

  let maxLayer = 0;
  layerMap.forEach((l) => {
    if (l > maxLayer) maxLayer = l;
  });

  // Unreachable / detached nodes go cleanly to the right column
  nodes.forEach((n) => {
    if (!layerMap.has(n.id)) {
      layerMap.set(n.id, maxLayer + 1);
    }
  });

  const columns = new Map<number, DialogueNode[]>();
  nodes.forEach((n) => {
    const l = layerMap.get(n.id) ?? 0;
    if (!columns.has(l)) columns.set(l, []);
    columns.get(l)!.push(n);
  });

  Array.from(columns.keys())
    .sort((a, b) => a - b)
    .forEach((layer) => {
      const colNodes = columns.get(layer) || [];
      let curY = CANVAS_PAD_Y;
      colNodes.forEach((n) => {
        result[n.id] = {
          x: CANVAS_PAD_X + layer * NODE_COL_GAP,
          y: curY,
          layer,
        };
        curY += estimateNodeHeight(n) + NODE_ROW_GAP;
      });
    });

  return result;
}

export const DialogueEditor: React.FC<DialogueEditorProps> = ({
  project,
  dialogue,
  onChange,
  webAspect = 'clean',
  suggestedCharacterName,
  onEnsureCharacter,
}) => {
  const characters = project.characters || [];
  const inventoryItems = project.inventoryItems || [];
  const scenes = project.scenes || [];
  const globalFlagKeys = Object.keys(project.globalFlags || {});
  const isClean = webAspect === 'clean';

  const [newInlineCharName, setNewInlineCharName] = useState('');
  const [showInlineNewChar, setShowInlineNewChar] = useState(false);

  // Normalize nodes safely while keeping legacy flat options compatible
  const nodes: DialogueNode[] = useMemo(() => {
    if (!dialogue) return [];
    if (dialogue.nodes && dialogue.nodes.length > 0) return dialogue.nodes;
    return [
      {
        id: 'node_root',
        title: 'Nodo 1: Saludo Inicial',
        npcPrompt: dialogue.greeting || '¿Qué deseas?',
        options: dialogue.options || [],
      },
    ];
  }, [dialogue]);

  const initialNodeId = dialogue?.initialNodeId && nodes.some((n) => n.id === dialogue.initialNodeId)
    ? dialogue.initialNodeId
    : nodes[0]?.id || 'node_root';

  const autoLayout = useMemo(
    () => computeAutoLayout(nodes, initialNodeId),
    [nodes, initialNodeId]
  );

  // Selection & Inspector Mode
  const [selectedNodeId, setSelectedNodeId] = useState<string>(initialNodeId);
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = useState<'properties' | 'simulator'>('properties');
  const [showMinimap, setShowMinimap] = useState(true);
  const [showConditionsSection, setShowConditionsSection] = useState(false);
  const [showEffectsSection, setShowEffectsSection] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<
    | { type: 'delete_node'; nodeId: string; title: string }
    | { type: 'delete_dialogue' }
    | null
  >(null);
  const [uiNotice, setUiNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!uiNotice) return;
    const timer = window.setTimeout(() => setUiNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [uiNotice]);

  // Keep selectedNodeId valid when dialogue changes
  useEffect(() => {
    if (nodes.length > 0 && !nodes.some((n) => n.id === selectedNodeId)) {
      setSelectedNodeId(initialNodeId);
      setSelectedOptionId(null);
    }
  }, [nodes, selectedNodeId, initialNodeId]);

  // Canvas Viewport State (Pan & Zoom)
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<{ panX: number; panY: number; zoom: number }>({
    panX: 40,
    panY: 40,
    zoom: 0.92,
  });

  // Live node drag override (60fps without re-saving on every mousemove)
  const [draggingNode, setDraggingNode] = useState<{
    nodeId: string;
    startClientX: number;
    startClientY: number;
    origX: number;
    origY: number;
    curX: number;
    curY: number;
    moved: boolean;
  } | null>(null);

  // Live canvas pan state
  const [panningCanvas, setPanningCanvas] = useState<{
    startClientX: number;
    startClientY: number;
    origPanX: number;
    origPanY: number;
  } | null>(null);

  // Live wire dragging state (drag from output port to target node or empty canvas)
  const [connectingWire, setConnectingWire] = useState<{
    sourceNodeId: string;
    optionId: string | 'auto';
    startX: number;
    startY: number;
    curX: number;
    curY: number;
    moved: boolean;
  } | null>(null);
  const [hoveredTargetNodeId, setHoveredTargetNodeId] = useState<string | null>(null);
  const [hoveredWireKey, setHoveredWireKey] = useState<string | null>(null);

  // Measured DOM offsets for output ports inside each node card
  const nodeCardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const portRowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [portYOffsets, setPortYOffsets] = useState<Record<string, number>>({});
  const [nodeHeights, setNodeHeights] = useState<Record<string, number>>({});

  // Effective node positions (persisted node.position -> autoLayout -> live draggingNode)
  const effectivePositions = useMemo(() => {
    const map: Record<string, { x: number; y: number; layer: number }> = {};
    nodes.forEach((n) => {
      const auto = autoLayout[n.id] || { x: CANVAS_PAD_X, y: CANVAS_PAD_Y, layer: 0 };
      const baseX = typeof n.position?.x === 'number' ? n.position.x : auto.x;
      const baseY = typeof n.position?.y === 'number' ? n.position.y : auto.y;
      if (draggingNode && draggingNode.nodeId === n.id) {
        map[n.id] = { x: draggingNode.curX, y: draggingNode.curY, layer: auto.layer };
      } else {
        map[n.id] = { x: baseX, y: baseY, layer: auto.layer };
      }
    });
    return map;
  }, [nodes, autoLayout, draggingNode]);

  // Measure port Y offsets and node heights cleanly
  useLayoutEffect(() => {
    const nextOffsets: Record<string, number> = {};
    const nextHeights: Record<string, number> = {};

    nodes.forEach((n) => {
      const cardEl = nodeCardRefs.current[n.id];
      if (!cardEl) return;
      nextHeights[n.id] = cardEl.offsetHeight || estimateNodeHeight(n);

      const measureKey = (portKey: string) => {
        const rowEl = portRowRefs.current[portKey];
        if (!rowEl) return;
        let offset = 0;
        let el: HTMLElement | null = rowEl;
        while (el && el !== cardEl) {
          offset += el.offsetTop;
          el = el.offsetParent as HTMLElement | null;
        }
        nextOffsets[portKey] = offset + rowEl.offsetHeight / 2;
      };

      if (n.nodeType === 'npc_only') {
        measureKey(`${n.id}::auto`);
      } else {
        (n.options || []).forEach((opt) => {
          measureKey(`${n.id}::${opt.id}`);
        });
      }
    });

    setPortYOffsets(nextOffsets);
    setNodeHeights(nextHeights);
  }, [nodes, selectedNodeId, selectedOptionId]);

  const fitView = () => {
    const container = canvasRef.current;
    if (!container || nodes.length === 0) return;
    const rect = container.getBoundingClientRect();
    if (rect.width < 50 || rect.height < 50) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    nodes.forEach((n) => {
      const pos = effectivePositions[n.id] || { x: CANVAS_PAD_X, y: CANVAS_PAD_Y };
      const h = nodeHeights[n.id] || estimateNodeHeight(n);
      minX = Math.min(minX, pos.x);
      minY = Math.min(minY, pos.y);
      maxX = Math.max(maxX, pos.x + NODE_WIDTH);
      maxY = Math.max(maxY, pos.y + h);
    });

    // Include Start node badge left of initialNodeId
    const startPos = effectivePositions[initialNodeId];
    if (startPos) {
      minX = Math.min(minX, startPos.x - 105);
    }

    const contentW = Math.max(300, maxX - minX);
    const contentH = Math.max(200, maxY - minY);
    const pad = 48;
    const scaleX = (rect.width - pad * 2) / contentW;
    const scaleY = (rect.height - pad * 2) / contentH;
    const zoom = Math.max(0.45, Math.min(1.05, Math.min(scaleX, scaleY)));

    const panX = (rect.width - contentW * zoom) / 2 - minX * zoom;
    const panY = (rect.height - contentH * zoom) / 2 - minY * zoom;

    setViewport({ panX, panY, zoom });
  };

  // Auto-fit on first mount or when switching to a different dialogue
  const fittedKeyRef = useRef<string | null>(null);
  const dialogueKey = dialogue ? `${dialogue.characterId || ''}:${initialNodeId}` : null;
  useEffect(() => {
    if (!dialogue || !dialogueKey || fittedKeyRef.current === dialogueKey) return;
    const id = requestAnimationFrame(() => {
      fitView();
      fittedKeyRef.current = dialogueKey;
    });
    return () => cancelAnimationFrame(id);
  }, [dialogue, dialogueKey]);

  // Live Interactive Simulator state
  const [simNodeId, setSimNodeId] = useState<string>(initialNodeId);
  const [simNpcReply, setSimNpcReply] = useState<string | undefined>(undefined);
  const [simNotice, setSimNotice] = useState<string | undefined>(undefined);
  const [simEnded, setSimEnded] = useState(false);
  const [simUsedOneTimeIds, setSimUsedOneTimeIds] = useState<string[]>([]);
  const [simFlags, setSimFlags] = useState<Record<string, boolean>>(() => ({ ...(project.globalFlags || {}) }));
  const [simInventory, setSimInventory] = useState<string[]>([]);
  const [simShowTestEnv, setSimShowTestEnv] = useState(false);

  const resetSimulator = () => {
    setSimNodeId(initialNodeId);
    setSimNpcReply(undefined);
    setSimNotice(undefined);
    setSimEnded(false);
    setSimUsedOneTimeIds([]);
    setSimFlags({ ...(project.globalFlags || {}) });
    setSimInventory([]);
  };

  // Empty state (if opened standalone without an initialized DialogueBlock)
  if (!dialogue) {
    return (
      <div
        className={`p-6 rounded-xl border border-dashed flex flex-col sm:flex-row items-center justify-between gap-4 ${
          isClean ? 'bg-slate-50 border-slate-300' : 'bg-slate-900/60 border-white/10'
        }`}
      >
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-amber-500/10 text-amber-500">
            <MessageSquare className="w-5 h-5" />
          </div>
          <div>
            <h5 className={`font-bold text-sm ${isClean ? 'text-slate-800' : 'text-slate-100'}`}>
              Sin Árbol de Diálogo con Personaje
            </h5>
            <p className={`text-xs ${isClean ? 'text-slate-500' : 'text-slate-400'}`}>
              Crea un mapa visual de conversación con bifurcaciones, retornos y opciones descartables.
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => {
            let defaultCharId = characters.length > 0 ? characters[0].id : '';
            if (!defaultCharId && onEnsureCharacter) {
              const ensured = onEnsureCharacter(suggestedCharacterName || 'Personaje');
              defaultCharId = ensured.id;
            }
            const firstNodeId = `node_${Date.now()}`;
            onChange({
              characterId: defaultCharId,
              initialNodeId: firstNodeId,
              greeting: '¿Qué deseas?',
              insertConversationInStory: false,
              nodes: [
                {
                  id: firstNodeId,
                  title: 'Saludo Inicial',
                  nodeType: 'dialogue',
                  npcPrompt: 'Hola. ¿Qué se te ofrece?',
                  position: { x: 160, y: 90 },
                  options: [
                    {
                      id: `opt_${Date.now()}_1`,
                      playerText: 'Hola, ¿quién eres?',
                      npcResponse: 'Soy un habitante de este lugar.',
                    },
                    {
                      id: `opt_${Date.now()}_2`,
                      playerText: 'No tengo tiempo para hablar.',
                      npcResponse: 'De acuerdo, hasta luego.',
                      endConversation: true,
                    },
                  ],
                },
              ],
            });
          }}
          className="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs flex items-center gap-2 transition-colors cursor-pointer shrink-0"
        >
          <Plus className="w-4 h-4" />
          <span>Crear Editor Visual de Diálogo</span>
        </button>
      </div>
    );
  }

  // Helpers to mutate DialogueBlock cleanly
  const commitNodes = (updatedNodes: DialogueNode[], newInitialNodeId?: string) => {
    const nextInit = newInitialNodeId || initialNodeId;
    const startNode = updatedNodes.find((n) => n.id === nextInit) || updatedNodes[0];
    onChange({
      ...dialogue,
      initialNodeId: nextInit,
      nodes: updatedNodes,
      options: undefined, // cleared once normalized into nodes
      greeting: startNode?.npcPrompt || dialogue.greeting,
    });
  };

  const handleUpdateNode = (updatedNode: DialogueNode) => {
    commitNodes(nodes.map((n) => (n.id === updatedNode.id ? updatedNode : n)));
  };

  const handleAddNode = (
    kind: 'dialogue' | 'npc_only',
    customPos?: { x: number; y: number }
  ): DialogueNode => {
    const newId = `node_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const selPos = effectivePositions[selectedNodeId] || { x: CANVAS_PAD_X, y: CANVAS_PAD_Y };
    const pos = customPos || {
      x: Math.round(selPos.x + NODE_COL_GAP * 0.9),
      y: Math.round(selPos.y + (nodes.length % 3) * 48),
    };

    const newNode: DialogueNode =
      kind === 'npc_only'
        ? {
            id: newId,
            title: `Réplica ${nodes.length + 1}`,
            nodeType: 'npc_only',
            npcPrompt: 'Intervención del personaje...',
            autoNextNodeId: initialNodeId,
            position: pos,
            options: [],
          }
        : {
            id: newId,
            title: `Rama ${nodes.length + 1}`,
            nodeType: 'dialogue',
            npcPrompt: '¿Qué más quieres saber?',
            position: pos,
            options: [
              {
                id: `opt_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
                playerText: 'Volver al tema principal',
                npcResponse: '',
                nextNodeId: initialNodeId,
              },
            ],
          };

    commitNodes([...nodes, newNode]);
    setSelectedNodeId(newId);
    setSelectedOptionId(null);
    setInspectorTab('properties');
    return newNode;
  };

  const executeDeleteNode = (nodeIdToDelete: string) => {
    if (nodes.length <= 1) return;

    const remaining = nodes
      .filter((n) => n.id !== nodeIdToDelete)
      .map((n) => ({
        ...n,
        autoNextNodeId: n.autoNextNodeId === nodeIdToDelete ? undefined : n.autoNextNodeId,
        options: (n.options || []).map((o) =>
          o.nextNodeId === nodeIdToDelete ? { ...o, nextNodeId: undefined } : o
        ),
      }));

    const nextInitial = initialNodeId === nodeIdToDelete ? remaining[0].id : initialNodeId;
    commitNodes(remaining, nextInitial);
    setSelectedNodeId(remaining[0].id);
    setSelectedOptionId(null);
  };

  const handleDeleteNode = (nodeIdToDelete: string) => {
    if (nodes.length <= 1) {
      setUiNotice('Debe quedar al menos un nodo en la conversación. Si deseas eliminarla entera, usa «Borrar diálogo».');
      return;
    }
    const targetNode = nodes.find((n) => n.id === nodeIdToDelete);
    setPendingConfirm({
      type: 'delete_node',
      nodeId: nodeIdToDelete,
      title: targetNode?.title || 'Sin título',
    });
  };

  const handleDuplicateNode = (nodeToDup: DialogueNode) => {
    const newId = `node_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const pos = effectivePositions[nodeToDup.id] || { x: CANVAS_PAD_X, y: CANVAS_PAD_Y };
    const cloned: DialogueNode = {
      ...nodeToDup,
      id: newId,
      title: `${nodeToDup.title} (Copia)`,
      position: { x: pos.x + 36, y: pos.y + 44 },
      options: (nodeToDup.options || []).map((o, idx) => ({
        ...o,
        id: `opt_${Date.now()}_${idx}_${Math.floor(Math.random() * 1000)}`,
      })),
    };
    commitNodes([...nodes, cloned]);
    setSelectedNodeId(newId);
    setSelectedOptionId(null);
  };

  const handleAutoArrangeAll = () => {
    const fresh = computeAutoLayout(nodes, initialNodeId);
    const arranged = nodes.map((n) => ({
      ...n,
      position: { x: fresh[n.id].x, y: fresh[n.id].y },
    }));
    commitNodes(arranged);
    requestAnimationFrame(() => fitView());
  };

  const handleAddOptionToNode = (nodeId: string) => {
    const target = nodes.find((n) => n.id === nodeId);
    if (!target) return;
    const newOpt: DialogueOption = {
      id: `opt_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      playerText: 'Nueva pregunta o respuesta',
      npcResponse: 'Respuesta del personaje...',
    };
    handleUpdateNode({
      ...target,
      nodeType: 'dialogue',
      options: [...(target.options || []), newOpt],
    });
    setSelectedNodeId(nodeId);
    setSelectedOptionId(newOpt.id);
    setInspectorTab('properties');
  };

  const handleUpdateOption = (nodeId: string, optionId: string, updatedOpt: DialogueOption) => {
    const target = nodes.find((n) => n.id === nodeId);
    if (!target) return;
    handleUpdateNode({
      ...target,
      options: (target.options || []).map((o) => (o.id === optionId ? updatedOpt : o)),
    });
  };

  const handleDeleteOption = (nodeId: string, optionId: string) => {
    const target = nodes.find((n) => n.id === nodeId);
    if (!target) return;
    handleUpdateNode({
      ...target,
      options: (target.options || []).filter((o) => o.id !== optionId),
    });
    if (selectedOptionId === optionId) {
      setSelectedOptionId(null);
    }
  };

  const handleMoveOption = (nodeId: string, index: number, delta: -1 | 1) => {
    const target = nodes.find((n) => n.id === nodeId);
    if (!target) return;
    const list = [...(target.options || [])];
    const newIdx = index + delta;
    if (newIdx < 0 || newIdx >= list.length) return;
    const [moved] = list.splice(index, 1);
    list.splice(newIdx, 0, moved);
    handleUpdateNode({ ...target, options: list });
  };

  // Convert screen client coordinates into canvas world coordinates
  const clientToWorld = (clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (clientX - rect.left - viewport.panX) / viewport.zoom,
      y: (clientY - rect.top - viewport.panY) / viewport.zoom,
    };
  };

  // Find node under world point for wire dropping
  const findNodeAtWorldPoint = (wx: number, wy: number): string | null => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const pos = effectivePositions[n.id];
      if (!pos) continue;
      const h = nodeHeights[n.id] || estimateNodeHeight(n);
      // Generous hit area around node and its left input port
      if (wx >= pos.x - 18 && wx <= pos.x + NODE_WIDTH + 10 && wy >= pos.y - 10 && wy <= pos.y + h + 10) {
        return n.id;
      }
    }
    return null;
  };

  // Global canvas pointer move / up listeners while dragging node, panning, or connecting wire
  useEffect(() => {
    if (!draggingNode && !panningCanvas && !connectingWire) return;

    const handleMove = (e: PointerEvent) => {
      if (draggingNode) {
        const dx = (e.clientX - draggingNode.startClientX) / viewport.zoom;
        const dy = (e.clientY - draggingNode.startClientY) / viewport.zoom;
        const moved = draggingNode.moved || Math.hypot(dx, dy) > 4;
        setDraggingNode((prev) =>
          prev
            ? {
                ...prev,
                curX: Math.round(prev.origX + dx),
                curY: Math.round(prev.origY + dy),
                moved,
              }
            : null
        );
      } else if (panningCanvas) {
        const dx = e.clientX - panningCanvas.startClientX;
        const dy = e.clientY - panningCanvas.startClientY;
        setViewport((v) => ({
          ...v,
          panX: panningCanvas.origPanX + dx,
          panY: panningCanvas.origPanY + dy,
        }));
      } else if (connectingWire) {
        const pt = clientToWorld(e.clientX, e.clientY);
        const moved =
          connectingWire.moved ||
          Math.hypot(pt.x - connectingWire.startX, pt.y - connectingWire.startY) > 6;
        const hitId = findNodeAtWorldPoint(pt.x, pt.y);
        setHoveredTargetNodeId(hitId);
        setConnectingWire((prev) =>
          prev ? { ...prev, curX: pt.x, curY: pt.y, moved } : null
        );
      }
    };

    const handleUp = () => {
      if (draggingNode) {
        if (draggingNode.moved) {
          const updated = nodes.map((n) =>
            n.id === draggingNode.nodeId
              ? { ...n, position: { x: draggingNode.curX, y: draggingNode.curY } }
              : n
          );
          commitNodes(updated);
        } else {
          setSelectedNodeId(draggingNode.nodeId);
          setSelectedOptionId(null);
          setInspectorTab('properties');
        }
        setDraggingNode(null);
      }

      if (panningCanvas) {
        setPanningCanvas(null);
      }

      if (connectingWire) {
        if (connectingWire.moved) {
          const hitId = findNodeAtWorldPoint(connectingWire.curX, connectingWire.curY);
          let targetNodeId = hitId;

          // Dropped on empty canvas -> spawn new node directly there and link!
          if (!targetNodeId && Math.hypot(connectingWire.curX - connectingWire.startX, connectingWire.curY - connectingWire.startY) > 20) {
            const newId = `node_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
            const newNode: DialogueNode = {
              id: newId,
              title: `Rama ${nodes.length + 1}`,
              nodeType: 'dialogue',
              npcPrompt: '¿Qué más quieres saber?',
              position: {
                x: Math.round(connectingWire.curX),
                y: Math.round(connectingWire.curY - 24),
              },
              options: [
                {
                  id: `opt_${Date.now()}_ret`,
                  playerText: 'Volver al tema principal',
                  npcResponse: '',
                  nextNodeId: initialNodeId,
                },
              ],
            };

            const nextNodes = nodes.map((n) => {
              if (n.id !== connectingWire.sourceNodeId) return n;
              if (connectingWire.optionId === 'auto') {
                return { ...n, autoNextNodeId: newId, autoEndConversation: false };
              }
              return {
                ...n,
                options: (n.options || []).map((o) =>
                  o.id === connectingWire.optionId
                    ? { ...o, nextNodeId: newId, endConversation: false }
                    : o
                ),
              };
            });

            commitNodes([...nextNodes, newNode]);
            setSelectedNodeId(newId);
            setSelectedOptionId(null);
            setInspectorTab('properties');
          } else if (targetNodeId) {
            const nextNodes = nodes.map((n) => {
              if (n.id !== connectingWire.sourceNodeId) return n;
              if (connectingWire.optionId === 'auto') {
                return { ...n, autoNextNodeId: targetNodeId!, autoEndConversation: false };
              }
              return {
                ...n,
                options: (n.options || []).map((o) =>
                  o.id === connectingWire.optionId
                    ? { ...o, nextNodeId: targetNodeId!, endConversation: false }
                    : o
                ),
              };
            });
            commitNodes(nextNodes);
            setSelectedNodeId(connectingWire.sourceNodeId);
            if (connectingWire.optionId !== 'auto') {
              setSelectedOptionId(connectingWire.optionId);
            }
          }
        } else {
          // Simple click on port selects that node/option
          setSelectedNodeId(connectingWire.sourceNodeId);
          setSelectedOptionId(connectingWire.optionId === 'auto' ? null : connectingWire.optionId);
          setInspectorTab('properties');
        }
        setConnectingWire(null);
        setHoveredTargetNodeId(null);
      }
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  });

  // Resolve primary character
  const primaryChar = characters.find((c) => c.id === dialogue.characterId) || null;
  const activeNode = nodes.find((n) => n.id === selectedNodeId) || nodes[0];
  const activeOption =
    selectedOptionId && activeNode
      ? (activeNode.options || []).find((o) => o.id === selectedOptionId) || null
      : null;

  // Build SVG edge list
  interface WireEdge {
    key: string;
    sourceNodeId: string;
    optionId: string | 'auto';
    targetNodeId: string;
    sx: number;
    sy: number;
    tx: number;
    ty: number;
    isReturn: boolean;
    isSelected: boolean;
    label?: string;
  }

  const wireEdges: WireEdge[] = useMemo(() => {
    const list: WireEdge[] = [];
    const nodeIds = new Set(nodes.map((n) => n.id));

    nodes.forEach((n) => {
      const srcPos = effectivePositions[n.id];
      if (!srcPos) return;

      if (n.nodeType === 'npc_only') {
        if (!n.autoEndConversation && n.autoNextNodeId && n.autoNextNodeId !== 'end' && nodeIds.has(n.autoNextNodeId)) {
          const dstPos = effectivePositions[n.autoNextNodeId];
          if (!dstPos) return;
          const portOffsetY = portYOffsets[`${n.id}::auto`] ?? (estimateNodeHeight(n) - 20);
          const isReturn = dstPos.x < srcPos.x - 25 || n.autoNextNodeId === n.id || dstPos.layer <= srcPos.layer;
          list.push({
            key: `${n.id}::auto->${n.autoNextNodeId}`,
            sourceNodeId: n.id,
            optionId: 'auto',
            targetNodeId: n.autoNextNodeId,
            sx: srcPos.x + NODE_WIDTH,
            sy: srcPos.y + portOffsetY,
            tx: dstPos.x,
            ty: dstPos.y + 22,
            isReturn,
            isSelected: selectedNodeId === n.id && !selectedOptionId,
          });
        }
      } else {
        (n.options || []).forEach((opt, idx) => {
          if (opt.endConversation || !opt.nextNodeId || opt.nextNodeId === 'end' || !nodeIds.has(opt.nextNodeId)) {
            return;
          }
          const dstPos = effectivePositions[opt.nextNodeId];
          if (!dstPos) return;
          const portOffsetY = portYOffsets[`${n.id}::${opt.id}`] ?? (102 + idx * 38 + 18);
          const isReturn = dstPos.x < srcPos.x - 25 || opt.nextNodeId === n.id || dstPos.layer <= srcPos.layer;
          list.push({
            key: `${n.id}::${opt.id}->${opt.nextNodeId}`,
            sourceNodeId: n.id,
            optionId: opt.id,
            targetNodeId: opt.nextNodeId,
            sx: srcPos.x + NODE_WIDTH,
            sy: srcPos.y + portOffsetY,
            tx: dstPos.x,
            ty: dstPos.y + 22,
            isReturn,
            isSelected: selectedNodeId === n.id && selectedOptionId === opt.id,
          });
        });
      }
    });

    return list;
  }, [nodes, effectivePositions, portYOffsets, selectedNodeId, selectedOptionId]);

  const computeBezierPath = (sx: number, sy: number, tx: number, ty: number, isReturn: boolean, returnIndex = 0) => {
    if (isReturn) {
      const dist = Math.abs(sx - tx);
      const lift = Math.min(200, 68 + dist * 0.14 + (returnIndex % 4) * 22);
      const topY = Math.min(sy, ty) - lift;
      const c1x = sx + 85;
      const c1y = topY;
      const c2x = tx - 85;
      const c2y = topY;
      return `M ${sx} ${sy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${tx} ${ty}`;
    }
    const dx = Math.max(52, Math.abs(tx - sx) * 0.52);
    return `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`;
  };

  // Simulator helpers
  const simCurrentNode = nodes.find((n) => n.id === simNodeId) || nodes[0];
  const simSpeaker =
    (simCurrentNode?.speakerCharacterId
      ? characters.find((c) => c.id === simCurrentNode.speakerCharacterId)
      : null) ||
    primaryChar || { id: 'npc', name: suggestedCharacterName || 'Personaje', description: '' };

  const simCheckFlags = (req?: Record<string, boolean>, vis?: Record<string, boolean>, hid?: Record<string, boolean>) => {
    if (req) {
      for (const [k, v] of Object.entries(req)) {
        if (Boolean(simFlags[k]) !== Boolean(v)) return false;
      }
    }
    if (vis) {
      for (const [k, v] of Object.entries(vis)) {
        if (Boolean(simFlags[k]) !== Boolean(v)) return false;
      }
    }
    if (hid) {
      for (const [k, v] of Object.entries(hid)) {
        if (Boolean(simFlags[k]) === Boolean(v)) return false;
      }
    }
    return true;
  };

  const simAvailableOptions =
    simCurrentNode?.nodeType === 'npc_only'
      ? []
      : (simCurrentNode?.options || []).filter((opt) => {
          if (opt.isOneTime && simUsedOneTimeIds.includes(opt.id)) return false;
          if (opt.requiredItemId && !simInventory.includes(opt.requiredItemId)) return false;
          if (!simCheckFlags(opt.requiredFlags, opt.visibleIfFlags, opt.hiddenIfFlags)) return false;
          return true;
        });

  const handleSimOption = (opt: DialogueOption) => {
    if (opt.isOneTime && !simUsedOneTimeIds.includes(opt.id)) {
      setSimUsedOneTimeIds((prev) => [...prev, opt.id]);
    }
    if (opt.setFlags) {
      setSimFlags((prev) => ({ ...prev, ...opt.setFlags }));
    }
    let nextInv = [...simInventory];
    if (opt.requiredItemId && opt.consumeRequiredItem) {
      nextInv = nextInv.filter((id) => id !== opt.requiredItemId);
    }
    if (opt.giveItemId && !nextInv.includes(opt.giveItemId)) {
      nextInv.push(opt.giveItemId);
    }
    if (opt.giveItems) {
      Object.entries(opt.giveItems).forEach(([id, q]) => {
        if (Number(q) > 0 && !nextInv.includes(id)) nextInv.push(id);
      });
    }
    setSimInventory(nextInv);

    const notices: string[] = [];
    if (opt.giveItemId) {
      const it = inventoryItems.find((i) => i.id === opt.giveItemId);
      notices.push(`+Objeto: ${it?.name || opt.giveItemId}`);
    }
    if (opt.requiredItemId && opt.consumeRequiredItem) {
      const it = inventoryItems.find((i) => i.id === opt.requiredItemId);
      notices.push(`-Objeto: ${it?.name || opt.requiredItemId}`);
    }
    if (opt.setFlags) {
      Object.entries(opt.setFlags).forEach(([k, v]) => notices.push(`Bandera ${k} = ${v ? 'TRUE' : 'FALSE'}`));
    }
    if (opt.appendStoryText) notices.push('Añade párrafo a narración');
    if (opt.goToSceneId) {
      const sc = scenes.find((s) => s.id === opt.goToSceneId);
      notices.push(`Salta a escena: ${sc?.name || opt.goToSceneId}`);
    }
    setSimNotice(notices.length > 0 ? notices.join(' · ') : undefined);

    if (opt.isGameOver) {
      setSimNpcReply(opt.npcResponse || 'Fin de partida.');
      setSimEnded(true);
    } else if (opt.endConversation || opt.nextNodeId === 'end' || opt.goToSceneId) {
      setSimNpcReply(opt.npcResponse || '(Conversación finalizada)');
      setSimEnded(true);
    } else if (opt.nextNodeId && opt.nextNodeId !== simCurrentNode?.id && nodes.some((n) => n.id === opt.nextNodeId)) {
      const nextN = nodes.find((n) => n.id === opt.nextNodeId);
      const rTrim = opt.npcResponse?.trim() || '';
      const pTrim = nextN?.npcPrompt?.trim() || '';
      const combined = rTrim && pTrim && rTrim !== pTrim ? `${rTrim}\n\n${pTrim}` : rTrim || undefined;
      setSimNodeId(opt.nextNodeId);
      setSimNpcReply(combined);
    } else {
      setSimNpcReply(opt.npcResponse?.trim() || undefined);
    }
  };

  // Option Inspector helpers
  const renderOptionInspector = (node: DialogueNode, opt: DialogueOption) => {
    const srcPos = effectivePositions[node.id];
    const destMode = opt.goToSceneId
      ? 'scene'
      : opt.endConversation || opt.nextNodeId === 'end'
      ? 'end'
      : opt.nextNodeId
      ? 'node'
      : 'stay';

    const visFlagKey = opt.visibleIfFlags ? Object.keys(opt.visibleIfFlags)[0] || '' : '';
    const hidFlagKey = opt.hiddenIfFlags ? Object.keys(opt.hiddenIfFlags)[0] || '' : '';
    const setFlagKey = opt.setFlags ? Object.keys(opt.setFlags)[0] || '' : '';
    const setFlagVal = setFlagKey ? opt.setFlags![setFlagKey] !== false : true;
    const reqFlagKeys = opt.requiredFlags ? Object.keys(opt.requiredFlags) : [];

    return (
      <div className="space-y-4">
        {/* Breadcrumb back to parent node */}
        <div className="flex items-center justify-between gap-2 pb-2.5 border-b border-slate-800">
          <button
            type="button"
            onClick={() => setSelectedOptionId(null)}
            className="text-xs font-semibold text-amber-400 hover:text-amber-300 flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
          >
            <CornerDownLeft className="w-3.5 h-3.5" />
            <span className="truncate max-w-[210px]">Volver a: {node.title}</span>
          </button>
          <button
            type="button"
            onClick={() => handleDeleteOption(node.id, opt.id)}
            className="px-2 py-1 rounded-lg text-[11px] font-semibold text-rose-400 hover:bg-rose-500/10 flex items-center gap-1 cursor-pointer shrink-0"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Eliminar</span>
          </button>
        </div>

        {/* Texts */}
        <div className="space-y-3">
          <div>
            <label className="block text-[11px] font-semibold text-slate-300 mb-1">
              Opción del jugador
            </label>
            <input
              type="text"
              value={opt.playerText}
              onChange={(e) => handleUpdateOption(node.id, opt.id, { ...opt, playerText: e.target.value })}
              placeholder="Lo que dice o pregunta el jugador..."
              className="w-full px-3 py-2 rounded-lg text-xs border border-slate-700 bg-slate-900 text-slate-100 focus:outline-none focus:border-amber-500"
            />
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-slate-300 mb-1">
              Réplica del personaje
            </label>
            <AutoGrowTextarea
              value={opt.npcResponse}
              onChange={(e) => handleUpdateOption(node.id, opt.id, { ...opt, npcResponse: e.target.value })}
              placeholder="Respuesta inmediata tras elegir esta opción..."
              className="w-full px-3 py-2 rounded-lg text-xs border border-slate-700 bg-slate-900 text-slate-100 font-serif leading-relaxed focus:outline-none focus:border-amber-500"
            />
          </div>
        </div>

        {/* Destination / Flow */}
        <div className="pt-3 border-t border-slate-800 space-y-2.5">
          <label className="block text-[11px] font-semibold text-slate-200">
            Destino tras esta respuesta
          </label>
          <div className="grid grid-cols-2 gap-1.5">
            {[
              { id: 'stay', label: 'Mismo nodo' },
              { id: 'node', label: 'Ir / Retornar' },
              { id: 'end', label: 'Cerrar charla' },
              { id: 'scene', label: 'Ir a escena' },
            ].map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  if (m.id === 'stay') {
                    handleUpdateOption(node.id, opt.id, {
                      ...opt,
                      nextNodeId: undefined,
                      endConversation: false,
                      goToSceneId: undefined,
                    });
                  } else if (m.id === 'node') {
                    const fallbackTarget =
                      nodes.find((n) => n.id !== node.id)?.id || initialNodeId;
                    handleUpdateOption(node.id, opt.id, {
                      ...opt,
                      nextNodeId: opt.nextNodeId && opt.nextNodeId !== 'end' ? opt.nextNodeId : fallbackTarget,
                      endConversation: false,
                      goToSceneId: undefined,
                    });
                  } else if (m.id === 'end') {
                    handleUpdateOption(node.id, opt.id, {
                      ...opt,
                      nextNodeId: undefined,
                      endConversation: true,
                      goToSceneId: undefined,
                    });
                  } else if (m.id === 'scene') {
                    handleUpdateOption(node.id, opt.id, {
                      ...opt,
                      nextNodeId: undefined,
                      endConversation: false,
                      goToSceneId: opt.goToSceneId || scenes[0]?.id || '',
                    });
                  }
                }}
                className={`px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border transition-colors cursor-pointer whitespace-nowrap ${
                  destMode === m.id
                    ? 'bg-amber-500 text-slate-950 border-amber-400'
                    : 'bg-slate-900 text-slate-300 border-slate-800 hover:bg-slate-800'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          {destMode === 'node' && (
            <select
              value={opt.nextNodeId || ''}
              onChange={(e) =>
                handleUpdateOption(node.id, opt.id, {
                  ...opt,
                  nextNodeId: e.target.value || undefined,
                  endConversation: false,
                })
              }
              className="w-full px-2.5 py-2 rounded-lg text-xs border border-slate-700 bg-slate-900 text-amber-200 font-semibold"
            >
              {nodes.map((n) => {
                const dstPos = effectivePositions[n.id];
                const isReturn =
                  srcPos && dstPos
                    ? dstPos.x < srcPos.x - 25 || n.id === node.id || dstPos.layer <= srcPos.layer
                    : false;
                return (
                  <option key={n.id} value={n.id}>
                    {isReturn ? '↩ Retornar a: ' : '➔ Ir a: '}
                    {n.title}
                    {n.id === initialNodeId ? ' (Inicio)' : ''}
                  </option>
                );
              })}
            </select>
          )}

          {destMode === 'scene' && (
            <select
              value={opt.goToSceneId || ''}
              onChange={(e) =>
                handleUpdateOption(node.id, opt.id, {
                  ...opt,
                  goToSceneId: e.target.value || undefined,
                })
              }
              className="w-full px-2.5 py-2 rounded-lg text-xs border border-slate-700 bg-slate-900 text-sky-200 font-semibold"
            >
              <option value="">-- Seleccionar escena --</option>
              {scenes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.id})
                </option>
              ))}
            </select>
          )}
        </div>

        {/* One-time discard toggle */}
        <div className="pt-3 border-t border-slate-800">
          <label className="flex items-start gap-2.5 p-2.5 rounded-lg border border-slate-800 bg-slate-900/70 cursor-pointer hover:border-amber-500/40 transition-colors">
            <input
              type="checkbox"
              checked={!!opt.isOneTime}
              onChange={(e) =>
                handleUpdateOption(node.id, opt.id, { ...opt, isOneTime: e.target.checked })
              }
              className="mt-0.5 rounded text-amber-500 focus:ring-amber-500 cursor-pointer"
            />
            <div>
              <span className="block text-xs font-semibold text-slate-100">
                Descartar opción tras usarla (Un solo uso)
              </span>
              <span className="block text-[11px] text-slate-400 leading-snug mt-0.5">
                Desaparece permanentemente de la conversación una vez elegida.
              </span>
            </div>
          </label>
        </div>

        {/* Collapsible: Conditions */}
        <div className="pt-2 border-t border-slate-800">
          <button
            type="button"
            onClick={() => setShowConditionsSection((v) => !v)}
            className="w-full flex items-center justify-between py-1.5 text-xs font-semibold text-slate-200 cursor-pointer"
          >
            <span className="flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5 text-slate-400" />
              <span>Condiciones para mostrarse</span>
              {(opt.requiredItemId || visFlagKey || hidFlagKey || reqFlagKeys.length > 0) && (
                <span className="text-[10px] text-amber-400 font-normal">· Configuradas</span>
              )}
            </span>
            {showConditionsSection ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
          </button>

          {showConditionsSection && (
            <div className="space-y-3 pt-2">
              <div>
                <label className="block text-[11px] font-medium text-slate-400 mb-1">
                  Requiere objeto en inventario
                </label>
                <select
                  value={opt.requiredItemId || ''}
                  onChange={(e) =>
                    handleUpdateOption(node.id, opt.id, {
                      ...opt,
                      requiredItemId: e.target.value || undefined,
                      consumeRequiredItem: e.target.value ? opt.consumeRequiredItem : false,
                    })
                  }
                  className="w-full px-2.5 py-1.5 rounded-lg text-xs border border-slate-700 bg-slate-900 text-slate-100"
                >
                  <option value="">-- Ninguno --</option>
                  {inventoryItems.map((it) => (
                    <option key={it.id} value={it.id}>
                      {it.name}
                    </option>
                  ))}
                </select>
                {opt.requiredItemId && (
                  <label className="mt-1.5 flex items-center gap-2 cursor-pointer text-[11px] text-slate-300">
                    <input
                      type="checkbox"
                      checked={!!opt.consumeRequiredItem}
                      onChange={(e) =>
                        handleUpdateOption(node.id, opt.id, {
                          ...opt,
                          consumeRequiredItem: e.target.checked,
                        })
                      }
                      className="rounded text-amber-500"
                    />
                    <span>Entregar / retirar del inventario al elegir</span>
                  </label>
                )}
              </div>

              {globalFlagKeys.length > 0 && (
                <div className="grid grid-cols-1 gap-2.5">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-400 mb-1">
                      Visible solo si bandera está ACTIVADA
                    </label>
                    <select
                      value={visFlagKey}
                      onChange={(e) =>
                        handleUpdateOption(node.id, opt.id, {
                          ...opt,
                          visibleIfFlags: e.target.value ? { [e.target.value]: true } : undefined,
                        })
                      }
                      className="w-full px-2.5 py-1.5 rounded-lg text-xs border border-slate-700 bg-slate-900 text-slate-100 font-mono"
                    >
                      <option value="">-- Siempre visible --</option>
                      {globalFlagKeys.map((fk) => (
                        <option key={fk} value={fk}>
                          {fk}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-slate-400 mb-1">
                      Ocultar si bandera está ACTIVADA
                    </label>
                    <select
                      value={hidFlagKey}
                      onChange={(e) =>
                        handleUpdateOption(node.id, opt.id, {
                          ...opt,
                          hiddenIfFlags: e.target.value ? { [e.target.value]: true } : undefined,
                        })
                      }
                      className="w-full px-2.5 py-1.5 rounded-lg text-xs border border-slate-700 bg-slate-900 text-slate-100 font-mono"
                    >
                      <option value="">-- No ocultar por bandera --</option>
                      {globalFlagKeys.map((fk) => (
                        <option key={fk} value={fk}>
                          {fk}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              {reqFlagKeys.length > 0 && (
                <p className="text-[10px] text-slate-400">
                  Banderas requeridas heredadas: {reqFlagKeys.join(', ')}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Collapsible: Consequences */}
        <div className="pt-2 border-t border-slate-800">
          <button
            type="button"
            onClick={() => setShowEffectsSection((v) => !v)}
            className="w-full flex items-center justify-between py-1.5 text-xs font-semibold text-slate-200 cursor-pointer"
          >
            <span className="flex items-center gap-1.5">
              <Gift className="w-3.5 h-3.5 text-slate-400" />
              <span>Consecuencias y efectos</span>
              {(opt.giveItemId || setFlagKey || opt.appendStoryText || (opt.soundEffect && opt.soundEffect !== 'none') || opt.isGameOver) && (
                <span className="text-[10px] text-emerald-400 font-normal">· Activos</span>
              )}
            </span>
            {showEffectsSection ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
          </button>

          {showEffectsSection && (
            <div className="space-y-3 pt-2">
              <div>
                <label className="block text-[11px] font-medium text-emerald-400 mb-1">
                  Entregar objeto al jugador (+Objeto)
                </label>
                <select
                  value={opt.giveItemId || ''}
                  onChange={(e) =>
                    handleUpdateOption(node.id, opt.id, {
                      ...opt,
                      giveItemId: e.target.value || undefined,
                    })
                  }
                  className="w-full px-2.5 py-1.5 rounded-lg text-xs border border-slate-700 bg-slate-900 text-slate-100"
                >
                  <option value="">-- Ninguno --</option>
                  {inventoryItems.map((it) => (
                    <option key={it.id} value={it.id}>
                      {it.name}
                    </option>
                  ))}
                </select>
                {opt.giveItems && Object.keys(opt.giveItems).length > 0 && (
                  <p className="mt-1 text-[10px] text-emerald-400/80">
                    Entrega múltiple heredada: {Object.keys(opt.giveItems).length} objeto(s)
                  </p>
                )}
              </div>

              <div>
                <label className="block text-[11px] font-medium text-amber-300 mb-1">
                  Modificar bandera global
                </label>
                <div className="flex gap-1.5">
                  <select
                    value={setFlagKey}
                    onChange={(e) => {
                      const fk = e.target.value;
                      handleUpdateOption(node.id, opt.id, {
                        ...opt,
                        setFlags: fk ? { [fk]: setFlagVal } : undefined,
                      });
                    }}
                    className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg text-xs border border-slate-700 bg-slate-900 text-slate-100 font-mono"
                  >
                    <option value="">-- Sin cambio --</option>
                    {globalFlagKeys.map((fk) => (
                      <option key={fk} value={fk}>
                        {fk}
                      </option>
                    ))}
                  </select>
                  {setFlagKey && (
                    <select
                      value={setFlagVal ? 'true' : 'false'}
                      onChange={(e) =>
                        handleUpdateOption(node.id, opt.id, {
                          ...opt,
                          setFlags: { [setFlagKey]: e.target.value === 'true' },
                        })
                      }
                      className="px-2 py-1.5 rounded-lg text-xs font-bold border border-slate-700 bg-slate-900 text-amber-300"
                    >
                      <option value="true">TRUE</option>
                      <option value="false">FALSE</option>
                    </select>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-300 mb-1">
                  Añadir párrafo extra a la narración
                </label>
                <AutoGrowTextarea
                  value={opt.appendStoryText || ''}
                  onChange={(e) =>
                    handleUpdateOption(node.id, opt.id, {
                      ...opt,
                      appendStoryText: e.target.value || undefined,
                    })
                  }
                  placeholder="Opcional: párrafo narrativo que aparece en la escena..."
                  className="w-full px-2.5 py-1.5 rounded-lg text-xs border border-slate-700 bg-slate-900 text-slate-100 font-serif"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-300 mb-1">
                  Efecto de sonido
                </label>
                <select
                  value={opt.soundEffect || 'none'}
                  onChange={(e) =>
                    handleUpdateOption(node.id, opt.id, {
                      ...opt,
                      soundEffect: (e.target.value as SoundEffectType) || undefined,
                    })
                  }
                  className="w-full px-2.5 py-1.5 rounded-lg text-xs border border-slate-700 bg-slate-900 text-slate-100"
                >
                  <option value="none">Sin sonido</option>
                  <option value="stop_music">Detener música de fondo</option>
                  {project.customSounds && project.customSounds.length > 0 && (
                    <optgroup label={`Sonidos de ${project.title || 'este proyecto'}`}>
                      {project.customSounds.map((cs) => (
                        <option key={cs.id} value={cs.id}>
                          {cs.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  <optgroup label="Biblioteca oficial">
                    {getAllMergedSounds(project)
                      .filter((s) => s.isGlobal || !project.customSounds?.some((cs) => cs.id === s.id))
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                  </optgroup>
                </select>
              </div>

              <label className="flex items-center gap-2 cursor-pointer text-xs text-rose-300 pt-1">
                <input
                  type="checkbox"
                  checked={!!opt.isGameOver}
                  onChange={(e) =>
                    handleUpdateOption(node.id, opt.id, { ...opt, isGameOver: e.target.checked })
                  }
                  className="rounded text-rose-500"
                />
                <span>Provoca Fin de Partida (Muerte / Final)</span>
              </label>
            </div>
          )}
        </div>
      </div>
    );
  };

  // Node Inspector
  const renderNodeInspector = (node: DialogueNode) => {
    const isStart = node.id === initialNodeId;
    const isNpcOnly = node.nodeType === 'npc_only';

    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2 pb-2.5 border-b border-slate-800">
          <div className="min-w-0">
            <span className="text-[11px] font-medium text-slate-400">
              {isStart ? 'Nodo inicial' : isNpcOnly ? 'Réplica encadenada' : 'Nodo de diálogo'}
            </span>
            <h6 className="text-sm font-bold text-slate-100 truncate">{node.title || 'Sin título'}</h6>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => handleDuplicateNode(node)}
              title="Duplicar nodo"
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 cursor-pointer"
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
            {nodes.length > 1 && (
              <button
                type="button"
                onClick={() => handleDeleteNode(node.id)}
                title="Eliminar nodo"
                className="p-1.5 rounded-lg text-rose-400 hover:bg-rose-500/10 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-[11px] font-semibold text-slate-300 mb-1">
              Título del nodo (referencia interna)
            </label>
            <input
              type="text"
              value={node.title}
              onChange={(e) => handleUpdateNode({ ...node, title: e.target.value })}
              className="w-full px-3 py-1.5 rounded-lg text-xs border border-slate-700 bg-slate-900 text-slate-100 focus:outline-none focus:border-amber-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                Tipo de nodo
              </label>
              <select
                value={isNpcOnly ? 'npc_only' : 'dialogue'}
                onChange={(e) =>
                  handleUpdateNode({
                    ...node,
                    nodeType: e.target.value as 'dialogue' | 'npc_only',
                  })
                }
                className="w-full px-2.5 py-1.5 rounded-lg text-xs border border-slate-700 bg-slate-900 text-slate-100"
              >
                <option value="dialogue">Con opciones del jugador</option>
                <option value="npc_only">Solo réplica (Continuar)</option>
              </select>
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                Personaje que habla
              </label>
              <select
                value={node.speakerCharacterId || ''}
                onChange={(e) =>
                  handleUpdateNode({
                    ...node,
                    speakerCharacterId: e.target.value || undefined,
                  })
                }
                className="w-full px-2.5 py-1.5 rounded-lg text-xs border border-slate-700 bg-slate-900 text-amber-200"
              >
                <option value="">
                  Por defecto ({primaryChar?.name || 'Principal'})
                </option>
                {characters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-slate-300 mb-1">
              {isNpcOnly ? 'Frase del personaje en este turno' : 'Intervención del personaje al llegar'}
            </label>
            <AutoGrowTextarea
              value={node.npcPrompt || ''}
              onChange={(e) => handleUpdateNode({ ...node, npcPrompt: e.target.value })}
              placeholder="Ej: ¡Dime qué buscas antes de que cambie de opinión!"
              className="w-full px-3 py-2 rounded-lg text-xs border border-slate-700 bg-slate-900 text-slate-100 font-serif leading-relaxed focus:outline-none focus:border-amber-500"
            />
          </div>

          {!isStart && (
            <button
              type="button"
              onClick={() => commitNodes(nodes, node.id)}
              className="w-full py-1.5 px-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 text-xs font-semibold transition-colors cursor-pointer"
            >
              Establecer como nodo de inicio
            </button>
          )}
        </div>

        {/* Either NPC-only continuation OR player options list */}
        {isNpcOnly ? (
          <div className="pt-3 border-t border-slate-800 space-y-2.5">
            <label className="block text-[11px] font-semibold text-sky-300">
              Al pulsar "Continuar", ir a:
            </label>
            <select
              value={node.autoEndConversation ? 'end' : node.autoNextNodeId || ''}
              onChange={(e) => {
                const val = e.target.value;
                if (val === 'end') {
                  handleUpdateNode({ ...node, autoEndConversation: true, autoNextNodeId: undefined });
                } else {
                  handleUpdateNode({ ...node, autoEndConversation: false, autoNextNodeId: val || undefined });
                }
              }}
              className="w-full px-2.5 py-2 rounded-lg text-xs border border-slate-700 bg-slate-900 text-slate-100 font-semibold"
            >
              <option value="end">Finalizar conversación</option>
              {nodes
                .filter((n) => n.id !== node.id)
                .map((n) => {
                  const srcPos = effectivePositions[node.id];
                  const dstPos = effectivePositions[n.id];
                  const isRet = srcPos && dstPos ? dstPos.x < srcPos.x - 25 || dstPos.layer <= srcPos.layer : false;
                  return (
                    <option key={n.id} value={n.id}>
                      {isRet ? '↩ Retornar a: ' : '➔ Continuar en: '}
                      {n.title}
                      {n.id === initialNodeId ? ' (Inicio)' : ''}
                    </option>
                  );
                })}
            </select>
          </div>
        ) : (
          <div className="pt-3 border-t border-slate-800 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-200">
                Opciones del jugador ({node.options.length})
              </span>
              <button
                type="button"
                onClick={() => handleAddOptionToNode(node.id)}
                className="px-2.5 py-1 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-[11px] flex items-center gap-1 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Añadir opción</span>
              </button>
            </div>

            {node.options.length === 0 ? (
              <p className="text-xs text-slate-500 italic py-2">
                Sin opciones. Añade una arriba o arrastra desde el nodo anterior.
              </p>
            ) : (
              <div className="space-y-1.5">
                {node.options.map((opt, idx) => {
                  const dst = opt.nextNodeId ? nodes.find((n) => n.id === opt.nextNodeId) : null;
                  return (
                    <div
                      key={opt.id}
                      className="flex items-center gap-1.5 p-2 rounded-lg border border-slate-800 bg-slate-900/70 hover:border-slate-700 transition-colors"
                    >
                      <button
                        type="button"
                        onClick={() => setSelectedOptionId(opt.id)}
                        className="flex-1 min-w-0 text-left cursor-pointer"
                      >
                        <div className="text-xs font-medium text-slate-100 truncate">
                          {opt.playerText || '(Opción sin texto)'}
                        </div>
                        <div className="text-[10px] text-slate-400 truncate mt-0.5">
                          {opt.goToSceneId
                            ? 'Salta de escena'
                            : opt.endConversation || opt.nextNodeId === 'end'
                            ? 'Cierra conversación'
                            : dst
                            ? `Va a: ${dst.title}`
                            : 'Permanece en este nodo'}
                          {opt.isOneTime ? ' · 1 uso' : ''}
                        </div>
                      </button>

                      <div className="flex flex-col gap-0.5 shrink-0">
                        <button
                          type="button"
                          disabled={idx === 0}
                          onClick={() => handleMoveOption(node.id, idx, -1)}
                          className="p-0.5 text-slate-500 hover:text-slate-200 disabled:opacity-25 cursor-pointer"
                          title="Subir"
                        >
                          <ChevronUp className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          disabled={idx === node.options.length - 1}
                          onClick={() => handleMoveOption(node.id, idx, 1)}
                          className="p-0.5 text-slate-500 hover:text-slate-200 disabled:opacity-25 cursor-pointer"
                          title="Bajar"
                        >
                          <ChevronDown className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="pt-2">
              <label className="block text-[11px] font-medium text-slate-400 mb-1">
                Texto si ya no quedan opciones disponibles (opcional)
              </label>
              <input
                type="text"
                value={node.exhaustedMessage || ''}
                onChange={(e) =>
                  handleUpdateNode({ ...node, exhaustedMessage: e.target.value || undefined })
                }
                placeholder="Ej: Ya te he contado todo lo que sé."
                className="w-full px-2.5 py-1.5 rounded-lg text-xs border border-slate-800 bg-slate-900 text-slate-200 focus:outline-none focus:border-amber-500"
              />
            </div>
          </div>
        )}
      </div>
    );
  };

  // Minimap bounds calculation
  const minimapData = useMemo(() => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    nodes.forEach((n) => {
      const pos = effectivePositions[n.id] || { x: CANVAS_PAD_X, y: CANVAS_PAD_Y };
      const h = nodeHeights[n.id] || estimateNodeHeight(n);
      minX = Math.min(minX, pos.x - 100);
      minY = Math.min(minY, pos.y - 40);
      maxX = Math.max(maxX, pos.x + NODE_WIDTH + 60);
      maxY = Math.max(maxY, pos.y + h + 40);
    });

    const w = Math.max(400, maxX - minX);
    const h = Math.max(260, maxY - minY);
    const boxW = 168;
    const boxH = 104;
    const scale = Math.min(boxW / w, boxH / h);

    return { minX, minY, w, h, boxW, boxH, scale };
  }, [nodes, effectivePositions, nodeHeights]);

  // Render full visual node-graph workspace
  return (
    <div className="flex flex-col h-full min-h-[540px] bg-[#0b0f18] text-slate-100 rounded-xl border border-slate-800 overflow-hidden select-none">
      {/* Top Toolbar */}
      <div className="px-3.5 py-2.5 border-b border-slate-800 bg-slate-950 flex flex-wrap items-center justify-between gap-3 shrink-0">
        {/* Left: Primary speaker & actions */}
        <div className="flex items-center gap-2.5 flex-wrap">
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] font-semibold text-slate-400 whitespace-nowrap">
              Personaje:
            </label>
            <select
              value={dialogue.characterId}
              onChange={(e) => onChange({ ...dialogue, characterId: e.target.value })}
              className="px-2.5 py-1 rounded-lg text-xs border border-slate-700 bg-slate-900 text-amber-200 font-semibold focus:outline-none focus:border-amber-500 max-w-[175px]"
            >
              <option value="">-- Seleccionar --</option>
              {characters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>

            {onEnsureCharacter && (
              <button
                type="button"
                onClick={() => setShowInlineNewChar((v) => !v)}
                className="p-1.5 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-emerald-400 cursor-pointer"
                title="Crear personaje nuevo"
              >
                <UserPlus className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {showInlineNewChar && onEnsureCharacter && (
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={newInlineCharName}
                onChange={(e) => setNewInlineCharName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newInlineCharName.trim()) {
                    e.preventDefault();
                    const created = onEnsureCharacter(newInlineCharName.trim());
                    onChange({ ...dialogue, characterId: created.id });
                    setNewInlineCharName('');
                    setShowInlineNewChar(false);
                  }
                }}
                placeholder={suggestedCharacterName || 'Nombre...'}
                className="w-32 px-2 py-1 rounded-lg text-xs border border-slate-700 bg-slate-900 text-slate-100 focus:outline-none focus:border-amber-500"
              />
              <button
                type="button"
                onClick={() => {
                  const target = newInlineCharName.trim() || suggestedCharacterName || 'Personaje';
                  const created = onEnsureCharacter(target);
                  onChange({ ...dialogue, characterId: created.id });
                  setNewInlineCharName('');
                  setShowInlineNewChar(false);
                }}
                className="px-2 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold cursor-pointer"
              >
                Crear
              </button>
            </div>
          )}

          <div className="h-4 w-px bg-slate-800 hidden sm:block" />

          <button
            type="button"
            onClick={() => handleAddNode('dialogue')}
            className="px-2.5 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Nodo con opciones</span>
          </button>

          <button
            type="button"
            onClick={() => handleAddNode('npc_only')}
            className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-sky-300 border border-slate-700 font-semibold text-xs flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Réplica NPC</span>
          </button>

          <button
            type="button"
            onClick={handleAutoArrangeAll}
            className="px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 text-xs font-medium flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
            title="Reorganizar nodos automáticamente sin solapamientos"
          >
            <LayoutGrid className="w-3.5 h-3.5" />
            <span>Auto-ordenar</span>
          </button>

          {activeNode && (
            <button
              type="button"
              onClick={() => handleDeleteNode(activeNode.id)}
              className="px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-rose-500/15 text-rose-300 border border-rose-500/25 text-xs font-medium flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
              title={`Quitar nodo seleccionado (${activeNode.title || 'Sin título'})`}
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Quitar nodo</span>
            </button>
          )}
        </div>

        {/* Right: Story transcript option, simulator, delete */}
        <div className="flex items-center gap-2.5 flex-wrap">
          <label
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-slate-800 bg-slate-900/70 text-[11px] text-slate-300 cursor-pointer hover:border-slate-700 whitespace-nowrap"
            title="Si está activo, transcribe las preguntas y respuestas en el texto de la escena"
          >
            <input
              type="checkbox"
              checked={!!dialogue.insertConversationInStory}
              onChange={(e) =>
                onChange({ ...dialogue, insertConversationInStory: e.target.checked })
              }
              className="rounded text-amber-500 cursor-pointer"
            />
            <span>Insertar en narración</span>
          </label>

          <button
            type="button"
            onClick={() => {
              if (inspectorTab === 'simulator') {
                setInspectorTab('properties');
              } else {
                resetSimulator();
                setInspectorTab('simulator');
              }
            }}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 cursor-pointer whitespace-nowrap border transition-colors ${
              inspectorTab === 'simulator'
                ? 'bg-emerald-500 text-slate-950 border-emerald-400'
                : 'bg-slate-900 hover:bg-slate-800 text-emerald-300 border-emerald-500/30'
            }`}
          >
            <Play className="w-3.5 h-3.5" />
            <span>{inspectorTab === 'simulator' ? 'Probando...' : 'Probar diálogo'}</span>
          </button>

          <button
            type="button"
            onClick={() => setPendingConfirm({ type: 'delete_dialogue' })}
            className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-rose-400 hover:bg-rose-500/10 border border-rose-500/20 flex items-center gap-1 cursor-pointer whitespace-nowrap"
            title="Eliminar toda la conversación"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span className="hidden md:inline">Borrar diálogo</span>
          </button>
        </div>
      </div>

      {uiNotice && (
        <div className="px-4 py-2 bg-amber-500/15 border-b border-amber-500/30 text-amber-200 text-xs flex items-center justify-between gap-3 shrink-0">
          <span>{uiNotice}</span>
          <button
            type="button"
            onClick={() => setUiNotice(null)}
            className="text-amber-300 hover:text-white font-semibold cursor-pointer"
          >
            Cerrar
          </button>
        </div>
      )}

      {/* Main Split Workspace: Canvas + Right Inspector */}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-hidden">
        {/* Interactive Visual Node Canvas */}
        <div
          ref={canvasRef}
          onWheel={(e) => {
            e.preventDefault();
            const rect = canvasRef.current?.getBoundingClientRect();
            if (!rect) return;
            const factor = e.deltaY < 0 ? 1.09 : 0.91;
            const newZoom = Math.max(0.45, Math.min(1.5, viewport.zoom * factor));
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            const wx = (mouseX - viewport.panX) / viewport.zoom;
            const wy = (mouseY - viewport.panY) / viewport.zoom;
            setViewport({
              zoom: newZoom,
              panX: mouseX - wx * newZoom,
              panY: mouseY - wy * newZoom,
            });
          }}
          onPointerDown={(e) => {
            if (e.button !== 0 && e.button !== 1) return;
            setPanningCanvas({
              startClientX: e.clientX,
              startClientY: e.clientY,
              origPanX: viewport.panX,
              origPanY: viewport.panY,
            });
          }}
          className="relative flex-1 min-h-[320px] overflow-hidden cursor-grab active:cursor-grabbing"
          style={{
            backgroundColor: '#090d16',
            backgroundImage:
              'radial-gradient(rgba(148, 163, 184, 0.16) 1px, transparent 1px)',
            backgroundSize: `${Math.round(24 * viewport.zoom)}px ${Math.round(24 * viewport.zoom)}px`,
            backgroundPosition: `${viewport.panX}px ${viewport.panY}px`,
          }}
        >
          {/* Transformed World Layer */}
          <div
            style={{
              transform: `translate(${viewport.panX}px, ${viewport.panY}px) scale(${viewport.zoom})`,
              transformOrigin: '0 0',
              position: 'absolute',
              inset: 0,
              pointerEvents: 'none',
            }}
          >
            {/* SVG Connections Layer */}
            <svg
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                overflow: 'visible',
                width: 1,
                height: 1,
                pointerEvents: 'none',
              }}
            >
              <defs>
                <marker
                  id="arrow-forward"
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto"
                >
                  <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="#f59e0b" />
                </marker>
                <marker
                  id="arrow-forward-active"
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto"
                >
                  <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="#fde047" />
                </marker>
                <marker
                  id="arrow-return"
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto"
                >
                  <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="#2dd4bf" />
                </marker>
                <marker
                  id="arrow-start"
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto"
                >
                  <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="#10b981" />
                </marker>
              </defs>

              {/* Wire from Start Badge to Initial Node */}
              {(() => {
                const startPos = effectivePositions[initialNodeId];
                if (!startPos) return null;
                const sx = startPos.x - 42;
                const sy = startPos.y + 22;
                const tx = startPos.x - 4;
                const ty = startPos.y + 22;
                return (
                  <path
                    d={`M ${sx} ${sy} L ${tx} ${ty}`}
                    fill="none"
                    stroke="#10b981"
                    strokeWidth={2.5}
                    markerEnd="url(#arrow-start)"
                  />
                );
              })()}

              {/* Option / Continuation Wires */}
              {wireEdges.map((edge, idx) => {
                const isHovered = hoveredWireKey === edge.key;
                const d = computeBezierPath(
                  edge.sx,
                  edge.sy,
                  edge.tx - 4,
                  edge.ty,
                  edge.isReturn,
                  idx
                );
                const strokeColor = edge.isReturn
                  ? '#2dd4bf'
                  : edge.isSelected || isHovered
                  ? '#fde047'
                  : '#f59e0b';

                return (
                  <g key={edge.key} style={{ pointerEvents: 'stroke' }}>
                    {/* Wide invisible hit target for easy wire selection */}
                    <path
                      d={d}
                      fill="none"
                      stroke="transparent"
                      strokeWidth={14}
                      className="cursor-pointer"
                      onPointerEnter={() => setHoveredWireKey(edge.key)}
                      onPointerLeave={() => setHoveredWireKey(null)}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        setSelectedNodeId(edge.sourceNodeId);
                        setSelectedOptionId(edge.optionId === 'auto' ? null : edge.optionId);
                        setInspectorTab('properties');
                      }}
                    />
                    <path
                      d={d}
                      fill="none"
                      stroke={strokeColor}
                      strokeWidth={edge.isSelected || isHovered ? 3 : 2}
                      strokeDasharray={edge.isReturn ? '6 4' : undefined}
                      strokeOpacity={edge.isSelected || isHovered ? 1 : 0.82}
                      markerEnd={
                        edge.isReturn
                          ? 'url(#arrow-return)'
                          : edge.isSelected || isHovered
                          ? 'url(#arrow-forward-active)'
                          : 'url(#arrow-forward)'
                      }
                    />
                  </g>
                );
              })}

              {/* Live Dragging Preview Wire */}
              {connectingWire && connectingWire.moved && (
                <path
                  d={computeBezierPath(
                    connectingWire.startX,
                    connectingWire.startY,
                    connectingWire.curX,
                    connectingWire.curY,
                    connectingWire.curX < connectingWire.startX - 25
                  )}
                  fill="none"
                  stroke="#fde047"
                  strokeWidth={2.5}
                  strokeDasharray="5 4"
                />
              )}
            </svg>

            {/* Start Badge Node */}
            {(() => {
              const startPos = effectivePositions[initialNodeId];
              if (!startPos) return null;
              return (
                <div
                  style={{
                    position: 'absolute',
                    left: startPos.x - 96,
                    top: startPos.y + 4,
                    pointerEvents: 'auto',
                  }}
                  className="flex flex-col items-center gap-1"
                >
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      resetSimulator();
                      setInspectorTab('simulator');
                    }}
                    title="Probar conversación desde el inicio"
                    className="w-9 h-9 rounded-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 flex items-center justify-center shadow-lg cursor-pointer transition-transform hover:scale-105"
                  >
                    <Play className="w-4 h-4 fill-current ml-0.5" />
                  </button>
                  <span className="text-[10px] font-semibold text-emerald-400">Inicio</span>
                </div>
              );
            })()}

            {/* Dialogue Node Cards */}
            {nodes.map((node) => {
              const pos = effectivePositions[node.id] || { x: CANVAS_PAD_X, y: CANVAS_PAD_Y, layer: 0 };
              const isStart = node.id === initialNodeId;
              const isSelected = node.id === selectedNodeId;
              const isSimActive = inspectorTab === 'simulator' && simCurrentNode?.id === node.id && !simEnded;
              const isDropTarget = connectingWire?.moved && hoveredTargetNodeId === node.id;
              const isNpcOnly = node.nodeType === 'npc_only';

              const speaker =
                (node.speakerCharacterId
                  ? characters.find((c) => c.id === node.speakerCharacterId)
                  : null) || primaryChar;
              const speakerImg = speaker?.imageFileData || speaker?.imageUrl;

              return (
                <div
                  key={node.id}
                  ref={(el) => {
                    nodeCardRefs.current[node.id] = el;
                  }}
                  style={{
                    position: 'absolute',
                    left: pos.x,
                    top: pos.y,
                    width: NODE_WIDTH,
                    pointerEvents: 'auto',
                  }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                  }}
                  className={`rounded-xl border bg-[#111827] shadow-xl transition-shadow ${
                    isDropTarget
                      ? 'border-amber-300 ring-2 ring-amber-400/50'
                      : isSimActive
                      ? 'border-emerald-400 ring-2 ring-emerald-400/35'
                      : isSelected
                      ? 'border-amber-500 ring-2 ring-amber-500/20'
                      : 'border-slate-700/80 hover:border-slate-600'
                  }`}
                >
                  {/* Left Input Port */}
                  <div
                    title="Puerto de entrada"
                    className={`absolute -left-2 top-[16px] w-3.5 h-3.5 rounded-full border-2 transition-transform ${
                      isDropTarget
                        ? 'bg-amber-300 border-slate-950 scale-125'
                        : isStart
                        ? 'bg-emerald-400 border-slate-950'
                        : 'bg-slate-600 border-slate-950'
                    }`}
                  />

                  {/* Node Header (Drag Handle) */}
                  <div
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.stopPropagation();
                      setDraggingNode({
                        nodeId: node.id,
                        startClientX: e.clientX,
                        startClientY: e.clientY,
                        origX: pos.x,
                        origY: pos.y,
                        curX: pos.x,
                        curY: pos.y,
                        moved: false,
                      });
                    }}
                    className={`px-3 py-2 rounded-t-[11px] flex items-center gap-2 cursor-move border-b ${
                      isNpcOnly
                        ? 'bg-sky-950/70 border-sky-500/25'
                        : isStart
                        ? 'bg-emerald-950/50 border-emerald-500/25'
                        : 'bg-slate-900 border-slate-800'
                    }`}
                  >
                    {speakerImg ? (
                      <img
                        src={speakerImg}
                        alt={speaker?.name || 'NPC'}
                        className="w-6 h-6 rounded object-cover shrink-0 border border-white/10"
                      />
                    ) : (
                      <div className="w-6 h-6 rounded bg-amber-500/20 text-amber-300 text-[11px] font-bold flex items-center justify-center shrink-0">
                        {(speaker?.name || 'P').charAt(0).toUpperCase()}
                      </div>
                    )}

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-1.5">
                        <span className="text-xs font-bold text-slate-100 truncate">
                          {node.title || 'Nodo'}
                        </span>
                        {(isStart || isNpcOnly) && (
                          <span
                            className={`text-[10px] font-semibold shrink-0 ${
                              isNpcOnly ? 'text-sky-300' : 'text-emerald-300'
                            }`}
                          >
                            {isNpcOnly ? 'Réplica' : 'Inicio'}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* NPC Prompt Preview */}
                  <div
                    onClick={() => {
                      setSelectedNodeId(node.id);
                      setSelectedOptionId(null);
                      setInspectorTab('properties');
                    }}
                    className="px-3 py-2 border-b border-slate-800/80 cursor-pointer hover:bg-slate-800/30"
                  >
                    <p className="text-[11px] text-slate-300 font-serif italic line-clamp-2 leading-snug">
                      "{node.npcPrompt || '...'}"
                    </p>
                  </div>

                  {/* Options List OR NPC-only Continue Footer */}
                  {isNpcOnly ? (
                    <div
                      ref={(el) => {
                        portRowRefs.current[`${node.id}::auto`] = el;
                      }}
                      onClick={() => {
                        setSelectedNodeId(node.id);
                        setSelectedOptionId(null);
                        setInspectorTab('properties');
                      }}
                      className="relative px-3 pr-4 py-2 flex items-center justify-between text-xs text-sky-200 cursor-pointer hover:bg-slate-800/40 rounded-b-[11px]"
                    >
                      <span className="font-medium flex items-center gap-1.5">
                        {node.autoEndConversation || !node.autoNextNodeId ? (
                          <>
                            <Square className="w-3 h-3 text-slate-400" />
                            <span>Finalizar charla</span>
                          </>
                        ) : (
                          <>
                            <ArrowRight className="w-3.5 h-3.5 text-sky-400" />
                            <span>Continuar</span>
                          </>
                        )}
                      </span>

                      {/* Draggable Output Port */}
                      <div
                        title="Arrastra hacia otro nodo o al lienzo vacío para conectar"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          const portOffsetY = portYOffsets[`${node.id}::auto`] ?? (estimateNodeHeight(node) - 20);
                          const sx = pos.x + NODE_WIDTH;
                          const sy = pos.y + portOffsetY;
                          setConnectingWire({
                            sourceNodeId: node.id,
                            optionId: 'auto',
                            startX: sx,
                            startY: sy,
                            curX: sx,
                            curY: sy,
                            moved: false,
                          });
                        }}
                        className="absolute -right-[7px] top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-sky-400 hover:bg-amber-300 border-2 border-slate-950 cursor-crosshair transition-transform hover:scale-125"
                      />
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-800/70">
                      {(node.options || []).map((opt) => {
                        const isOptSelected =
                          selectedNodeId === node.id && selectedOptionId === opt.id;
                        const dstPos = opt.nextNodeId ? effectivePositions[opt.nextNodeId] : null;
                        const isReturnOpt =
                          dstPos &&
                          (dstPos.x < pos.x - 25 ||
                            opt.nextNodeId === node.id ||
                            dstPos.layer <= pos.layer);
                        const hasCond = !!(
                          opt.requiredItemId ||
                          (opt.requiredFlags && Object.keys(opt.requiredFlags).length > 0) ||
                          (opt.visibleIfFlags && Object.keys(opt.visibleIfFlags).length > 0) ||
                          (opt.hiddenIfFlags && Object.keys(opt.hiddenIfFlags).length > 0)
                        );
                        const hasGift = !!(
                          opt.giveItemId ||
                          (opt.giveItems && Object.keys(opt.giveItems).length > 0)
                        );
                        const hasFlag = !!(opt.setFlags && Object.keys(opt.setFlags).length > 0);

                        return (
                          <div
                            key={opt.id}
                            ref={(el) => {
                              portRowRefs.current[`${node.id}::${opt.id}`] = el;
                            }}
                            onClick={() => {
                              setSelectedNodeId(node.id);
                              setSelectedOptionId(opt.id);
                              setInspectorTab('properties');
                            }}
                            className={`relative px-3 pr-4 py-2 flex items-center justify-between gap-2 cursor-pointer transition-colors ${
                              isOptSelected
                                ? 'bg-amber-500/15 text-amber-100'
                                : 'hover:bg-slate-800/45 text-slate-200'
                            }`}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="text-[11px] font-medium truncate">
                                {opt.playerText || '(Sin texto)'}
                              </div>
                              {opt.npcResponse?.trim() && (
                                <div
                                  title={opt.npcResponse.trim()}
                                  className="text-[10px] text-amber-200/75 italic line-clamp-2 leading-snug mt-0.5 pl-2 border-l border-amber-500/35"
                                >
                                  «{opt.npcResponse.trim()}»
                                </div>
                              )}
                            </div>

                            {/* Quiet compact functional markers */}
                            <div className="flex items-center gap-1 shrink-0 text-[10px]">
                              {opt.isOneTime && (
                                <span
                                  title="Un solo uso (se descarta tras elegirla)"
                                  className="font-mono font-bold text-amber-400"
                                >
                                  1×
                                </span>
                              )}
                              {hasCond && (
                                <span title="Tiene condiciones">
                                  <Lock className="w-3 h-3 text-slate-400" />
                                </span>
                              )}
                              {hasGift && (
                                <span title="Entrega objeto">
                                  <Gift className="w-3 h-3 text-emerald-400" />
                                </span>
                              )}
                              {hasFlag && (
                                <span title="Modifica bandera">
                                  <Flag className="w-3 h-3 text-amber-300" />
                                </span>
                              )}
                              {opt.goToSceneId && (
                                <span title="Cambia de escena">
                                  <DoorOpen className="w-3 h-3 text-sky-400" />
                                </span>
                              )}
                              {(opt.endConversation || opt.nextNodeId === 'end') && !opt.goToSceneId && (
                                <span title="Finaliza conversación" className="text-slate-400 font-semibold">
                                  Fin
                                </span>
                              )}
                              {isReturnOpt && !opt.endConversation && !opt.goToSceneId && (
                                <span title="Retorno a nodo previo" className="text-teal-300 font-bold">
                                  ↩
                                </span>
                              )}
                            </div>

                            {/* Individual Output Port Dot */}
                            {!opt.goToSceneId && (
                              <div
                                title="Arrastra hacia otro nodo (para conectar o retornar) o al fondo para crear uno nuevo"
                                onPointerDown={(e) => {
                                  e.stopPropagation();
                                  const portOffsetY =
                                    portYOffsets[`${node.id}::${opt.id}`] ?? 120;
                                  const sx = pos.x + NODE_WIDTH;
                                  const sy = pos.y + portOffsetY;
                                  setConnectingWire({
                                    sourceNodeId: node.id,
                                    optionId: opt.id,
                                    startX: sx,
                                    startY: sy,
                                    curX: sx,
                                    curY: sy,
                                    moved: false,
                                  });
                                }}
                                className={`absolute -right-[7px] top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full border-2 border-slate-950 cursor-crosshair transition-transform hover:scale-125 ${
                                  opt.endConversation || opt.nextNodeId === 'end'
                                    ? 'bg-slate-500 hover:bg-amber-300'
                                    : isReturnOpt
                                    ? 'bg-teal-400 hover:bg-amber-300'
                                    : opt.nextNodeId
                                    ? 'bg-amber-400 hover:bg-yellow-300'
                                    : 'bg-slate-600 hover:bg-amber-300'
                                }`}
                              />
                            )}
                          </div>
                        );
                      })}

                      {/* Inline Add Option Footer */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleAddOptionToNode(node.id);
                        }}
                        className="w-full px-3 py-1.5 text-[11px] font-medium text-slate-400 hover:text-amber-300 hover:bg-slate-800/40 flex items-center justify-center gap-1 rounded-b-[11px] cursor-pointer transition-colors"
                      >
                        <Plus className="w-3 h-3" />
                        <span>Añadir opción</span>
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Floating Canvas Controls (Bottom-Left): Legend & Zoom */}
          <div
            onPointerDown={(e) => e.stopPropagation()}
            className="absolute bottom-3 left-3 flex flex-wrap items-center gap-2 z-10"
          >
            <div className="flex items-center gap-1 px-1.5 py-1 rounded-lg bg-slate-950/90 border border-slate-800 shadow-lg text-xs">
              <button
                type="button"
                onClick={() =>
                  setViewport((v) => ({ ...v, zoom: Math.max(0.45, +(v.zoom - 0.12).toFixed(2)) }))
                }
                className="p-1 text-slate-300 hover:text-white cursor-pointer"
                title="Alejar"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <span className="px-1.5 text-[11px] font-mono tabular-nums text-slate-300">
                {Math.round(viewport.zoom * 100)}%
              </span>
              <button
                type="button"
                onClick={() =>
                  setViewport((v) => ({ ...v, zoom: Math.min(1.5, +(v.zoom + 0.12).toFixed(2)) }))
                }
                className="p-1 text-slate-300 hover:text-white cursor-pointer"
                title="Acercar"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={fitView}
                className="p-1 text-slate-300 hover:text-amber-300 cursor-pointer border-l border-slate-800 pl-1.5"
                title="Encuadrar conversación completa"
              >
                <Maximize2 className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setShowMinimap((v) => !v)}
                className={`p-1 cursor-pointer border-l border-slate-800 pl-1.5 ${
                  showMinimap ? 'text-amber-400' : 'text-slate-400 hover:text-white'
                }`}
                title="Mostrar / ocultar minimapa"
              >
                <MapIcon className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="hidden sm:flex items-center gap-3 px-2.5 py-1.5 rounded-lg bg-slate-950/85 border border-slate-800 text-[10px] text-slate-400">
              <span className="flex items-center gap-1">
                <span className="w-3 h-0.5 bg-amber-400 inline-block" /> Avance
              </span>
              <span className="flex items-center gap-1">
                <span className="w-3 h-0.5 border-t border-dashed border-teal-400 inline-block" /> Retorno
              </span>
              <span>Arrastra desde un punto derecho para conectar o crear nodo</span>
            </div>
          </div>

          {/* Interactive Minimap (Bottom-Right) */}
          {showMinimap && nodes.length > 0 && (
            <div
              onPointerDown={(e) => {
                e.stopPropagation();
                const rect = e.currentTarget.getBoundingClientRect();
                const canvasRect = canvasRef.current?.getBoundingClientRect();
                if (!canvasRect) return;
                const clickWorldX =
                  minimapData.minX + (e.clientX - rect.left) / minimapData.scale;
                const clickWorldY =
                  minimapData.minY + (e.clientY - rect.top) / minimapData.scale;
                setViewport((v) => ({
                  ...v,
                  panX: canvasRect.width / 2 - clickWorldX * v.zoom,
                  panY: canvasRect.height / 2 - clickWorldY * v.zoom,
                }));
              }}
              style={{ width: minimapData.boxW, height: minimapData.boxH }}
              className="absolute bottom-3 right-3 z-10 rounded-lg bg-slate-950/90 border border-slate-800 shadow-xl overflow-hidden cursor-pointer hidden md:block"
              title="Haz clic para centrar esa zona"
            >
              <svg width={minimapData.boxW} height={minimapData.boxH}>
                {nodes.map((n) => {
                  const pos = effectivePositions[n.id] || { x: CANVAS_PAD_X, y: CANVAS_PAD_Y };
                  const h = nodeHeights[n.id] || estimateNodeHeight(n);
                  const rx = (pos.x - minimapData.minX) * minimapData.scale;
                  const ry = (pos.y - minimapData.minY) * minimapData.scale;
                  const rw = Math.max(8, NODE_WIDTH * minimapData.scale);
                  const rh = Math.max(5, h * minimapData.scale);
                  const fill =
                    n.id === selectedNodeId
                      ? '#f59e0b'
                      : n.id === initialNodeId
                      ? '#10b981'
                      : n.nodeType === 'npc_only'
                      ? '#38bdf8'
                      : '#475569';
                  return (
                    <rect
                      key={n.id}
                      x={rx}
                      y={ry}
                      width={rw}
                      height={rh}
                      rx={2}
                      fill={fill}
                      fillOpacity={0.85}
                    />
                  );
                })}
                {canvasRef.current && (() => {
                  const cr = canvasRef.current!.getBoundingClientRect();
                  const vx = (-viewport.panX / viewport.zoom - minimapData.minX) * minimapData.scale;
                  const vy = (-viewport.panY / viewport.zoom - minimapData.minY) * minimapData.scale;
                  const vw = (cr.width / viewport.zoom) * minimapData.scale;
                  const vh = (cr.height / viewport.zoom) * minimapData.scale;
                  return (
                    <rect
                      x={vx}
                      y={vy}
                      width={vw}
                      height={vh}
                      fill="none"
                      stroke="#e2e8f0"
                      strokeOpacity={0.6}
                      strokeWidth={1}
                    />
                  );
                })()}
              </svg>
            </div>
          )}
        </div>

        {/* Right Side Inspector / Simulator Panel */}
        <div className="w-full lg:w-[390px] xl:w-[420px] shrink-0 border-t lg:border-t-0 lg:border-l border-slate-800 bg-slate-950 flex flex-col min-h-[260px] max-h-[45vh] lg:max-h-none">
          {/* Panel Header Tabs */}
          <div className="px-3 pt-2.5 pb-2 border-b border-slate-800 flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => setInspectorTab('properties')}
              className={`flex-1 py-1.5 px-3 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                inspectorTab === 'properties'
                  ? 'bg-slate-800 text-amber-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {activeOption ? 'Editar opción' : 'Editar nodo'}
            </button>
            <button
              type="button"
              onClick={() => {
                resetSimulator();
                setInspectorTab('simulator');
              }}
              className={`flex-1 py-1.5 px-3 rounded-lg text-xs font-semibold transition-colors cursor-pointer flex items-center justify-center gap-1.5 ${
                inspectorTab === 'simulator'
                  ? 'bg-emerald-500/20 text-emerald-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Play className="w-3 h-3" />
              <span>Simulador</span>
            </button>
          </div>

          {/* Panel Body */}
          <div className="flex-1 overflow-y-auto p-4">
            {inspectorTab === 'properties' ? (
              activeNode ? (
                activeOption ? (
                  renderOptionInspector(activeNode, activeOption)
                ) : (
                  renderNodeInspector(activeNode)
                )
              ) : null
            ) : (
              /* Interactive Simulator */
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-2 pb-2 border-b border-slate-800">
                  <span className="text-xs font-semibold text-slate-300">
                    Vista previa interactiva
                  </span>
                  <div className="flex items-center gap-1.5">
                    {(globalFlagKeys.length > 0 || inventoryItems.length > 0) && (
                      <button
                        type="button"
                        onClick={() => setSimShowTestEnv((v) => !v)}
                        className="px-2 py-1 rounded-md text-[11px] bg-slate-900 border border-slate-800 text-slate-300 hover:text-white cursor-pointer"
                      >
                        {simShowTestEnv ? 'Ocultar estado' : 'Estado prueba'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={resetSimulator}
                      className="px-2 py-1 rounded-md text-[11px] bg-slate-900 border border-slate-800 text-amber-300 hover:bg-slate-800 flex items-center gap-1 cursor-pointer"
                    >
                      <RotateCcw className="w-3 h-3" />
                      <span>Reiniciar</span>
                    </button>
                  </div>
                </div>

                {simShowTestEnv && (
                  <div className="p-2.5 rounded-lg border border-slate-800 bg-slate-900/60 space-y-2 text-[11px]">
                    {inventoryItems.length > 0 && (
                      <div>
                        <span className="block font-semibold text-slate-400 mb-1">Objetos en prueba:</span>
                        <div className="flex flex-wrap gap-1.5">
                          {inventoryItems.map((it) => {
                            const has = simInventory.includes(it.id);
                            return (
                              <button
                                key={it.id}
                                type="button"
                                onClick={() =>
                                  setSimInventory((prev) =>
                                    has ? prev.filter((id) => id !== it.id) : [...prev, it.id]
                                  )
                                }
                                className={`px-2 py-0.5 rounded border text-[10px] cursor-pointer ${
                                  has
                                    ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300'
                                    : 'bg-slate-950 border-slate-800 text-slate-400'
                                }`}
                              >
                                {it.name}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {globalFlagKeys.length > 0 && (
                      <div>
                        <span className="block font-semibold text-slate-400 mb-1">Banderas en prueba:</span>
                        <div className="flex flex-wrap gap-1.5">
                          {globalFlagKeys.map((fk) => {
                            const active = !!simFlags[fk];
                            return (
                              <button
                                key={fk}
                                type="button"
                                onClick={() => setSimFlags((prev) => ({ ...prev, [fk]: !active }))}
                                className={`px-2 py-0.5 rounded border font-mono text-[10px] cursor-pointer ${
                                  active
                                    ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                                    : 'bg-slate-950 border-slate-800 text-slate-400'
                                }`}
                              >
                                {fk}: {active ? 'ON' : 'OFF'}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* NPC Bubble */}
                <div className="p-3.5 rounded-xl border border-slate-800 bg-slate-900 space-y-2">
                  <div className="flex items-center gap-2">
                    {simSpeaker.imageFileData || simSpeaker.imageUrl ? (
                      <img
                        src={simSpeaker.imageFileData || simSpeaker.imageUrl}
                        alt={simSpeaker.name}
                        className="w-7 h-7 rounded object-cover"
                      />
                    ) : (
                      <div className="w-7 h-7 rounded bg-amber-500/20 text-amber-300 text-xs font-bold flex items-center justify-center">
                        {simSpeaker.name.charAt(0).toUpperCase()}
                      </div>
                    )}
                    <span className="text-xs font-bold text-amber-300">{simSpeaker.name}</span>
                  </div>

                  <p className="text-sm font-serif text-slate-100 whitespace-pre-line leading-relaxed">
                    "
                    {simNpcReply ||
                      (simCurrentNode?.nodeType !== 'npc_only' &&
                      simAvailableOptions.length === 0 &&
                      simCurrentNode?.exhaustedMessage?.trim()
                        ? simCurrentNode.exhaustedMessage.trim()
                        : simCurrentNode?.npcPrompt || dialogue.greeting || '...')}
                    "
                  </p>

                  {simNotice && (
                    <div className="text-[11px] text-emerald-300 font-medium pt-1">
                      [{simNotice}]
                    </div>
                  )}
                </div>

                {/* Simulator Choices */}
                {simEnded ? (
                  <div className="p-3 rounded-lg border border-slate-800 bg-slate-900/50 text-center space-y-2">
                    <p className="text-xs text-slate-400">Conversación terminada.</p>
                    <button
                      type="button"
                      onClick={resetSimulator}
                      className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold cursor-pointer"
                    >
                      Volver a empezar
                    </button>
                  </div>
                ) : simCurrentNode?.nodeType === 'npc_only' ? (
                  <button
                    type="button"
                    onClick={() => {
                      const nextId =
                        !simCurrentNode.autoEndConversation &&
                        simCurrentNode.autoNextNodeId &&
                        simCurrentNode.autoNextNodeId !== 'end' &&
                        nodes.some((n) => n.id === simCurrentNode.autoNextNodeId)
                          ? simCurrentNode.autoNextNodeId
                          : null;
                      if (nextId) {
                        setSimNodeId(nextId);
                        setSimNpcReply(undefined);
                        setSimNotice(undefined);
                      } else {
                        setSimEnded(true);
                      }
                    }}
                    className="w-full py-2 px-3 rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 text-xs font-bold cursor-pointer"
                  >
                    {!simCurrentNode.autoEndConversation &&
                    simCurrentNode.autoNextNodeId &&
                    simCurrentNode.autoNextNodeId !== 'end'
                      ? 'Continuar →'
                      : 'Finalizar conversación'}
                  </button>
                ) : simAvailableOptions.length > 0 ? (
                  <div className="space-y-1.5">
                    {simAvailableOptions.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => handleSimOption(opt)}
                        className="w-full text-left p-2.5 rounded-lg border border-slate-800 bg-slate-900 hover:border-amber-500/50 hover:bg-slate-800/80 text-xs text-slate-100 transition-colors cursor-pointer flex items-center justify-between gap-2"
                      >
                        <span>"{opt.playerText || '...'}"</span>
                        {opt.isOneTime && (
                          <span className="text-[10px] font-mono text-amber-400 shrink-0">1×</span>
                        )}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs italic text-slate-400 text-center py-2">
                    No quedan opciones disponibles. Reinicia la prueba para volver a empezar.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* In-app Confirmation Modal (avoids blocked native confirm dialogs) */}
      {pendingConfirm && (
        <div
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setPendingConfirm(null)}
          className="fixed inset-0 z-[70] bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-xl border border-slate-700 bg-slate-950 p-5 shadow-2xl space-y-4"
          >
            <h4 className="text-sm font-bold text-slate-100">
              {pendingConfirm.type === 'delete_node'
                ? 'Eliminar nodo de diálogo'
                : 'Eliminar toda la conversación'}
            </h4>
            <p className="text-xs text-slate-300 leading-relaxed">
              {pendingConfirm.type === 'delete_node'
                ? `¿Seguro que deseas eliminar el nodo «${pendingConfirm.title}»? Las opciones que apuntaban a él quedarán desconectadas.`
                : '¿Seguro que deseas borrar por completo este árbol de conversación?'}
            </p>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setPendingConfirm(null)}
                className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => {
                  if (pendingConfirm.type === 'delete_node') {
                    executeDeleteNode(pendingConfirm.nodeId);
                  } else {
                    onChange(undefined);
                  }
                  setPendingConfirm(null);
                }}
                className="px-3.5 py-1.5 rounded-lg text-xs font-bold bg-rose-600 hover:bg-rose-500 text-white cursor-pointer"
              >
                {pendingConfirm.type === 'delete_node' ? 'Sí, quitar nodo' : 'Sí, borrar diálogo'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
