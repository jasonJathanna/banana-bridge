import assert from "node:assert/strict";
import test from "node:test";
import { SerialQueue, sleep } from "../src/queue.js";

test("jobs run one at a time, in order", async () => {
  const queue = new SerialQueue(0);
  const events: string[] = [];

  const job = (name: string, ms: number) =>
    queue.run(async () => {
      events.push(`start:${name}`);
      await sleep(ms);
      events.push(`end:${name}`);
      return name;
    });

  const results = await Promise.all([job("a", 30), job("b", 5), job("c", 1)]);

  assert.deepEqual(results, ["a", "b", "c"]);
  assert.deepEqual(events, ["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
});

test("a rejected job does not break the chain", async () => {
  const queue = new SerialQueue(0);
  const order: string[] = [];

  const failing = queue.run(async () => {
    order.push("boom");
    throw new Error("boom");
  });
  const following = queue.run(async () => {
    order.push("after");
    return "ok";
  });

  await assert.rejects(failing, /boom/);
  assert.equal(await following, "ok");
  assert.deepEqual(order, ["boom", "after"]);
});

test("depth reflects queued and running jobs", async () => {
  const queue = new SerialQueue(0);
  assert.equal(queue.depth, 0);

  const first = queue.run(() => sleep(20));
  const second = queue.run(() => sleep(1));
  assert.equal(queue.depth, 2);

  await Promise.all([first, second]);
  assert.equal(queue.depth, 0);
});

test("pacing delays the next job without delaying the result", async () => {
  const queue = new SerialQueue(60);
  const started = Date.now();
  await queue.run(async () => "first");
  const afterFirst = Date.now() - started;
  await queue.run(async () => "second");
  const afterSecond = Date.now() - started;

  assert.ok(afterFirst < 50, `first result should not wait for pacing (took ${afterFirst}ms)`);
  assert.ok(afterSecond >= 55, `second job should start after pacing (took ${afterSecond}ms)`);
});
