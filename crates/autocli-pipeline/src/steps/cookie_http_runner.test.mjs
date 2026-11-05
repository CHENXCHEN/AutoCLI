import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runCookieHttp } from './cookie_http_runner.mjs';

const origin = 'https://fixture.test';
const session = 'fixture-session-secret';
const token = 'fixture-authentication-token';
function input(evaluate, params = {}) {
  return {
    params: { origin, auth_cookie_names: ['session'], allowed_requests: [{ method: 'GET', path: '^/api/items$' }], evaluate, ...params },
    args: { limit: 2 }, data: { previous: true }, daemon_port: 19925,
  };
}
function fakeTransport({ cookies, api } = {}) {
  const calls = [];
  return {
    calls,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url === 'http://127.0.0.1:19925/command') {
        const command = JSON.parse(options.body);
        assert.equal(command.action, 'cookies');
        assert.equal(command.domain, undefined);
        assert.equal(command.tabId, undefined);
        assert.equal(options.headers['X-AutoCLI'], '1');
        return Response.json({ ok: true, data: cookies ? cookies(command.url) : [
          { name: 'session', value: session, domain: 'fixture.test', path: '/', httpOnly: true, secure: true },
        ] });
      }
      return api ? api(url, options) : Response.json({ items: [1, 2] });
    },
  };
}

const requestScript = `(async () => {
  const response = await fetch('${origin}/api/items?limit=' + args.limit);
  return { body: await response.json(), status: response.status, previous: data.previous };
})()`;

test('runs Web API adapter code without a page and includes scoped HttpOnly cookies', async () => {
  const fake = fakeTransport();
  const result = await runCookieHttp(input(requestScript), { fetchImpl: fake.fetch });
  assert.deepEqual(result, { ok: true, data: { body: { items: [1, 2] }, status: 200, previous: true } });
  assert.equal(fake.calls.length, 2);
  assert.equal(JSON.parse(fake.calls[0].options.body).url, `${origin}/api/items?limit=2`);
  const options = fake.calls[1].options;
  assert.equal(options.headers.get('cookie'), `session=${session}`);
  assert.equal(options.headers.get('origin'), origin);
  assert.equal(options.redirect, 'manual');
  assert.ok(options.signal instanceof AbortSignal);
});

test('reads cookies fresh for each precise API URL', async () => {
  const fake = fakeTransport();
  const script = `(async () => { await fetch('${origin}/api/items?page=1'); await fetch('${origin}/api/items?page=2'); return true; })()`;
  assert.equal((await runCookieHttp(input(script), { fetchImpl: fake.fetch })).ok, true);
  assert.deepEqual(fake.calls.filter((item) => item.url.includes('/command')).map((item) => JSON.parse(item.options.body).url), [
    `${origin}/api/items?page=1`, `${origin}/api/items?page=2`,
  ]);
});

test('waits for an extension reconnect before sending a business POST once', async () => {
  let cookieReads = 0;
  const fake = fakeTransport();
  const result = await runCookieHttp(input(`fetch('${origin}/api/items', {method: 'POST', body: 'write'}).then(r => r.json())`, {
    allowed_requests: [{method: 'POST', path: '^/api/items$'}],
  }), { fetchImpl: async (url, options) => {
    if (url.endsWith('/command') && ++cookieReads === 1) return Response.json({error: 'Chrome extension not connected'}, {status: 503});
    return fake.fetch(url, options);
  } });
  assert.equal(result.ok, true);
  assert.equal(cookieReads, 2);
  assert.equal(fake.calls.filter(call => call.url.startsWith(origin)).length, 1);
});

test('retries a daemon connection failure without retrying a failed business POST', async () => {
  let cookieReads = 0;
  let submissions = 0;
  const fake = fakeTransport({api: () => { submissions++; throw new Error('target connection lost'); }});
  const result = await runCookieHttp(input(`fetch('${origin}/api/items', {method: 'POST', body: 'write'})`, {
    allowed_requests: [{method: 'POST', path: '^/api/items$'}],
  }), { fetchImpl: async (url, options) => {
    if (url.endsWith('/command') && ++cookieReads === 1) throw new TypeError('fetch failed');
    return fake.fetch(url, options);
  } });
  assert.equal(result.ok, false);
  assert.match(result.error, /not retried/);
  assert.equal(cookieReads, 2);
  assert.equal(submissions, 1);
});

test('permission rejections fail immediately without reflecting daemon payloads', async () => {
  for (const status of [403, 422]) {
    let calls = 0;
    const result = await runCookieHttp(input(requestScript), {fetchImpl: async () => {
      calls++;
      return Response.json({error: 'private daemon payload'}, {status});
    }});
    assert.equal(result.ok, false);
    assert.match(result.error, new RegExp('HTTP ' + status));
    assert.doesNotMatch(result.error, /private daemon payload/);
    assert.equal(calls, 1);
  }
});

test('extension reconnect wait is cancelled before any target request is submitted', async () => {
  let calls = 0;
  const script = `(async () => { try { await fetch('${origin}/api/items'); }
    catch (error) { return {submitted: error.cookieHttpRequestSent, message: error.message}; } })()`;
  const started = Date.now();
  const result = await runCookieHttp(input(script, {timeout_ms: 80, execution_timeout_ms: 2000}), {fetchImpl: async () => {
    calls++;
    return Response.json({error: 'Chrome extension not connected'}, {status: 503});
  }});
  assert.equal(result.ok, true);
  assert.equal(result.data.submitted, false);
  assert.match(result.data.message, /timed out waiting for Chrome extension/);
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 1500);
});

test('business HTTP 503 is returned once without cookie retry', async () => {
  const fake = fakeTransport({api: () => Response.json({error: 'busy'}, {status: 503})});
  const result = await runCookieHttp(input(`fetch('${origin}/api/items').then(r => r.status)`), {fetchImpl: fake.fetch});
  assert.deepEqual(result, {ok: true, data: 503});
  assert.equal(fake.calls.length, 2);
});

test('extension reconnect waiting does not consume the target HTTP timeout', async () => {
  let cookieReads = 0;
  const fake = fakeTransport({api: async (_url, options) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 350);
      options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal.reason); }, {once: true});
    });
    return Response.json({items: [1, 2]});
  }});
  const result = await runCookieHttp(input(requestScript, {timeout_ms: 500, execution_timeout_ms: 2000}), {
    fetchImpl: async (url, options) => {
      if (url.endsWith('/command') && ++cookieReads === 1) return Response.json({}, {status: 503});
      return fake.fetch(url, options);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(cookieReads, 2);
  assert.equal(fake.calls.filter(call => call.url.startsWith(origin)).length, 1);
});

test('blocks foreign origins, schemes, credentials, fragments and forbidden paths before reading cookies', async () => {
  for (const url of ['https://foreign.test/api/items', 'http://fixture.test/api/items', 'https://u:p@fixture.test/api/items',
    `${origin}/api/items#fragment`, `${origin}/api/items/extra`, `${origin}/other`]) {
    const fake = fakeTransport();
    const result = await runCookieHttp(input(`fetch(${JSON.stringify(url)})`), { fetchImpl: fake.fetch });
    assert.equal(result.ok, false, url);
    assert.equal(fake.calls.length, 0, url);
  }
});

test('blocks a method that is not explicitly allowed', async () => {
  const fake = fakeTransport();
  const result = await runCookieHttp(input(`fetch('${origin}/api/items', { method: 'POST', body: 'x' })`), { fetchImpl: fake.fetch });
  assert.equal(result.ok, false);
  assert.match(result.error, /allowlist/);
  assert.equal(fake.calls.length, 0);
});

test('never follows a redirect or sends cookies to the redirect destination', async () => {
  const fake = fakeTransport({ api: () => new Response('', { status: 302, headers: { location: 'https://foreign.test/steal' } }) });
  const script = `(async () => { const response = await fetch('${origin}/api/items'); return { status: response.status, ok: response.ok }; })()`;
  const result = await runCookieHttp(input(script), { fetchImpl: fake.fetch });
  assert.deepEqual(result, { ok: true, data: { status: 302, ok: false } });
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[1].options.redirect, 'manual');
});

test('derives a required token header from the explicitly scoped cookie URL', async () => {
  const cookieUrl = `${origin}/dolphinscheduler/ui/`;
  const fake = fakeTransport({ cookies: (url) => url === cookieUrl ? [{ name: 'PROD_AUTH_TOKEN', value: token }] : [{ name: 'session', value: session }] });
  const result = await runCookieHttp(input(requestScript, {
    cookie_url: cookieUrl, token_cookie: 'PROD_AUTH_TOKEN', token_header: 'token',
  }), { fetchImpl: fake.fetch });
  assert.equal(result.ok, true);
  assert.equal(fake.calls.length, 3);
  assert.equal(JSON.parse(fake.calls[1].options.body).url, cookieUrl);
  assert.equal(fake.calls[2].options.headers.get('token'), token);
  assert.equal(fake.calls[2].options.headers.get('referer'), cookieUrl);
});

test('missing cookies or required token fails before the target request', async () => {
  for (const cookies of [() => [], () => [{ name: 'session', value: session }]]) {
    const fake = fakeTransport({ cookies });
    const result = await runCookieHttp(input(requestScript, { token_cookie: 'PROD_AUTH_TOKEN', token_header: 'token' }), { fetchImpl: fake.fetch });
    assert.equal(result.ok, false);
    assert.equal(fake.calls.filter((item) => item.url.startsWith(origin)).length, 0);
  }
});

test('a UI-scoped token authenticates an API URL without matching cookies', async () => {
  const cookieUrl = `${origin}/dolphinscheduler/ui/`;
  const fake = fakeTransport({ cookies: (url) => url === cookieUrl ? [{ name: 'PROD_AUTH_TOKEN', value: token }] : [] });
  const result = await runCookieHttp(input(requestScript, {
    cookie_url: cookieUrl, token_cookie: 'PROD_AUTH_TOKEN', token_header: 'token',
  }), { fetchImpl: fake.fetch });
  assert.equal(result.ok, true);
  assert.equal(fake.calls.length, 3);
  assert.equal(fake.calls[2].options.headers.get('token'), token);
  assert.equal(fake.calls[2].options.headers.has('cookie'), false);
});

test('optional token preserves cookie-only authentication but rejects an empty login', async () => {
  for (const hasCookies of [true, false]) {
    const fake = fakeTransport({ cookies: () => hasCookies ? [{ name: 'session', value: session }] : [] });
    const result = await runCookieHttp(input(requestScript, {
      token_cookie: 'PROD_AUTH_TOKEN', token_header: 'token', token_required: false,
    }), { fetchImpl: fake.fetch });
    assert.equal(result.ok, hasCookies);
    const requests = fake.calls.filter((item) => item.url.startsWith(origin));
    assert.equal(requests.length, hasCookies ? 1 : 0);
    if (hasCookies) {
      assert.equal(requests[0].options.headers.has('token'), false);
      assert.equal(requests[0].options.headers.get('cookie'), `session=${session}`);
    }
  }
});

test('adapter cannot override transport authentication headers', async () => {
  for (const name of ['cookie', 'authorization', 'host', 'origin', 'referer']) {
    const fake = fakeTransport();
    const result = await runCookieHttp(input(`fetch('${origin}/api/items', { headers: { '${name}': 'override' } })`), { fetchImpl: fake.fetch });
    assert.equal(result.ok, false);
    assert.equal(fake.calls.length, 0);
  }
});

test('failed writes are sent once and native transport errors never expose their details', async () => {
  const fake = fakeTransport({ api: () => { throw new Error(`network ${session}`); } });
  const result = await runCookieHttp(input(`fetch('${origin}/api/items', { method: 'POST', body: 'payload' })`, {
    allowed_requests: [{ method: 'POST', path: '^/api/items$' }],
  }), { fetchImpl: fake.fetch });
  assert.equal(result.ok, false);
  assert.match(result.error, /not retried/);
  assert.doesNotMatch(result.error, /fixture-session-secret/);
  assert.equal(fake.calls.filter((item) => item.url.startsWith(origin)).length, 1);
});

test('known cookie values are redacted in results and adapter errors', async () => {
  const fake = fakeTransport({ api: () => Response.json({ echo: session, nested: [`prefix:${session}`] }) });
  const script = `(async () => { const response = await fetch('${origin}/api/items'); return response.json(); })()`;
  assert.deepEqual(await runCookieHttp(input(script), { fetchImpl: fake.fetch }), {
    ok: true, data: { echo: '[hidden]', nested: ['prefix:[hidden]'] },
  });
  const result = await runCookieHttp(input(`(async () => { const response = await fetch('${origin}/api/items'); throw new Error((await response.json()).echo); })()`), { fetchImpl: fake.fetch });
  assert.deepEqual(result, { ok: false, error: '[hidden]' });
});

test('response credentials are hidden and short preference cookies preserve business IDs', async () => {
  const fake = fakeTransport({
    cookies: () => [{ name: 'flag', value: '1' }, { name: 'timezone', value: 'Asia/Shanghai' }, { name: 'session', value: session }],
    api: () => Response.json({ id: '1', name: '1', timezone: 'Asia/Shanghai' }, { headers: { 'set-cookie': 'session=new-session-credential' } }),
  });
  const script = `(async () => { const response = await fetch('${origin}/api/items');
    return { body: await response.json(), cookie: response.headers.get('set-cookie') }; })()`;
  assert.deepEqual(await runCookieHttp(input(script), { fetchImpl: fake.fetch }), {
    ok: true, data: { body: { id: '1', name: '1', timezone: 'Asia/Shanghai' }, cookie: null },
  });
});

test('a timed-out POST reaches adapter UNKNOWN handling and is submitted only once', async () => {
  let submissions = 0;
  const fake = fakeTransport({ api: (_url, options) => {
    submissions++;
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  } });
  const script = `(async () => {
    try { await fetch('${origin}/api/items', { method: 'POST', body: 'write' }); }
    catch (error) { return [{ state: error.cookieHttpRequestSent === true ? 'UNKNOWN' : 'NOT_SUBMITTED' }]; }
  })()`;
  const result = await runCookieHttp(input(script, {
    allowed_requests: [{ method: 'POST', path: '^/api/items$' }],
    timeout_ms: 100, execution_timeout_ms: 2000,
  }), { fetchImpl: fake.fetch });
  assert.deepEqual(result, { ok: true, data: [{ state: 'UNKNOWN' }] });
  assert.equal(submissions, 1);
});

test('preflight cookie errors tell the adapter no target request was submitted', async () => {
  const fake = fakeTransport({ cookies: () => [] });
  const script = `(async () => { try { await fetch('${origin}/api/items'); }
    catch (error) { return { submitted: error.cookieHttpRequestSent }; } })()`;
  assert.deepEqual(await runCookieHttp(input(script), { fetchImpl: fake.fetch }), {
    ok: true, data: { submitted: false },
  });
  assert.equal(fake.calls.filter((item) => item.url.startsWith(origin)).length, 0);
});

test('provides WebCrypto and standard adapter globals without process or require', async () => {
  const script = `(async () => {
    const bytes = new TextEncoder().encode('fixture');
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return { bytes: digest.byteLength, cloned: structuredClone({value: true}).value,
      process: typeof process, require: typeof require, cookie: document.cookie,
      uuid: crypto.randomUUID().length, url: new URL('/api/items', '${origin}').pathname };
  })()`;
  assert.deepEqual(await runCookieHttp(input(script)), { ok: true, data: {
    bytes: 32, cloned: true, process: 'undefined', require: 'undefined', cookie: '', uuid: 36, url: '/api/items',
  } });
});

test('terminates synchronous and post-await infinite loops within the whole-step deadline', async () => {
  for (const script of ['(() => { for (;;) {} })()', '(async () => { await Promise.resolve(); for (;;) {} })()']) {
    const started = Date.now();
    const result = await runCookieHttp(input(script, { timeout_ms: 100, execution_timeout_ms: 200 }));
    assert.equal(result.ok, false);
    assert.match(result.error, /timed out/);
    assert.ok(Date.now() - started < 2000);
  }
});

test('request timeout aborts pending requests and does not retry', async () => {
  let calls = 0;
  let signal;
  const result = await runCookieHttp(input(requestScript, { timeout_ms: 100, execution_timeout_ms: 200 }), {
    fetchImpl: async (_url, options) => { calls++; signal = options.signal; return new Promise(() => {}); },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out/);
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
});

test('rejects invalid policies before any transport operation', async () => {
  const cases = [
    { origin: 'http://fixture.test' }, { origin: `${origin}/path` },
    { cookie_url: 'https://other.test/' }, { allowed_requests: [] },
    { allowed_requests: [{ method: 'GET', path: '/api/items' }] },
    { token_cookie: 'PROD_AUTH_TOKEN' }, { timeout_ms: 0 },
  ];
  for (const params of cases) {
    const fake = fakeTransport();
    assert.equal((await runCookieHttp(input('true', params), { fetchImpl: fake.fetch })).ok, false);
    assert.equal(fake.calls.length, 0);
  }
});

test('CLI consumes JSON on stdin and prints exactly one result envelope', () => {
  const path = fileURLToPath(new URL('./cookie_http_runner.mjs', import.meta.url));
  const child = spawnSync(process.execPath, [path], { input: JSON.stringify(input('({ answer: 42 })')), encoding: 'utf8' });
  assert.equal(child.status, 0);
  assert.equal(child.stderr, '');
  assert.deepEqual(JSON.parse(child.stdout), { ok: true, data: { answer: 42 } });
});


test('embedded node -e invocation uses the same stdin protocol', () => {
  const source = readFileSync(new URL('./cookie_http_runner.mjs', import.meta.url), 'utf8');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    input: JSON.stringify(input('({ embedded: true })')), encoding: 'utf8',
  });
  assert.equal(child.status, 0);
  assert.equal(child.stderr, '');
  assert.deepEqual(JSON.parse(child.stdout), { ok: true, data: { embedded: true } });
});

test('non-JSON adapter results fail with a bounded error', async () => {
  const result = await runCookieHttp(input('({ value: 1n })'));
  assert.deepEqual(result, { ok: false, error: 'cookie_http adapter result must be JSON serializable' });
});
