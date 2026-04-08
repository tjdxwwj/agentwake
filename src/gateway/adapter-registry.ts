import type { AdapterContext, AdapterStop, GatewayAdapter } from "./adapter";

export class AdapterRegistry {
  private readonly adapters: GatewayAdapter[] = [];
  private readonly stops: AdapterStop[] = [];

  register(adapter: GatewayAdapter): void {
    this.adapters.push(adapter);
  }

  async startAll(context: AdapterContext): Promise<void> {
    for (const adapter of this.adapters) {
      const stop = await adapter.start(context);
      if (stop) {
        this.stops.push(stop);
      }
    }
  }

  async stopAll(): Promise<void> {
    const tasks = this.stops.splice(0).reverse().map(async (stop) => {
      await stop();
    });
    await Promise.all(tasks);
  }
}
