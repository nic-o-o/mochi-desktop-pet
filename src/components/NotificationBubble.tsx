import type { CSSProperties, KeyboardEvent } from 'react';
import type { PetNotification } from '../types';

interface NotificationBubbleProps {
  notification: PetNotification;
  style: CSSProperties;
  onOpen: () => void;
  onDismiss: () => void;
  onInteract: () => void;
}

export default function NotificationBubble({
  notification,
  style,
  onOpen,
  onDismiss,
  onInteract,
}: NotificationBubbleProps) {
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onDismiss();
    }
  };

  return (
    <div
      className="mochi-bubble"
      style={style}
      role="button"
      tabIndex={0}
      aria-label={`New notification: ${notification.text}. Activate to view tasks.`}
      onClick={() => {
        onInteract();
        onOpen();
      }}
      onKeyDown={handleKeyDown}
      onPointerEnter={onInteract}
      data-testid="mochi-bubble"
    >
      <span className="mochi-bubble-bell" aria-hidden="true">
        🔔
      </span>
      <span className="mochi-bubble-text">{notification.text}</span>
      <span className="mochi-bubble-go" aria-hidden="true">
        View →
      </span>
      <button
        type="button"
        className="mochi-bubble-x"
        aria-label="Dismiss notification"
        onClick={(e) => {
          e.stopPropagation();
          onInteract();
          onDismiss();
        }}
      >
        ×
      </button>
    </div>
  );
}
