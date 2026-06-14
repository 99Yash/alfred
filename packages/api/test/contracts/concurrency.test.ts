import assert from "node:assert/strict";
import test from "node:test";
import { runTaskGroup, settleTaskGroup } from "@alfred/contracts";

test("runTaskGroup aborts sibling tasks on first rejection", async () => {
  const boom = new Error("boom");
  let siblingSawAbort = false;

  await assert.rejects(
    runTaskGroup([
      async () => {
        await delay(10);
        throw boom;
      },
      async ({ signal }) => {
        await new Promise<never>((_, reject) => {
          const timeout = setTimeout(() => reject(new Error("sibling was not aborted")), 200);
          signal.addEventListener(
            "abort",
            () => {
              siblingSawAbort = true;
              clearTimeout(timeout);
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
    ]),
    /boom/,
  );

  assert.equal(siblingSawAbort, true);
});

test("settleTaskGroup waits for cancelled siblings before returning", async () => {
  let siblingSettled = false;

  const results = await settleTaskGroup([
    async () => {
      await delay(10);
      throw new Error("first failure");
    },
    async ({ signal }) => {
      try {
        await new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      } finally {
        siblingSettled = true;
      }
    },
  ]);

  assert.equal(results[0]?.status, "rejected");
  assert.equal(results[1]?.status, "rejected");
  assert.equal(siblingSettled, true);
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
