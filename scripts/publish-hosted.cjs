const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { verify } = require('./smoke-hosted.cjs');

function aws(...args) {
  return JSON.parse(execFileSync('aws', [...args, '--output', 'json'], { encoding: 'utf8' }));
}
async function main() {
  const instanceId = process.env.OFFICE_INSTANCE_ID;
  const document = process.env.OFFICE_DEPLOY_DOCUMENT;
  const commit = process.env.GITHUB_SHA;
  assert.match(instanceId || '', /^i-[a-f0-9]+$/);
  assert.match(commit || '', /^[a-f0-9]{40}$/);
  assert.equal(aws('sts', 'get-caller-identity').Account, '397303793146');
  const result = aws('ssm', 'send-command', '--document-name', document,
    '--instance-ids', instanceId, '--parameters', JSON.stringify({ Commit: [commit] }), '--timeout-seconds', '1200');
  const commandId = result.Command.CommandId;
  let finished = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    await delay(10000);
    const invocation = aws('ssm', 'get-command-invocation', '--command-id', commandId, '--instance-id', instanceId);
    if (invocation.Status === 'Success') { finished = true; break; }
    if (['Failed', 'TimedOut', 'Cancelled', 'Cancelling'].includes(invocation.Status)) {
      throw new Error(`Deployment ${invocation.Status}. Inspect the command in the SSM console.`);
    }
  }
  assert.ok(finished, 'Deployment timed out');
  await verify(process.env.OFFICE_SITE_URL, 70000);
  console.log('Published and verified:', process.env.OFFICE_SITE_URL);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
