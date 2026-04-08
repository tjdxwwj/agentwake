import type { Express } from "express";
import type { AppConfig } from "../config";
import type { NotifyEvent } from "../domain/notify-event";

export type AdapterContext = {
  app: Express;
  config: AppConfig;
  emit: (event: NotifyEvent) => Promise<void>;
};

export type AdapterStop = () => Promise<void> | void;

export interface GatewayAdapter {
  readonly id: string;
  start(context: AdapterContext): Promise<AdapterStop | void> | AdapterStop | void;
}
