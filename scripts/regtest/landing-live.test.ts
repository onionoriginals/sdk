import { expect, test } from 'bun:test';

async function startWithAuthorization(nonProduction: string, production: string) {
  const child = Bun.spawn([process.execPath, 'scripts/regtest/landing-live.ts'], {
    env: {
      ...process.env,
      LIVE_TURNKEY_NON_PRODUCTION_ORG: nonProduction,
      LIVE_TURNKEY_PRODUCTION_ORG_APPROVED: production,
      TURNKEY_API_PUBLIC_KEY: '',
      TURNKEY_API_PRIVATE_KEY: '',
      TURNKEY_ORGANIZATION_ID: '',
    },
    stdout: 'pipe', stderr: 'pipe',
  });
  const error = await new Response(child.stderr).text();
  expect(await child.exited).not.toBe(0);
  return error;
}

test('live harness requires an explicit organization authorization', async () => {
  expect(await startWithAuthorization('', '')).toContain('Choose exactly one');
});

test('live harness accepts separately approved production organization before requiring credentials', async () => {
  expect(await startWithAuthorization('', '1')).toContain('TURNKEY_API_PUBLIC_KEY is required');
});

test('live harness accepts non-production organization before requiring credentials', async () => {
  expect(await startWithAuthorization('1', '')).toContain('TURNKEY_API_PUBLIC_KEY is required');
});

test('live harness refuses contradictory organization declarations', async () => {
  expect(await startWithAuthorization('1', '1')).toContain('Choose exactly one');
});
