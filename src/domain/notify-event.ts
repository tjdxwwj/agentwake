export type EditorKind = "cursor" | "claude-code" | "qoder" | "unknown";

export type NotifyLevel = "info" | "warn" | "error" | "critical";

export type NotifyEvent = {
  source: string;
  editor: EditorKind;
  level: NotifyLevel;
  title: string;
  body: string;
  timestamp: number;
  dedupeKey: string;
  meta?: Record<string, unknown>;
};

export type NotifyEventInput = Omit<NotifyEvent, "timestamp"> & {
  timestamp?: number;
};

export function createNotifyEvent(input: NotifyEventInput): NotifyEvent {
  return {
    ...input,
    timestamp: input.timestamp ?? Date.now(),
  };
}
