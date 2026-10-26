import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MochiPet, { PET_H, PET_W } from './components/MochiPet';
import NotificationBubble from './components/NotificationBubble';
import TaskPanel from './components/TaskPanel';
import './mochi.css';
import { DEFAULT_GOALS, MOCK_TASKS, WEEKLY_PROGRESS } from './data/mockTasks';
import {
  placeBesidePet,
  placeBubbleAbovePet,
  progressFraction,
} from './logic/format';
import { resolvePetState } from './logic/petState';
import { sortTasks } from './logic/sorting';
import { disableShadow, isTauri, syncTauriWindow } from './tauri';
import type { WindowRect } from './tauri';
import type { Goals, PanelMode, PetNotification, Task, XY } from './types';

const TAURI_MODE = isTauri();

const LS_GOALS = 'mochi.goals.v1';
const LS_POS = 'mochi.petPos.v1';
const LS_HIDDEN = 'mochi.hidden.v1';

/** Screen size in Tauri overlay mode, viewport size in the browser. */
function screenW(): number {
  if (TAURI_MODE && window.screen?.width) return window.screen.width;
  return window.innerWidth;
}

function screenH(): number {
  if (TAURI_MODE && window.screen?.height) return window.screen.height;
  return window.innerHeight;
}

function clampToScreen(x: number, y: number): XY {
  return {
    x: Math.min(Math.max(0, x), Math.max(0, screenW() - PET_W)),
    y: Math.min(Math.max(0, y), Math.max(0, screenH() - PET_H)),
  };
}

function defaultPosition(): XY {
  return clampToScreen(screenW() - PET_W - 24, screenH() - PET_H - 24);
}

function loadGoals(): Goals {
  try {
    const raw = localStorage.getItem(LS_GOALS);
    if (!raw) return DEFAULT_GOALS;
    const parsed = JSON.parse(raw) as Partial<Goals>;
    const reviewGoal =
      typeof parsed.reviewGoal === 'number' &&
      Number.isInteger(parsed.reviewGoal) &&
      parsed.reviewGoal >= 1
        ? parsed.reviewGoal
        : DEFAULT_GOALS.reviewGoal;
    const submissionGoal =
      typeof parsed.submissionGoal === 'number' &&
      Number.isInteger(parsed.submissionGoal) &&
      parsed.submissionGoal >= 1
        ? parsed.submissionGoal
        : DEFAULT_GOALS.submissionGoal;
    return { reviewGoal, submissionGoal };
  } catch {
    return DEFAULT_GOALS;
  }
}

function loadPosition(): XY {
  try {
    const raw = localStorage.getItem(LS_POS);
    if (!raw) return defaultPosition();
    const parsed = JSON.parse(raw) as Partial<XY>;
    if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') {
      return defaultPosition();
    }
    return clampToScreen(parsed.x, parsed.y);
  } catch {
    return defaultPosition();
  }
}

function useViewport() {
  const [viewport, setViewport] = useState({
    w: window.innerWidth,
    h: window.innerHeight,
  });
  useEffect(() => {
    const onResize = () =>
      setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return viewport;
}

const PANEL_BOX: Record<PanelMode, { w: number; h: number }> = {
  overview: { w: 322, h: 452 },
  goals: { w: 322, h: 452 },
  all: { w: 364, h: 484 },
  detail: { w: 364, h: 484 },
};
const BUBBLE_BOX = { w: 264, h: 120 };
const TOOLBAR_BOX = { w: 330, h: 56 };
const RESTORE_BOX = { w: 150, h: 56 };
const UNION_PAD = 12;

/** Bounding box of every visible floating element, in screen coordinates. */
function unionOfVisible(
  rects: WindowRect[],
  max: { w: number; h: number },
): WindowRect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  minX = Math.max(0, minX - UNION_PAD);
  minY = Math.max(0, minY - UNION_PAD);
  maxX = Math.min(max.w, maxX + UNION_PAD);
  maxY = Math.min(max.h, maxY + UNION_PAD);
  return {
    x: Math.floor(minX),
    y: Math.floor(minY),
    w: Math.max(1, Math.ceil(maxX - minX)),
    h: Math.max(1, Math.ceil(maxY - minY)),
  };
}

export default function App() {
  const [goals, setGoals] = useState<Goals>(loadGoals);
  const [position, setPosition] = useState<XY>(loadPosition);
  const [hidden, setHidden] = useState<boolean>(() => {
    try {
      return localStorage.getItem(LS_HIDDEN) === '1';
    } catch {
      return false;
    }
  });
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelMode, setPanelMode] = useState<PanelMode>('overview');
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [notification, setNotification] = useState<PetNotification | null>(null);
  const [notifCount, setNotifCount] = useState(0);
  const [petActive, setPetActive] = useState(false);
  const [lastInteract, setLastInteract] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const viewport = useViewport();

  const touch = useCallback(() => setLastInteract(Date.now()), []);

  // Flag transparent overlay styling for Tauri mode.
  useEffect(() => {
    if (TAURI_MODE) {
      document.documentElement.dataset.tauri = '1';
      void disableShadow();
    }
  }, []);

  // Screen size drives layout in Tauri mode, viewport in the browser.
  const screen = useMemo(
    () => (TAURI_MODE ? { w: screenW(), h: screenH() } : viewport),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewport],
  );

  // 1s ticker so the 10s idle rule re-evaluates without interaction.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Persist goals, position, and hidden flag.
  useEffect(() => {
    try {
      localStorage.setItem(LS_GOALS, JSON.stringify(goals));
    } catch {
      /* storage unavailable: prototype keeps in-memory state */
    }
  }, [goals]);
  useEffect(() => {
    try {
      localStorage.setItem(LS_POS, JSON.stringify(position));
    } catch {
      /* storage unavailable */
    }
  }, [position]);
  useEffect(() => {
    try {
      localStorage.setItem(LS_HIDDEN, hidden ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  }, [hidden]);

  // Keep the pet inside the screen on resize.
  useEffect(() => {
    setPosition((p) => clampToScreen(p.x, p.y));
  }, [viewport]);

  // Notification bubbles are brief: auto-dismiss after 9s.
  useEffect(() => {
    if (!notification) return;
    const id = window.setTimeout(() => setNotification(null), 9000);
    return () => window.clearTimeout(id);
  }, [notification]);

  // Escape closes the panel.
  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPanelOpen(false);
        touch();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panelOpen, touch]);

  const tasks = useMemo(() => sortTasks(MOCK_TASKS), []);
  const petState = resolvePetState({
    panelOpen,
    bubbleVisible: notification !== null,
    hoverOrDrag: petActive,
    idleSeconds: (now - lastInteract) / 1000,
  });

  const reviewFraction = progressFraction(
    WEEKLY_PROGRESS.reviewsCompleted,
    goals.reviewGoal,
  );
  const submissionFraction = progressFraction(
    WEEKLY_PROGRESS.submissionsCompleted,
    goals.submissionGoal,
  );

  const openPanel = useCallback(
    (mode: PanelMode) => {
      setPanelMode(mode);
      setSelectedTask((prev) => (mode === 'detail' ? prev : null));
      setPanelOpen(true);
      touch();
    },
    [touch],
  );

  const handlePetTap = useCallback(() => {
    if (panelOpen) {
      setPanelOpen(false);
    } else {
      setPanelMode('overview');
      setPanelOpen(true);
    }
    touch();
  }, [panelOpen, touch]);

  const simulateNotification = useCallback(() => {
    const task = MOCK_TASKS[notifCount % MOCK_TASKS.length];
    setNotifCount((c) => c + 1);
    setNotification({
      id: Date.now(),
      text: `New ${task.kind} request: ${task.title}`,
      taskId: task.id,
    });
    touch();
  }, [notifCount, touch]);

  const openFromBubble = useCallback(() => {
    if (notification?.taskId) {
      const task = tasks.find((t) => t.id === notification.taskId) ?? null;
      setSelectedTask(task);
      setPanelMode(task ? 'detail' : 'overview');
    } else {
      setPanelMode('overview');
    }
    setNotification(null);
    setPanelOpen(true);
    touch();
  }, [notification, tasks, touch]);

  const panelPos = placeBesidePet(
    { x: position.x, y: position.y, w: PET_W, h: PET_H },
    PANEL_BOX[panelMode],
    screen,
  );
  const bubblePos = placeBubbleAbovePet(
    { x: position.x, y: position.y, w: PET_W, h: PET_H },
    BUBBLE_BOX,
    screen,
  );

  const handleSelectTask = useCallback(
    (task: Task) => {
      setSelectedTask(task);
      setPanelMode('detail');
      touch();
    },
    [touch],
  );

  const handleSaveGoals = useCallback(
    (next: Goals) => {
      setGoals(next);
      touch();
    },
    [touch],
  );

  // In Tauri mode the native window hugs the visible UI: resize/move it
  // to the union rect whenever what is on screen changes.
  const union = useMemo<WindowRect>(() => {
    const rects: WindowRect[] = [];
    if (!hidden) {
      rects.push({ x: position.x, y: position.y, w: PET_W, h: PET_H });
      if (panelOpen) {
        const box = PANEL_BOX[panelMode];
        rects.push({ x: panelPos.left, y: panelPos.top, w: box.w, h: box.h });
      }
      if (notification) {
        rects.push({
          x: bubblePos.left,
          y: bubblePos.top,
          w: BUBBLE_BOX.w,
          h: BUBBLE_BOX.h,
        });
      }
    } else {
      rects.push({
        x: screen.w - RESTORE_BOX.w - 14,
        y: screen.h - RESTORE_BOX.h - 14,
        w: RESTORE_BOX.w,
        h: RESTORE_BOX.h,
      });
    }
    rects.push({
      x: 14,
      y: screen.h - TOOLBAR_BOX.h - 14,
      w: TOOLBAR_BOX.w,
      h: TOOLBAR_BOX.h,
    });
    return unionOfVisible(rects, screen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    hidden,
    position,
    panelOpen,
    panelMode,
    notification,
    screen.w,
    screen.h,
  ]);

  const lastSynced = useRef<WindowRect | null>(null);
  useEffect(() => {
    if (!TAURI_MODE) return;
    const prev = lastSynced.current;
    if (
      prev &&
      prev.x === union.x &&
      prev.y === union.y &&
      prev.w === union.w &&
      prev.h === union.h
    ) {
      return;
    }
    lastSynced.current = union;
    syncTauriWindow(union);
  }, [union]);

  const floaters = (
    <>
      <div className="demo-toolbar" aria-label="Prototype test controls">
        <button
          type="button"
          className="demo-simulate"
          onClick={simulateNotification}
          data-testid="simulate-notification"
          title="Test control (temporary)"
        >
          🔔 Simulate notification
        </button>
        <span
          className="demo-state-chip"
          data-testid="mochi-state"
          aria-live="polite"
        >
          Mochi: {petState}
        </span>
      </div>

      {hidden && (
        <button
          type="button"
          className="mochi-restore"
          onClick={() => {
            setHidden(false);
            touch();
          }}
          aria-label="Show Mochi"
          title="Show Mochi"
          data-testid="mochi-restore"
        >
          🐾 Mochi
        </button>
      )}

      {!hidden && (
        <MochiPet
          position={position}
          petState={petState}
          reviewFraction={reviewFraction}
          submissionFraction={submissionFraction}
          reviewCaption={`${WEEKLY_PROGRESS.reviewsCompleted}/${goals.reviewGoal}`}
          submissionCaption={`${WEEKLY_PROGRESS.submissionsCompleted}/${goals.submissionGoal}`}
          onPositionChange={(p) => setPosition(clampToScreen(p.x, p.y))}
          onTap={handlePetTap}
          onActiveChange={setPetActive}
          onInteract={touch}
          onHide={() => setHidden(true)}
        />
      )}

      {!hidden && notification && (
        <NotificationBubble
          notification={notification}
          style={{ left: bubblePos.left, top: bubblePos.top }}
          onOpen={openFromBubble}
          onDismiss={() => setNotification(null)}
          onInteract={touch}
        />
      )}

      {!hidden && panelOpen && (
        <TaskPanel
          style={{
            left: panelPos.left,
            top: panelPos.top,
            width: PANEL_BOX[panelMode].w,
          }}
          tasks={tasks}
          goals={goals}
          progress={WEEKLY_PROGRESS}
          mode={panelMode}
          selectedTask={selectedTask}
          onModeChange={openPanel}
          onSelectTask={handleSelectTask}
          onSaveGoals={handleSaveGoals}
          onClose={() => {
            setPanelOpen(false);
            touch();
          }}
          onInteract={touch}
        />
      )}
    </>
  );

  return (
    <div className="demo-page">
      {TAURI_MODE ? (
        <div
          className="tauri-stage"
          style={{
            width: screen.w,
            height: screen.h,
            left: -union.x,
            top: -union.y,
          }}
        >
          {floaters}
        </div>
      ) : (
        floaters
      )}
    </div>
  );
}
