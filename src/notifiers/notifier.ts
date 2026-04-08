import type { NotifyEvent } from "../domain/notify-event";

export interface Notifier {
  readonly id: string;
  notify(event: NotifyEvent): Promise<void>;
}
