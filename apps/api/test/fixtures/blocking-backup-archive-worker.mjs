import { parentPort, workerData } from "node:worker_threads";

if (parentPort === null) throw new Error("fixture requires a parent port");

Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
parentPort.postMessage({
  ok: true,
  result: {
    fixture: true,
    archiveRoot: workerData.archiveRoot,
  },
});
parentPort.close();
