import { randomUUID } from 'node:crypto';
import { Worker, isMainThread } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 55_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

class CookieHttpError extends Error {}

function scopedUrl(value, origin) {
  let url;
  try { url = new URL(value, origin); } catch { throw new CookieHttpError('cookie_http URL is invalid'); }
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password || url.hash) {
    throw new CookieHttpError('cookie_http requires a credential-free HTTPS URL on the configured origin');
  }
  return url;
}

function policyFor(input) {
  const params = input?.params;
  if (!params || typeof params !== 'object' || typeof params.evaluate !== 'string') {
    throw new CookieHttpError('cookie_http requires an evaluate string');
  }
  let originUrl;
  try { originUrl = new URL(params.origin); } catch { throw new CookieHttpError('cookie_http origin is invalid'); }
  if (originUrl.protocol !== 'https:' || originUrl.origin !== params.origin || originUrl.username || originUrl.password) {
    throw new CookieHttpError('cookie_http origin must be an HTTPS origin without a path or credentials');
  }
  if (!Array.isArray(params.allowed_requests) || params.allowed_requests.length === 0) {
    throw new CookieHttpError('cookie_http requires a non-empty request allowlist');
  }
  const rules = params.allowed_requests.map((rule) => {
    if (!rule || typeof rule.method !== 'string' || !/^[A-Z]+$/.test(rule.method) ||
        typeof rule.path !== 'string' || !rule.path.startsWith('^/') || !rule.path.endsWith('$')) {
      throw new CookieHttpError('cookie_http allowlist requires uppercase methods and anchored path expressions');
    }
    try { return { method: rule.method, path: new RegExp(rule.path) }; }
    catch { throw new CookieHttpError('cookie_http allowlist path expression is invalid'); }
  });
  const timeout = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) {
    throw new CookieHttpError('cookie_http timeout_ms must be an integer from 1 to 600000');
  }
  const executionTimeout = params.execution_timeout_ms ?? DEFAULT_EXECUTION_TIMEOUT_MS;
  if (!Number.isInteger(executionTimeout) || executionTimeout < 1 || executionTimeout > MAX_TIMEOUT_MS) {
    throw new CookieHttpError('cookie_http execution_timeout_ms must be an integer from 1 to 600000');
  }
  if (params.auth_cookie_names !== undefined && (!Array.isArray(params.auth_cookie_names) ||
      params.auth_cookie_names.some((name) => typeof name !== 'string' || !name))) {
    throw new CookieHttpError('cookie_http auth_cookie_names must be an array of cookie names');
  }
  if ((params.token_cookie === undefined) !== (params.token_header === undefined) ||
      (params.token_cookie !== undefined && (typeof params.token_cookie !== 'string' || !params.token_cookie ||
       typeof params.token_header !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(params.token_header)))) {
    throw new CookieHttpError('cookie_http token_cookie and token_header must be provided together');
  }
  if (params.token_required !== undefined && typeof params.token_required !== 'boolean') {
    throw new CookieHttpError('cookie_http token_required must be a boolean');
  }
  const port = input.daemon_port ?? 19925;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CookieHttpError('cookie_http daemon port is invalid');
  return {
    params, origin: originUrl.origin, rules, timeout, executionTimeout, port,
    authCookieNames: new Set([...(params.auth_cookie_names ?? []), params.token_cookie].filter(Boolean)),
    cookieUrl: scopedUrl(params.cookie_url ?? `${originUrl.origin}/`, originUrl.origin).href,
  };
}

function redactor(secrets) {
  return function redact(value) {
    if (typeof value === 'string') {
      let result = value;
      for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
        if (result === secret) result = '[hidden]';
        else if (secret.length >= 8) result = result.split(secret).join('[hidden]');
      }
      return result;
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redact(item)]));
    }
    return value;
  };
}

async function boundedText(response, signal) {
  if (signal.aborted) throw new CookieHttpError('cookie_http command timed out');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new CookieHttpError('cookie_http response exceeds the size limit');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new CookieHttpError('cookie_http response exceeds the size limit');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

function transportFor(policy, fetchImpl, executionSignal, secrets, onWriteSubmitted) {
  async function cookiesFor(url, signal) {
    signal.throwIfAborted();
    let response;
    try {
      response = await fetchImpl(`http://127.0.0.1:${policy.port}/command`, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'content-type': 'application/json', 'X-AutoCLI': '1' },
        body: JSON.stringify({ id: randomUUID(), action: 'cookies', url }),
      });
    } catch {
      throw new CookieHttpError(signal.aborted ? 'cookie_http command timed out' : 'cookie_http could not reach the AutoCLI daemon');
    }
    if (!response.ok) throw new CookieHttpError('cookie_http could not read Chrome cookies; check the daemon and extension connection');
    let envelope;
    try { envelope = JSON.parse(await boundedText(response, signal)); }
    catch { throw new CookieHttpError('cookie_http received an invalid cookie response from the daemon'); }
    if (envelope?.ok !== true || !Array.isArray(envelope.data)) {
      throw new CookieHttpError('cookie_http could not read Chrome cookies; check extension permissions');
    }
    const cookies = envelope.data;
    if (cookies.some((cookie) => !cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string' ||
        /[\r\n;=]/.test(cookie.name) || /[\r\n;]/.test(cookie.value))) {
      throw new CookieHttpError('cookie_http received an invalid cookie value');
    }
    // Only configured authentication values participate in output redaction.
    // Preference cookies can equal ordinary business data, regardless of length.
    for (const cookie of cookies) if (cookie.value && policy.authCookieNames.has(cookie.name)) secrets.add(cookie.value);
    return cookies;
  }

  return async function request(input, options = {}) {
    executionSignal.throwIfAborted();
    const signal = AbortSignal.any([executionSignal, AbortSignal.timeout(policy.timeout)]);
    const url = scopedUrl(input, policy.origin);
    if (!options || typeof options !== 'object') throw new CookieHttpError('cookie_http request options are invalid');
    const method = String(options.method ?? 'GET').toUpperCase();
    if (!policy.rules.some((rule) => rule.method === method && rule.path.test(url.pathname))) {
      throw new CookieHttpError('cookie_http request method or path is outside the adapter allowlist');
    }
    const headers = new Headers(options.headers);
    for (const name of ['cookie', 'authorization', 'proxy-authorization', 'host', 'origin', 'referer', policy.params.token_header]) {
      if (name && headers.has(name)) throw new CookieHttpError('cookie_http authentication headers must be supplied by the transport');
    }
    const cookies = await cookiesFor(url.href, signal);
    if (cookies.length > 0) {
      const cookieHeader = cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
      secrets.add(cookieHeader);
      headers.set('cookie', cookieHeader);
    } else if (!policy.params.token_cookie) {
      throw new CookieHttpError('cookie_http found no matching Chrome cookies; log in to the target site');
    }
    if (policy.params.token_cookie) {
      const tokenCookies = policy.cookieUrl === url.href ? cookies : await cookiesFor(policy.cookieUrl, signal);
      const token = tokenCookies.find((cookie) => cookie.name === policy.params.token_cookie)?.value;
      if (!token && (policy.params.token_required !== false || cookies.length === 0)) {
        throw new CookieHttpError('cookie_http required login token is missing; log in to the target site');
      }
      if (token) headers.set(policy.params.token_header, token);
    }
    headers.set('origin', policy.origin);
    headers.set('referer', policy.cookieUrl);
    let response;
    try {
      signal.throwIfAborted();
      if (method !== 'GET' && method !== 'HEAD') onWriteSubmitted();
      response = await fetchImpl(url.href, {
        method, headers, body: options.body, redirect: 'manual', signal,
      });
      const body = await boundedText(response, signal);
      return {
        status: response.status, statusText: response.statusText ?? '', ok: response.ok,
        url: response.url || url.href, redirected: false,
        headers: [...response.headers.entries()].filter(([name]) => name.toLowerCase() !== 'set-cookie'), body,
      };
    } catch (error) {
      const failure = error instanceof CookieHttpError ? error : new CookieHttpError(signal.aborted ? 'cookie_http HTTP request timed out; request was not retried' : 'cookie_http HTTP request failed; request was not retried');
      failure.requestSent = true;
      throw failure;
    }
  };
}

// Installed adapters are trusted code. vm narrows the provided API surface; it
// is not a security boundary for running untrusted JavaScript. A worker lets the
// parent terminate synchronous loops even after an await.
const ADAPTER_WORKER = `
const { parentPort, workerData } = await import('node:worker_threads');
const { webcrypto } = await import('node:crypto');
const vm = await import('node:vm');
let nextId = 0;
const pending = new Map();
parentPort.on('message', (message) => {
  const operation = pending.get(message.id);
  if (!operation) return;
  pending.delete(message.id);
  if (message.error) {
    const error = new Error(message.error);
    error.cookieHttpRequestSent = message.requestSent;
    operation.reject(error);
  }
  else {
    const result = message.response;
    const headers = new Headers(result.headers);
    operation.resolve(Object.freeze({
      ok: result.ok, status: result.status, statusText: result.statusText,
      url: result.url, redirected: result.redirected, headers,
      text: async () => result.body,
      json: async () => JSON.parse(result.body),
    }));
  }
});
const scopedFetch = (input, options = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  try { parentPort.postMessage({ type: 'fetch', id, input: String(input), options: {
    method: options.method, headers: [...new Headers(options.headers).entries()], body: options.body,
  } }); }
  catch { pending.delete(id); reject(new Error('cookie_http request options could not be transferred')); }
});
const noop = () => {};
const context = vm.createContext({
  args: workerData.args, data: workerData.data,
  fetch: scopedFetch, URL, URLSearchParams, Headers, TextEncoder, TextDecoder,
  Uint8Array, ArrayBuffer, crypto: webcrypto, structuredClone,
  setTimeout, clearTimeout,
  document: Object.freeze({ cookie: '' }),
  console: Object.freeze({ log: noop, info: noop, warn: noop, error: noop, debug: noop }),
}, { codeGeneration: { strings: false, wasm: false } });
try {
  let script;
  try { script = new vm.Script('(' + workerData.evaluate + '\\n)', { filename: 'adapter' }); }
  catch { throw new Error('cookie_http adapter JavaScript is invalid'); }
  const data = await script.runInContext(context, { timeout: workerData.timeout });
  parentPort.postMessage({ type: 'result', data: data ?? null });
} catch (error) {
  parentPort.postMessage({ type: 'error', error: error?.name === 'DataCloneError' ? 'cookie_http adapter result must be JSON serializable' : typeof error?.message === 'string' ? error.message : 'cookie_http adapter evaluation failed' });
}
`;

export async function runCookieHttp(input, { fetchImpl = globalThis.fetch } = {}) {
  const secrets = new Set();
  const redact = redactor(secrets);
  let worker;
  let timer;
  const controller = new AbortController();
  try {
    if (Number(process.versions.node.split('.')[0]) < 22) throw new CookieHttpError('cookie_http requires Node.js 22 or newer');
    const policy = policyFor(input);
    let writeSubmitted = false;
    const request = transportFor(policy, fetchImpl, controller.signal, secrets, () => { writeSubmitted = true; });
    let settled = false;
    const result = await new Promise((resolve, reject) => {
      worker = new Worker(ADAPTER_WORKER, {
        eval: true,
        workerData: { evaluate: policy.params.evaluate, args: input.args ?? {}, data: input.data ?? null, timeout: policy.executionTimeout },
      });
      timer = setTimeout(() => {
        controller.abort();
        reject(new CookieHttpError(writeSubmitted
          ? 'cookie_http execution timed out; submission outcome UNKNOWN; inspect target state before retrying'
          : 'cookie_http execution timed out; requests were not retried'));
      }, policy.executionTimeout);
      worker.on('message', async (message) => {
        if (settled) return;
        if (message.type === 'result') resolve(message.data);
        else if (message.type === 'error') reject(new Error(message.error));
        else if (message.type === 'fetch') {
          try {
            const response = await request(message.input, message.options);
            if (!settled) worker.postMessage({ id: message.id, response });
          } catch (error) {
            if (!settled) worker.postMessage({ id: message.id, error: error instanceof CookieHttpError ? error.message : 'cookie_http request failed', requestSent: error.requestSent === true });
          }
        }
      });
      worker.once('error', () => reject(new CookieHttpError('cookie_http adapter worker failed')));
      worker.once('exit', (code) => { if (code !== 0) reject(new CookieHttpError('cookie_http adapter worker exited unexpectedly')); });
    }).finally(() => { settled = true; });
    let normalized;
    try { normalized = JSON.parse(JSON.stringify(result)); }
    catch { throw new CookieHttpError('cookie_http adapter result must be JSON serializable'); }
    return { ok: true, data: redact(normalized) };
  } catch (error) {
    return { ok: false, error: redact(error?.message || 'cookie_http evaluation failed') };
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (worker) await worker.terminate();
  }
}

async function main() {
  let input;
  try {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    input = JSON.parse(text);
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, error: 'cookie_http input must be JSON' }));
    return;
  }
  process.stdout.write(JSON.stringify(await runCookieHttp(input)));
}

if (isMainThread && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
// The Rust step embeds this module using node --input-type=module -e.
else if (isMainThread && process.argv[1] === undefined && import.meta.url.endsWith('/[eval1]')) await main();
