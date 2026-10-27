import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import {
  DRAG_THRESHOLD_PX,
  clampPetPosition,
  placeFloating,
  resolvePetState,
  ringFraction,
  sortTasks,
  unionBounds,
} from './mochi/logic.ts';
import type { PlacedRect, WeeklyGoals, XY } from './mochi/logic.ts';
import { NOTIFICATION_TEMPLATES, PET_POS_STORAGE_KEY, loadGoals, saveGoals } from './mochi/mockData.ts';
import { useTasks } from './mochi/useTasks.ts';
import { MochiPet } from './mochi/MochiPet.tsx';
import {
  getDisplayBounds,
  isDesktopShell,
  isShellMode,
  onDisplayChanged,
  onSimulateNotification,
  openCodimango,
  syncBounds,
} from './mochi/shell.ts';
import { OverviewPanel } from './mochi/OverviewPanel.tsx';
import { ExpandedView } from './mochi/ExpandedView.tsx';
import './App.css';

export const PET_BOX = 144;
const PANEL_SIZE = { w: 352, h: 470 };
const BUBBLE_SIZE = { w: 264, h: 132 };
const BUBBLE_AUTO_DISMISS_MS = 7000;
/* desktop shell union rects (outer sizes + shadow margin, generous on purpose) */
const UNION_PAD = 16;
const PET_UNION_H = 212;
const PANEL_UNION = { w: 384, h: 700 };
const BUBBLE_UNION = { w: 312, h: 180 };
const EXPANDED_UNION = { w: 624, h: 692 };
const PAW_UNION = { w: 96, h: 96 };

interface Bubble {
  id: number;
  title: string;
  body: string;
}

function defaultPetPos(): XY {
  return {
    x: Math.max(8, window.innerWidth - PET_BOX - 24),
    y: Math.max(8, window.innerHeight - PET_BOX - 120),
  };
}

function loadPetPos(): XY {
  try {
    const raw = localStorage.getItem(PET_POS_STORAGE_KEY);
    if (!raw) return defaultPetPos();
    const parsed = JSON.parse(raw) as Partial<XY>;
    if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return defaultPetPos();
    return clampPetPosition(
      { x: parsed.x, y: parsed.y },
      { w: window.innerWidth, h: window.innerHeight },
      PET_BOX,
    );
  } catch {
    return defaultPetPos();
  }
}

export default function App() {
  const [goals, setGoals] = useState<WeeklyGoals>(loadGoals);
  const [petPos, setPetPos] = useState<XY>(loadPetPos);
  const [hidden, setHidden] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [expandedOpen, setExpandedOpen] = useState(false);
  const [editingIn, setEditingIn] = useState<'panel' | 'expanded' | null>(null);
  const [bubble, setBubble] = useState<Bubble | null>(null);
  const [hovering, setHovering] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lastActive, setLastActive] = useState(() => Date.now());
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  /* desktop shell: display origin (for global window coords) + readiness gate */
  const [displayOrigin, setDisplayOrigin] = useState({ x: 0, y: 0 });
  const [displayReady, setDisplayReady] = useState(() => !isShellMode());

  const dragRef = useRef<{
    lastX: number;
    lastY: number;
    accX: number;
    accY: number;
    origX: number;
    origY: number;
    moved: boolean;
  } | null>(null);
  const notifIndex = useRef(0);
  // TEMP-DEBUG: dedupe for sync logging; remove with the log below.
  const lastSyncKey = useRef('');

  const touch = useCallback(() => setLastActive(Date.now()), []);

  /* desktop shell: pet-only backdrop, short window title, boot proof in terminal */
  useEffect(() => {
    if (!isShellMode()) return;
    document.documentElement.classList.add('mochi-shell');
    document.title = 'Mochi';
    console.log('[mochi] shell renderer ready');
  }, []);

  /* one-second ticker drives idle detection + SLA countdowns */
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    /* desktop shell resizes its own window: display changes arrive via the bridge instead */
    if (isDesktopShell()) return;
    const onResize = () => {
      const next = { w: window.innerWidth, h: window.innerHeight };
      setViewport(next);
      /* keep the pet inside the visible area after resizes */
      setPetPos((p) => clampPetPosition(p, next, PET_BOX));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /* desktop shell: learn the real display bounds (the window starts tiny) */
  useEffect(() => {
    if (!isDesktopShell()) return;
    let alive = true;
    const refresh = () => {
      getDisplayBounds().then((b) => {
        if (!alive || !b) return;
        setViewport({ w: b.width, h: b.height });
        setDisplayOrigin({ x: b.x, y: b.y });
        setPetPos((p) => clampPetPosition(p, { w: b.width, h: b.height }, PET_BOX));
        setDisplayReady(true);
      });
    };
    refresh();
    return onDisplayChanged(refresh);
  }, []);

  /* persist position across refreshes */
  useEffect(() => {
    try {
      localStorage.setItem(PET_POS_STORAGE_KEY, JSON.stringify(petPos));
    } catch {
      /* ignore — position still applies for the session */
    }
  }, [petPos]);

  /* notification bubbles dismiss themselves after a few seconds */
  useEffect(() => {
    if (!bubble) return;
    const id = bubble.id;
    const timer = window.setTimeout(() => {
      setBubble((b) => (b && b.id === id ? null : b));
    }, BUBBLE_AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [bubble]);

  const idleSeconds = Math.max(0, Math.floor((nowMs - lastActive) / 1000));
  const panelLikeOpen = panelOpen || expandedOpen;
  const petState = resolvePetState({
    panelOpen: panelLikeOpen,
    bubbleVisible: bubble !== null,
    hoveringOrDragging: hovering || dragging,
    idleSeconds,
  });

  const shell = isShellMode();
  /* belt-and-braces clamp so the first shell frame (pre-display-bounds) stays sane */
  const petRenderPos = clampPetPosition(petPos, viewport, PET_BOX);
  const pawPos = { x: viewport.w - 80, y: viewport.h - 80 };

  /* Codimango rows in the desktop shell (refresh on panel open), mock data in a browser. */
  const { tasks, weekly } = useTasks(panelOpen || expandedOpen, nowMs);
  const sortedTasks = useMemo(() => sortTasks(tasks), [tasks]);
  const pending = useMemo(() => sortedTasks.filter((t) => t.status === 'pending_review'), [sortedTasks]);
  const revisions = useMemo(() => sortedTasks.filter((t) => t.status === 'revision_required'), [sortedTasks]);

  const petRect = useMemo(
    () => ({ x: petRenderPos.x, y: petRenderPos.y, w: PET_BOX, h: PET_BOX }),
    [petRenderPos],
  );
  const panelPos = useMemo(() => placeFloating(petRect, PANEL_SIZE, viewport), [petRect, viewport]);
  const bubblePos = useMemo(
    () => placeFloating(petRect, BUBBLE_SIZE, viewport, 16),
    [petRect, viewport],
  );
  const expandedPos = useMemo(
    () => placeFloating(petRect, { w: 592, h: 660 }, viewport),
    [petRect, viewport],
  );

  /* desktop shell: union of visible UI in screen-local coords. The container
     is shifted by -union so screen coords render at the right window offset
     (without this, positions apply twice: once in state, once via the window
     origin — a runaway that flings the pet out of its own window). */
  const visibleRects: PlacedRect[] = [];
  if (!hidden) {
    visibleRects.push({ x: petRenderPos.x, y: petRenderPos.y, w: PET_BOX, h: PET_UNION_H });
  } else {
    visibleRects.push({ x: pawPos.x - UNION_PAD, y: pawPos.y - UNION_PAD, w: PAW_UNION.w, h: PAW_UNION.h });
  }
  if (panelOpen && !hidden) {
    visibleRects.push({ x: panelPos.x, y: panelPos.y, w: PANEL_UNION.w, h: PANEL_UNION.h });
  }
  if (bubble && !hidden) {
    visibleRects.push({ x: bubblePos.x, y: bubblePos.y, w: BUBBLE_UNION.w, h: BUBBLE_UNION.h });
  }
  if (expandedOpen) {
    visibleRects.push({ x: expandedPos.x, y: expandedPos.y, w: EXPANDED_UNION.w, h: EXPANDED_UNION.h });
  }
  const unionLocal = shell && displayReady ? unionBounds(visibleRects, viewport, UNION_PAD) : null;
  const unionSafe = unionLocal ?? { x: 0, y: 0, width: 1, height: 1 };

  const reviewFrac = ringFraction(weekly.reviewsCompleted, goals.reviewGoal);
  const subFrac = ringFraction(weekly.submissionsCompleted, goals.submissionGoal);

  const togglePanel = useCallback(() => {
    touch();
    setEditingIn(null);
    setPanelOpen((v) => !v);
  }, [touch]);

  function handlePetPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest('[data-nodrag]')) return;
    touch();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture unavailable — drag tracking and click still work without it */
    }
    dragRef.current = {
      lastX: e.clientX,
      lastY: e.clientY,
      accX: 0,
      accY: 0,
      origX: petPos.x,
      origY: petPos.y,
      moved: false,
    };
  }

  function handlePetPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d) return;
    const mdx = e.movementX ?? 0;
    const mdy = e.movementY ?? 0;
    const cdx = e.clientX - d.lastX;
    const cdy = e.clientY - d.lastY;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    /* Prefer screen-space deltas: clientX shifts when the shell window moves
       under the cursor mid-drag, which would double-count motion. */
    const useMovement = mdx !== 0 || mdy !== 0 || (cdx === 0 && cdy === 0);
    const dx = useMovement ? mdx : cdx;
    const dy = useMovement ? mdy : cdy;
    d.accX += dx;
    d.accY += dy;
    if (!d.moved && Math.hypot(d.accX, d.accY) <= DRAG_THRESHOLD_PX) return;
    if (!d.moved) {
      d.moved = true;
      setDragging(true);
    }
    touch();
    setPetPos(clampPetPosition({ x: d.origX + d.accX, y: d.origY + d.accY }, viewport, PET_BOX));
  }

  function handlePetPointerUp() {
    const d = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    if (d && !d.moved) togglePanel();
  }

  function handlePetKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      togglePanel();
    }
  }

  function handleGlobalKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Escape') return;
    if (editingIn) setEditingIn(null);
    else if (selectedId) setSelectedId(null);
    else if (expandedOpen) setExpandedOpen(false);
    else if (panelOpen) setPanelOpen(false);
  }

  function hidePet() {
    setHidden(true);
    setPanelOpen(false);
    setBubble(null);
    setHovering(false);
  }

  function restorePet() {
    touch();
    setHidden(false);
  }

  const simulateNotification = useCallback(() => {
    touch();
    const tpl = NOTIFICATION_TEMPLATES[notifIndex.current % NOTIFICATION_TEMPLATES.length];
    notifIndex.current += 1;
    setBubble({ id: Date.now(), title: tpl.title, body: tpl.body });
  }, [touch]);

  /* desktop shell: the global shortcut asks us to simulate (no on-screen button there) */
  useEffect(() => {
    if (!isDesktopShell()) return;
    return onSimulateNotification(() => simulateNotification());
  }, [simulateNotification]);

  /* desktop shell: shrink-wrap the window around visible UI (screen coords) */
  useEffect(() => {
    if (!shell || !displayReady || !unionLocal) return;
    /* the main process diffs identical syncs, so the 1s ticker resend is free */
    // TEMP-DEBUG: log only on change (proves the effect fires during drag).
    const key = `${unionLocal.x},${unionLocal.y},${unionLocal.width}x${unionLocal.height}`;
    if (key !== lastSyncKey.current) {
      lastSyncKey.current = key;
      console.log('[mochi] sync', key);
    }
    syncBounds({
      x: displayOrigin.x + unionLocal.x,
      y: displayOrigin.y + unionLocal.y,
      width: unionLocal.width,
      height: unionLocal.height,
    });
  });

  function openBubble() {
    touch();
    setBubble(null);
    setExpandedOpen(false);
    setSelectedId(null);
    setEditingIn(null);
    setPanelOpen(true);
  }

  function handleSaveGoals(next: WeeklyGoals) {
    touch();
    setGoals(next);
    saveGoals(next);
    setEditingIn(null);
  }

  function openTaskDetail(id: string) {
    touch();
    /* Codimango rows open their review/submission page; mock rows keep the local detail view. */
    const url = sortedTasks.find((t) => t.id === id)?.url;
    if (url) {
      openCodimango(url);
      return;
    }
    setPanelOpen(false);
    setSelectedId(id);
    setExpandedOpen(true);
  }

  function backToOverview() {
    touch();
    setExpandedOpen(false);
    setSelectedId(null);
    setEditingIn(null);
    setPanelOpen(true);
  }

  const petLabel =
    `Mochi is ${petState}. Reviews ${weekly.reviewsCompleted} of ${goals.reviewGoal} goal, ` +
    `submissions ${weekly.submissionsCompleted} of ${goals.submissionGoal} goal. ` +
    `Press Enter to ${panelOpen ? 'close' : 'open'} the task panel.`;

  /* desktop shell: wait for real display bounds before painting anything */
  if (shell && !displayReady) {
    return <div className="desktop" />;
  }

  return (
    <div
      className="desktop"
      onKeyDown={handleGlobalKeyDown}
      style={
        shell
          ? {
              position: 'relative',
              width: viewport.w,
              height: viewport.h,
              minHeight: 0,
              left: -unionSafe.x,
              top: -unionSafe.y,
            }
          : undefined
      }
    >
      {/* Backdrop page content — Mochi floats above this. */}
      <div className="page">
        <header className="page-header">
          <div>
            <p className="eyebrow">Team status · Thursday</p>
            <h1>Launch readiness overview</h1>
            <p className="muted">Mock page content for the prototype backdrop. Mochi floats above this page.</p>
          </div>
          <div className="stat-cards">
            <div className="stat-card"><span className="stat-num">12</span><span className="muted">Shipped</span></div>
            <div className="stat-card"><span className="stat-num">7</span><span className="muted">In review</span></div>
            <div className="stat-card"><span className="stat-num">3</span><span className="muted">Blocked</span></div>
          </div>
        </header>
        <main className="page-grid">
          <section className="page-card">
            <h2>Today's priorities</h2>
            <ul>
              <li>Sign off the checkout flow refactor before the SLA lapses.</li>
              <li>Decide on the payments SLA refund-window phrasing.</li>
              <li>Give the avatar upload QA logs a quick pass — 15 minutes left.</li>
            </ul>
          </section>
          <section className="page-card">
            <h2>Notes</h2>
            <p>
              This is placeholder content so the pet has a page to float over. Drag Mochi anywhere —
              a click (without dragging) opens the task panel. Use “Simulate notification” below to
              preview an incoming review request.
            </p>
          </section>
          <section className="page-card">
            <h2>Weekly goals</h2>
            <p>
              Goals live with Mochi: open the task panel, hover a stat card and use the
              ^/v steppers (or “Edit weekly goals” in the full task view), and the rings
              around the pet update immediately. Goals and the pet's position persist across refreshes.
            </p>
          </section>
        </main>
        <footer className="page-footer muted">
          Mochi prototype backdrop · placeholder SVG/CSS pet (no design assets provided)
        </footer>
      </div>

      {/* Testing control — no need to wait for real events. */}
      <button type="button" className="sim-btn" onClick={simulateNotification}>
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path
            d="M8 1.5a4.5 4.5 0 0 0-4.5 4.5c0 3-1.2 4.2-1.9 4.9-.3.3 0 .6.4.6h11.9c.5 0 .8-.3.5-.6-.7-.7-1.9-1.9-1.9-4.9A4.5 4.5 0 0 0 8 1.5ZM6.6 13.5a1.5 1.5 0 0 0 2.8 0H6.6Z"
            fill="currentColor"
          />
        </svg>
        Simulate notification
      </button>

      {bubble && !hidden && (
        <button
          type="button"
          className="notif-bubble"
          style={{ left: bubblePos.x, top: bubblePos.y }}
          onClick={openBubble}
          aria-live="polite"
          aria-label={`${bubble.title}: ${bubble.body}. Activate to open the task panel.`}
        >
          <strong className="bubble-title">{bubble.title}</strong>
          <span className="bubble-body">{bubble.body}</span>
        </button>
      )}

      {!hidden ? (
        <div className="pet-widget" style={{ left: petRenderPos.x, top: petRenderPos.y }}>
          <div
            className={`pet-pressable pet-${petState}${dragging ? ' is-dragging' : ''}`}
            role="button"
            tabIndex={0}
            aria-label={petLabel}
            onPointerDown={handlePetPointerDown}
            onPointerMove={handlePetPointerMove}
            onPointerUp={handlePetPointerUp}
            onPointerCancel={() => {
              dragRef.current = null;
              setDragging(false);
            }}
            onPointerEnter={() => {
              touch();
              setHovering(true);
            }}
            onPointerLeave={() => setHovering(false)}
            onKeyDown={handlePetKeyDown}
          >
            <MochiPet state={petState} reviewFrac={reviewFrac} subFrac={subFrac} />
          </div>
          <button
            type="button"
            data-nodrag
            className="hide-btn"
            onClick={hidePet}
            aria-label="Hide Mochi"
            title="Hide Mochi"
          >
            −
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="restore-btn"
          onClick={restorePet}
          style={shell ? { left: pawPos.x, top: pawPos.y } : undefined}
          aria-label="Show Mochi"
          title="Show Mochi"
        >
          <span className="paw" aria-hidden="true">
            <i /><i /><i /><b />
          </span>
        </button>
      )}

      {panelOpen && !hidden && (
        <div onPointerDownCapture={touch} onKeyDownCapture={touch} onWheelCapture={touch}>
        <OverviewPanel
          position={panelPos}
          pending={pending}
          revisions={revisions}
          reviewsCompleted={weekly.reviewsCompleted}
          submissionsCompleted={weekly.submissionsCompleted}
          goals={goals}
          nowMs={nowMs}
          onSaveGoals={handleSaveGoals}
          onClose={() => {
            setPanelOpen(false);
            setEditingIn(null);
          }}
          onOpenTask={openTaskDetail}
        />
        </div>
      )}

      {expandedOpen && (
        <div onPointerDownCapture={touch} onKeyDownCapture={touch} onWheelCapture={touch}>
        <ExpandedView
          anchor={shell ? expandedPos : undefined}
          tasks={sortedTasks}
          nowMs={nowMs}
          search={search}
          onSearchChange={(q) => {
            touch();
            setSearch(q);
          }}
          selectedId={selectedId}
          onSelect={(id) => {
            touch();
            const url = id ? sortedTasks.find((t) => t.id === id)?.url : undefined;
            if (url) {
              openCodimango(url);
              return;
            }
            setSelectedId(id);
          }}
          editing={editingIn === 'expanded'}
          goals={goals}
          onSaveGoals={handleSaveGoals}
          onCancelEdit={() => setEditingIn(null)}
          onEditGoals={() => {
            touch();
            setEditingIn('expanded');
          }}
          onClose={() => {
            setExpandedOpen(false);
            setSelectedId(null);
            setEditingIn(null);
          }}
          onBackToOverview={backToOverview}
        />
        </div>
      )}
    </div>
  );
}

