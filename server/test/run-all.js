const { runSignalingTestSuite } = require('./signaling.test');
const { runServeTestSuite } = require('./serve.test');

async function main() {
  console.log('--- STARTING SIGNALING TESTS ---');
  await runSignalingTestSuite();
  console.log('--- SIGNALING TESTS PASSED ---');

  console.log('--- STARTING APP SERVER TESTS ---');
  await runServeTestSuite();
  console.log('--- APP SERVER TESTS PASSED ---');
}

main().catch((err) => {
  // Tests are allowed to print errors; the signaling server itself stays silent.
  console.error(err);
  process.exitCode = 1;
});
