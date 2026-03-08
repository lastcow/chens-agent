import "dotenv/config";
import { startServer } from "./api/server.js";
import { startWorker } from "./queue/worker.js";

async function main() {
  console.log("🐄 ChensAgent starting...");
  // Run API server and queue worker concurrently
  await Promise.all([
    startServer(),
    startWorker(),
  ]);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
