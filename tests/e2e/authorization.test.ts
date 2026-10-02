import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp, createContext, loadConfig } from '@shelf/backend';

/**
 * End-to-end authorization.
 *
 * The claim being proven is rule 84: a guest is blocked by the server, not by
 * a hidden button. These call the real endpoints in-process — the same code
 * path a hand-crafted request from DevTools would hit — with no session
 * cookie, and assert every protected route refuses.
 *
 * Requires a database. Skips cleanly (rather than failing) when DATABASE_URL
 * is not set, so the suite is runnable without infrastructure and enforced
 * where it is present.
 */

const DATABASE_AVAILABLE = Boolean(process.env.DATABASE_URL);

let app: FastifyInstance | null = null;
let ctx: Awaited<ReturnType<typeof createContext>> | null = null;

before(async () => {
  if (!DATABASE_AVAILABLE) return;
  const config = loadConfig();
  ctx = createContext(config);
  app = await buildApp(ctx);
  await app.ready();
});

after(async () => {
  await app?.close();
  await ctx?.shutdown();
});

function skipWithoutDb(t: { skip: (reason?: string) => void }): boolean {
  if (!DATABASE_AVAILABLE) {
    t.skip('DATABASE_URL not set');
    return true;
  }
  return false;
}

const GUEST_BLOCKED_ROUTES: ReadonlyArray<{ method: 'GET' | 'POST' | 'DELETE' | 'PATCH'; url: string }> = [
  { method: 'GET', url: '/api/v1/me/profile' },
  { method: 'GET', url: '/api/v1/me/favorites' },
  { method: 'POST', url: '/api/v1/me/favorites' },
  { method: 'GET', url: '/api/v1/me/saved-searches' },
  { method: 'GET', url: '/api/v1/me/alerts' },
  { method: 'POST', url: '/api/v1/me/alerts' },
  { method: 'GET', url: '/api/v1/me/carts' },
  { method: 'GET', url: '/api/v1/me/history' },
  { method: 'GET', url: '/api/v1/me/export' },
  { method: 'POST', url: '/api/v1/me/delete' },
  { method: 'GET', url: '/api/v1/deals/radars' },
  { method: 'POST', url: '/api/v1/deals/radars' },
];

const ADMIN_BLOCKED_ROUTES: ReadonlyArray<string> = [
  '/api/v1/admin/compliance',
  '/api/v1/admin/source-health',
  '/api/v1/admin/analytics',
  '/api/v1/admin/audit',
];

test('a guest is refused by every user route, server-side', async (t) => {
  if (skipWithoutDb(t) || !app) return;

  for (const route of GUEST_BLOCKED_ROUTES) {
    const response = await app.inject({
      method: route.method,
      url: route.url,
      // No cookie. This is the DevTools-forged-request case.
      payload: route.method === 'POST' ? {} : undefined,
    });

    assert.equal(
      response.statusCode,
      401,
      `${route.method} ${route.url} returned ${response.statusCode}, expected 401`,
    );
    const body = response.json();
    assert.equal(body.error.code, 'ERROR_AUTH_REQUIRED', `${route.url} wrong error code`);
  }
});

test('a guest is refused by every admin route', async (t) => {
  if (skipWithoutDb(t) || !app) return;

  for (const url of ADMIN_BLOCKED_ROUTES) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 401, `${url} returned ${response.statusCode}`);
  }
});

test('the auth/me endpoint describes a guest as a guest rather than failing', async (t) => {
  if (skipWithoutDb(t) || !app) return;

  const response = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.authenticated, false);
  assert.equal(body.role, 'guest');
});

test('public search is open to a guest', async (t) => {
  if (skipWithoutDb(t) || !app) return;

  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/search?q=headphones&source=all&country=US&currency=USD',
  });
  // 200 with results, or a typed source error — never 401.
  assert.notEqual(response.statusCode, 401);
});

test('an error response never leaks a stack trace or internal detail', async (t) => {
  if (skipWithoutDb(t) || !app) return;

  const response = await app.inject({ method: 'GET', url: '/api/v1/me/profile' });
  const raw = response.body;
  assert.ok(!raw.includes('at '), 'response contains a stack frame');
  assert.ok(!/node_modules/.test(raw), 'response references node_modules');
  assert.ok(!/Error:/.test(raw), 'response contains a raw error message');

  const body = response.json();
  // The shape is exactly: code, messageKey, details, retryable, requestId.
  assert.deepEqual(
    Object.keys(body.error).sort(),
    ['code', 'details', 'messageKey', 'requestId', 'retryable'],
  );
});

test('a bad search query is rejected with a typed validation error', async (t) => {
  if (skipWithoutDb(t) || !app) return;

  const response = await app.inject({ method: 'GET', url: '/api/v1/search?q=' });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'ERROR_QUERY_TOO_SHORT');
});
