import { runConcurrencyTest } from './concurrency.test.js';
import { runAbortTest } from './abort.test.js';
import { runChannelDeathTest } from './channel-death.test.js';
import { runMemoryTest } from './memory.test.js';

async function main() {
  // Run the Stage 3 regression set sequentially to avoid interference.
  await runConcurrencyTest();
  await runAbortTest();
  await runChannelDeathTest();

  // Memory test schedules a short timer (WeakRef advisory check).
  await runMemoryTest();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

