import type { Request, Response } from "express";
import { z } from "zod";
import { createNotifyEvent, type EditorKind, type NotifyEvent } from "../domain/notify-event";
import { isApprovalWaitingText } from "../utils/approval-match";

const hookPayloadSchema = z.object({
  title: z.string().optional(),
  message: z.string().optional(),
  text: z.string().optional(),
  event: z.string().optional(),
  status: z.string().optional(),
  requiresApproval: z.boolean().optional(),
  idempotencyKey: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export function parseHookEvent(
  editor: EditorKind,
  source: string,
  body: unknown,
): NotifyEvent | null {
  const parsed = hookPayloadSchema.safeParse(body);
  if (!parsed.success) {
    return null;
  }
  const payload = parsed.data;
  const title = payload.title?.trim() || `${editor} waiting`;
  const message = payload.message?.trim() || payload.text?.trim() || "";
  const status = payload.status?.trim() ?? "";
  const evt = payload.event?.trim() ?? "";
  const requiresApproval = payload.requiresApproval === true;
  const hit =
    requiresApproval ||
    isApprovalWaitingText(message) ||
    isApprovalWaitingText(status) ||
    isApprovalWaitingText(evt);

  if (!hit) {
    return null;
  }

  const bodyText = message || status || evt || "Agent is waiting for user approval.";
  const idempotencyKey = payload.idempotencyKey?.trim();
  const dedupeKey = idempotencyKey || `${source}:${title}:${bodyText}`;
  return createNotifyEvent({
    source,
    editor,
    level: "warn",
    title,
    body: bodyText,
    dedupeKey,
    ...(payload.meta ? { meta: payload.meta } : {}),
  });
}

export function validateHookSourceIp(req: Request, allowlist: string[]): boolean {
  if (allowlist.length === 0) {
    return true;
  }
  const raw =
    req.ip ||
    req.socket.remoteAddress ||
    (Array.isArray(req.headers["x-forwarded-for"])
      ? req.headers["x-forwarded-for"][0]
      : req.headers["x-forwarded-for"]) ||
    "";
  if (!raw) {
    return false;
  }
  const ip = String(raw).split(",")[0]?.trim() ?? "";
  return allowlist.includes(ip);
}

export function forbidden(res: Response): void {
  res.status(403).json({ ok: false, error: "forbidden source ip" });
}
