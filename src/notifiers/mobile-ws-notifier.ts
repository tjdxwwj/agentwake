import type { Server as HttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";
import { WebSocketServer, type WebSocket } from "ws";
import type { NotifyEvent } from "../domain/notify-event";
import { logger } from "../utils/logger";
import type { Notifier } from "./notifier";

export class MobileWsNotifier implements Notifier {
  readonly id = "mobile-ws-notifier";
  private readonly sockets = new Set<WebSocket>();
  private wsServer: WebSocketServer | null = null;

  attach(server: HttpServer | HttpsServer, path: string): void {
    this.wsServer = new WebSocketServer({ server, path });
    logger.info("mobile ws notifier attached", { path });
    this.wsServer.on("connection", (socket, req) => {
      this.sockets.add(socket);
      socket.send(JSON.stringify({ type: "hello", payload: { ok: true } }));
      logger.info("mobile ws client connected", {
        clients: this.sockets.size,
        ip: req.socket.remoteAddress,
      });
      socket.on("close", () => {
        this.sockets.delete(socket);
        logger.info("mobile ws client disconnected", { clients: this.sockets.size });
      });
      socket.on("error", (error) => {
        this.sockets.delete(socket);
        logger.warn("mobile ws client error", {
          clients: this.sockets.size,
          error: String(error),
        });
      });
    });
  }

  async notify(event: NotifyEvent): Promise<void> {
    const message = JSON.stringify({ type: "notify-event", payload: event });
    const closed: WebSocket[] = [];
    for (const socket of this.sockets) {
      if (socket.readyState !== socket.OPEN) {
        closed.push(socket);
        continue;
      }
      socket.send(message);
    }
    for (const socket of closed) {
      this.sockets.delete(socket);
    }
    logger.info("mobile ws event broadcast", {
      dedupeKey: event.dedupeKey,
      eventSource: event.source,
      onlineClients: this.sockets.size,
      droppedClients: closed.length,
    });
  }

  async close(): Promise<void> {
    if (!this.wsServer) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.wsServer?.close((err) => (err ? reject(err) : resolve()));
    });
    this.wsServer = null;
    this.sockets.clear();
  }
}
