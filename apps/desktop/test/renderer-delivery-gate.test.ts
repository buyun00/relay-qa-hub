import assert from "node:assert/strict";
import test from "node:test";

import { RendererDeliveryGate } from "../src/renderer-delivery-gate.js";

test("renderer delivery waits for readiness and resets across reloads", () => {
  const gate = new RendererDeliveryGate<string>();
  const delivered: string[] = [];
  const deliver = (value: string) => {
    delivered.push(value);
    return true;
  };

  gate.enqueue("before-preload");
  assert.equal(gate.tryDeliver(deliver), false);
  assert.equal(gate.hasPending, true);

  gate.finishLoading();
  assert.equal(gate.tryDeliver(deliver), true);
  assert.deepEqual(delivered, ["before-preload"]);
  assert.equal(gate.hasPending, false);

  gate.enqueue("ready-click");
  assert.equal(gate.tryDeliver(deliver), true);
  assert.deepEqual(delivered, ["before-preload", "ready-click"]);

  gate.startLoading();
  gate.enqueue("during-reload");
  assert.equal(gate.tryDeliver(deliver), false);
  assert.equal(gate.hasPending, true);
  gate.finishLoading();
  assert.equal(gate.tryDeliver(deliver), true);
  assert.deepEqual(delivered, ["before-preload", "ready-click", "during-reload"]);
});

test("renderer delivery retains a route when the IPC send is unavailable", () => {
  const gate = new RendererDeliveryGate<string>();
  gate.finishLoading();
  gate.enqueue("retry-me");

  assert.equal(
    gate.tryDeliver(() => false),
    false,
  );
  assert.equal(gate.hasPending, true);
  assert.equal(
    gate.tryDeliver((value) => value === "retry-me"),
    true,
  );
  assert.equal(gate.hasPending, false);
});
