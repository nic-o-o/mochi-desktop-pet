export type Priority = 'urgent' | 'high' | 'medium' | 'low';
export type TaskKind = 'review' | 'revision' | 'submission';
export type PetState =
  | 'chilling'
  | 'sleepy'
  | 'happy'
  | 'nervous'
  | 'focused';

export type PanelMode = 'overview' | 'goals' | 'all' | 'detail';

export interface Task {
  id: string;
  title: string;
  kind: TaskKind;
  priority: Priority;
  /** Minutes until the SLA deadline (smaller = more urgent). */
  dueInMinutes: number;
  author: string;
  detail: string;
}

export interface Goals {
  reviewGoal: number;
  submissionGoal: number;
}

export interface WeeklyProgress {
  reviewsCompleted: number;
  submissionsCompleted: number;
}

export interface PetNotification {
  id: number;
  text: string;
  taskId?: string;
}

export interface XY {
  x: number;
  y: number;
}
