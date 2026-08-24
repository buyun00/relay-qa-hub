import { runWorkerProcess } from "./index.js";

void runWorkerProcess().catch((error: unknown) => {
  const errorName = error instanceof Error ? error.name : "UnknownError";
  console.error(
    JSON.stringify({
      level: "error",
      event: "worker.crashed",
      service: "relay-qa-hub-worker",
      errorName,
    }),
  );
  process.exitCode = 1;
});
