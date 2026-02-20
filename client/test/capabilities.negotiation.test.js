import {
  buildLocalCapabilities,
  sanitizeCapabilities,
  evaluateCapabilityCompatibility,
} from '../capabilities.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function runCapabilitiesNegotiationTest() {
  console.log('--- STARTING CAPABILITIES NEGOTIATION TEST ---');

  const local = buildLocalCapabilities();
  const peer = sanitizeCapabilities({
    v: 1,
    protocolVersion: 1,
    minSupported: 1,
    features: ['capabilities-v1', 'ready-v1'],
    requiredFeatures: ['capabilities-v1'],
  });

  assert(!!peer, 'Expected peer capabilities to sanitize');

  const ok = evaluateCapabilityCompatibility(local, peer);
  assert(ok.ok === true, `Expected compatible result, got ${JSON.stringify(ok)}`);
  assert(ok.negotiatedVersion === 1, 'Expected negotiated version 1');

  const versionMismatch = evaluateCapabilityCompatibility(
    buildLocalCapabilities({ protocolVersion: 3, minSupported: 3 }),
    sanitizeCapabilities({
      v: 1,
      protocolVersion: 1,
      minSupported: 1,
      features: ['capabilities-v1'],
      requiredFeatures: ['capabilities-v1'],
    })
  );
  assert(versionMismatch.ok === false, 'Expected version mismatch');
  assert(versionMismatch.code === 'version_mismatch', `Unexpected code: ${versionMismatch.code}`);

  const peerMissingRequired = evaluateCapabilityCompatibility(
    buildLocalCapabilities({
      requiredFeatures: ['capabilities-v1', 'receipt-v1'],
      features: ['capabilities-v1', 'receipt-v1'],
    }),
    sanitizeCapabilities({
      v: 1,
      protocolVersion: 1,
      minSupported: 1,
      features: ['capabilities-v1'],
      requiredFeatures: ['capabilities-v1'],
    })
  );
  assert(peerMissingRequired.ok === false, 'Expected peer missing required feature mismatch');
  assert(peerMissingRequired.code === 'peer_missing_required', `Unexpected code: ${peerMissingRequired.code}`);

  const localMissingRequired = evaluateCapabilityCompatibility(
    buildLocalCapabilities({
      features: ['capabilities-v1'],
      requiredFeatures: ['capabilities-v1'],
    }),
    sanitizeCapabilities({
      v: 1,
      protocolVersion: 1,
      minSupported: 1,
      features: ['capabilities-v1', 'ready-v1'],
      requiredFeatures: ['capabilities-v1', 'ready-v1'],
    })
  );
  assert(localMissingRequired.ok === false, 'Expected local missing required feature mismatch');
  assert(localMissingRequired.code === 'local_missing_required', `Unexpected code: ${localMissingRequired.code}`);

  const invalid = sanitizeCapabilities({
    v: 1,
    protocolVersion: 1,
    minSupported: 2,
    features: [],
    requiredFeatures: [],
  });
  assert(invalid === null, 'Expected invalid capabilities payload to sanitize to null');

  const pending = evaluateCapabilityCompatibility(local, null);
  assert(pending.ok === false, 'Expected pending result for null peer');
  assert(pending.code === 'pending', `Unexpected pending code: ${pending.code}`);

  console.log('--- CAPABILITIES NEGOTIATION TEST PASSED ---');
}

if (typeof window !== 'undefined') {
  runCapabilitiesNegotiationTest().catch(console.error);
}

