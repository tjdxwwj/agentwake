import { runGateway } from "./run-gateway";
import { logger } from "./utils/logger";
void runGateway().catch((error) => {
  logger.error("startup failed", { error: String(error) });
  process.exit(1);
});
