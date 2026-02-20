import { runConcurrencyTest } from './concurrency.test.js';
import { runAbortTest } from './abort.test.js';
import { runChannelDeathTest } from './channel-death.test.js';
import { runMemoryTest } from './memory.test.js';
import { runReceiverBackpressureOverflowTest } from './receiver-backpressure-overflow.test.js';
import { runFairnessTest } from './fairness.equal-weights.test.js';
import { runWeightedPriorityFairnessTest } from './fairness.weighted-priority.test.js';
import { runPassphraseEncryptionTest } from './encryption.passphrase.test.js';
import { runMetadataTest } from './metadata.test.js';
import { runSchedulerLivenessTest } from './scheduler.liveness.test.js';
import { runTransportBackpressureTest } from './transport.backpressure.test.js';
import { runHandshakeDomainTest } from './handshake-domain.test.js';
import { runCapabilitiesNegotiationTest } from './capabilities.negotiation.test.js';

async function main() {
  await runConcurrencyTest();
  await runAbortTest();
  await runChannelDeathTest();
  await runMemoryTest();
  await runReceiverBackpressureOverflowTest();

  await runFairnessTest();
  await runWeightedPriorityFairnessTest();

  await runPassphraseEncryptionTest();
  await runCapabilitiesNegotiationTest();
  await runMetadataTest();
  await runHandshakeDomainTest();
  await runSchedulerLivenessTest();
  await runTransportBackpressureTest();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
