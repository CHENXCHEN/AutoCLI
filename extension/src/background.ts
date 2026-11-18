// Based on OpenCLI (https://github.com/jackwener/opencli) by jackwener
// Licensed under Apache-2.0. Modified for AutoCLI.
/**
 * AutoCLI — Service Worker (background script).
 *
 * Connects to the autocli daemon via WebSocket, receives commands,
 * dispatches them to Chrome APIs (debugger/tabs/cookies), returns results.
 */

import type { BrowserCarrier, Command, Result } from './protocol';
import { DAEMON_WS_URL, DAEMON_PING_URL, WS_RECONNECT_BASE_DELAY, WS_RECONNECT_MAX_DELAY } from './protocol';
import * as executor from './cdp';

type SelectorWindow = Window & typeof globalThis & { __autocliSelectorActive?: boolean };

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;

// ─── Console log forwarding ──────────────────────────────────────────
// Hook console.log/warn/error to forward logs to daemon via WebSocket.

const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);

function forwardLog(level: 'info' | 'warn' | 'error', args: unknown[]): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    ws.send(JSON.stringify({ type: 'log', level, msg, ts: Date.now() }));
  } catch { /* don't recurse */ }
}

console.log = (...args: unknown[]) => { _origLog(...args); forwardLog('info', args); };
console.warn = (...args: unknown[]) => { _origWarn(...args); forwardLog('warn', args); };
console.error = (...args: unknown[]) => { _origError(...args); forwardLog('error', args); };

// ─── WebSocket connection ────────────────────────────────────────────

/**
 * Probe the daemon via its /ping HTTP endpoint before attempting a WebSocket
 * connection.  fetch() failures are silently catchable; new WebSocket() is not
 * — Chrome logs ERR_CONNECTION_REFUSED to the extension error page before any
 * JS handler can intercept it.  By keeping the probe inside connect() every
 * call site remains unchanged and the guard can never be accidentally skipped.
 */
async function connect(): Promise<void> {
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;

  try {
    const res = await fetch(DAEMON_PING_URL, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return; // unexpected response — not our daemon
  } catch {
    return; // daemon not running — skip WebSocket to avoid console noise
  }

  try {
    ws = new WebSocket(DAEMON_WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[autocli] Connected to daemon');
    reconnectAttempts = 0; // Reset on successful connection
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    // Send version so the daemon can report mismatches to the CLI
    ws?.send(JSON.stringify({ type: 'hello', version: chrome.runtime.getManifest().version }));
  };

  ws.onmessage = async (event) => {
    try {
      const raw = event.data as string;
      const parsed = JSON.parse(raw);

      // Handle AI stream chunks from daemon
      if (parsed.type === 'ai-stream-chunk' || parsed.type === 'ai-stream-done' || parsed.type === 'ai-stream-error') {
        const port = aiStreamPorts.get(parsed.streamId);
        if (port) {
          if (parsed.type === 'ai-stream-chunk') {
            port.postMessage({ type: 'chunk', data: parsed.data });
          } else if (parsed.type === 'ai-stream-done') {
            port.postMessage({ type: 'done' });
            aiStreamPorts.delete(parsed.streamId);
            try { port.disconnect(); } catch {}
          } else if (parsed.type === 'ai-stream-error') {
            port.postMessage({ type: 'error', status: parsed.status || 0, body: parsed.body || parsed.error || '' });
            aiStreamPorts.delete(parsed.streamId);
            try { port.disconnect(); } catch {}
          }
        }
        return;
      }

      // Normal command from daemon
      const command = parsed as Command;
      const result = await handleCommand(command);
      ws?.send(JSON.stringify(result));
    } catch (err) {
      console.error('[autocli] Message handling error:', err);
    }
  };

  ws.onclose = () => {
    console.log('[autocli] Disconnected from daemon');
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = () => {
    ws?.close();
  };
}

/**
 * After MAX_EAGER_ATTEMPTS (reaching 60s backoff), stop scheduling reconnects.
 * The keepalive alarm (~24s) will still call connect() periodically, but at a
 * much lower frequency — reducing console noise when the daemon is not running.
 */
const MAX_EAGER_ATTEMPTS = 6; // 2s, 4s, 8s, 16s, 32s, 60s — then stop

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectAttempts++;
  if (reconnectAttempts > MAX_EAGER_ATTEMPTS) return; // let keepalive alarm handle it
  const delay = Math.min(WS_RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts - 1), WS_RECONNECT_MAX_DELAY);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

// ─── Automation window isolation ─────────────────────────────────────
// All autocli operations happen in a dedicated Chrome window so the
// user's active browsing session is never touched.
// The window auto-closes after 120s of idle (no commands).

type AutomationSession = {
  windowId: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  idleDeadlineAt: number;
};

type TabGroupSession = {
  groupId: number;
  windowId: number;
  title: string;
  ownedTabIds: Set<number>;
  // A group is global, but each logical caller needs a stable default tab in
  // that shared group. This map never grants ownership by itself: every value
  // must also be present in ownedTabIds before it can be used.
  workspaceTabIds: Map<string, number>;
  // Every AutoCLI-created tab has one logical owner. The physical Chrome tab
  // group is shared by title, but ownership is never inferred from membership.
  tabWorkspaceOwners: Map<number, string>;
  // Activity is tracked per owned tab. Chrome's Tab.lastAccessed only changes
  // when a tab becomes active, which strict background tabs intentionally do
  // not do, so this records successful AutoCLI operations instead.
  tabActivities: Map<number, TabGroupTabActivity>;
  leaseId: string;
  idleTimer: ReturnType<typeof setTimeout> | null;
  // This is the scheduler's earliest per-tab expiry, not a group-wide last
  // activity time. It is retained for storage compatibility with prior builds.
  idleDeadlineAt: number;
};

type TabGroupTabActivity = {
  lastOperationAt: number;
  expiresAt: number;
};

type StoredTabGroupSession = {
  groupId: number;
  windowId: number;
  title: string;
  ownedTabIds: number[];
  workspaceTabIds?: Array<[string, number]>;
  tabWorkspaceOwners?: Array<[number, string]>;
  tabActivities?: Array<[number, TabGroupTabActivity]>;
  leaseId?: string;
  idleDeadlineAt: number;
};

const automationSessions = new Map<string, AutomationSession>();
const tabGroupSessions = new Map<string, TabGroupSession>();
const tabGroupSessionLocks = new Map<string, Promise<TabGroupSession>>();
const tabGroupSessionMutations = new Map<string, Promise<void>>();
const tabGroupSessionStorageWrites = new Map<string, Promise<void>>();
const tabGroupCleanupLeases = new Map<string, Promise<void>>();
const tabGroupActivityGenerations = new Map<string, number>();
const tabGroupActiveCommandCounts = new Map<string, number>();
const WINDOW_IDLE_TIMEOUT = 30000; // 30s — quick cleanup after command finishes
const TAB_GROUP_SESSION_STORAGE_PREFIX = 'autocli.tabGroupSession.';
const TAB_GROUP_CLEANUP_ALARM_PREFIX = 'autocli-tab-group-cleanup:';
const TAB_GROUP_ORPHAN_TAB_CLOSE_ALARM_PREFIX = 'autocli-tab-group-orphan-tab:';
const TAB_GROUP_CLEANUP_RETRY_DELAY = 30_000;
const TAB_GROUP_RESTORE_RETRY_ALARM = 'autocli-tab-group-restore';
const TAB_GROUP_STORAGE_RETRY_ATTEMPTS = 3;

function getWorkspaceKey(workspace?: string): string {
  return workspace?.trim() || 'default';
}

function getCarrier(cmd: Command): BrowserCarrier {
  const carrier = cmd.carrier ?? 'automation-window';
  if (carrier !== 'automation-window' && carrier !== 'tab-group-background') {
    throw new Error(`Unknown browser carrier: ${carrier}`);
  }
  return carrier;
}

function isTabGroupCarrier(cmd: Command): boolean {
  return getCarrier(cmd) === 'tab-group-background';
}

function getGroupTitle(cmd: Command): string {
  const name = cmd.groupName?.trim();
  if (!name) throw new Error('strict-background group name is required');
  if (name.includes('\n') || name.includes('\r')) throw new Error('strict-background group name cannot contain newlines');
  return `AutoCLI-${name}`;
}

function getTabGroupSessionKey(title: string): string {
  // Tab Groups are global to the Chrome profile, so their session identity must
  // match the user-visible title rather than the daemon's legacy workspace.
  return title;
}

function getTabGroupSessionStorageKey(key: string): string {
  return `${TAB_GROUP_SESSION_STORAGE_PREFIX}${encodeURIComponent(key)}`;
}

function getTabGroupCleanupAlarmName(key: string): string {
  return `${TAB_GROUP_CLEANUP_ALARM_PREFIX}${encodeURIComponent(key)}`;
}

function getTabGroupOrphanTabCloseAlarmName(key: string, leaseId: string, groupId: number, tabId: number): string {
  return `${TAB_GROUP_ORPHAN_TAB_CLOSE_ALARM_PREFIX}${encodeURIComponent(key)}:${leaseId}:${groupId}:${tabId}`;
}

function getTabGroupSessionKeyFromAlarmName(name: string): string | null {
  if (!name.startsWith(TAB_GROUP_CLEANUP_ALARM_PREFIX)) return null;
  try {
    return decodeURIComponent(name.slice(TAB_GROUP_CLEANUP_ALARM_PREFIX.length));
  } catch {
    return null;
  }
}

function getTabGroupOrphanTabCloseAlarm(name: string): { key: string; leaseId: string; groupId: number; tabId: number } | null {
  if (!name.startsWith(TAB_GROUP_ORPHAN_TAB_CLOSE_ALARM_PREFIX)) return null;
  const encoded = name.slice(TAB_GROUP_ORPHAN_TAB_CLOSE_ALARM_PREFIX.length);
  const tabSeparator = encoded.lastIndexOf(':');
  const groupSeparator = encoded.lastIndexOf(':', tabSeparator - 1);
  const leaseSeparator = encoded.lastIndexOf(':', groupSeparator - 1);
  if (leaseSeparator < 1 || groupSeparator <= leaseSeparator + 1 || tabSeparator <= groupSeparator + 1) return null;
  const leaseId = encoded.slice(leaseSeparator + 1, groupSeparator);
  const groupId = Number(encoded.slice(groupSeparator + 1, tabSeparator));
  const tabId = Number(encoded.slice(tabSeparator + 1));
  if (!leaseId || !Number.isInteger(groupId) || groupId < 0 || !Number.isInteger(tabId) || tabId < 0) return null;
  try {
    return { key: decodeURIComponent(encoded.slice(0, leaseSeparator)), leaseId, groupId, tabId };
  } catch {
    return null;
  }
}

function beginTabGroupActivity(key: string): void {
  tabGroupActivityGenerations.set(key, (tabGroupActivityGenerations.get(key) ?? 0) + 1);
}

function beginTabGroupCommand(key: string): void {
  beginTabGroupActivity(key);
  tabGroupActiveCommandCounts.set(key, (tabGroupActiveCommandCounts.get(key) ?? 0) + 1);
}

function endTabGroupCommand(key: string): void {
  const count = tabGroupActiveCommandCounts.get(key) ?? 0;
  if (count <= 1) {
    tabGroupActiveCommandCounts.delete(key);
  } else {
    tabGroupActiveCommandCounts.set(key, count - 1);
  }
}

function isTabGroupCommandActive(key: string): boolean {
  return (tabGroupActiveCommandCounts.get(key) ?? 0) > 0;
}

function isTabGroupActivityCurrent(key: string, generation: number): boolean {
  return (tabGroupActivityGenerations.get(key) ?? 0) === generation;
}

function createTabGroupSessionLeaseId(): string {
  return crypto.randomUUID();
}

function hasValidWorkspaceTabBindings(value: unknown): value is Array<[string, number]> {
  if (!Array.isArray(value)) return false;
  const workspaces = new Set<string>();
  return value.every((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2) return false;
    const [workspace, tabId] = entry;
    if (typeof workspace !== 'string' || !workspace || !Number.isInteger(tabId) || tabId < 0) return false;
    if (workspaces.has(workspace)) return false;
    workspaces.add(workspace);
    return true;
  });
}

function hasValidTabWorkspaceOwners(value: unknown): value is Array<[number, string]> {
  if (!Array.isArray(value)) return false;
  const tabIds = new Set<number>();
  return value.every((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2) return false;
    const [tabId, workspace] = entry;
    if (!Number.isInteger(tabId) || tabId < 0 || typeof workspace !== 'string' || !workspace) return false;
    if (tabIds.has(tabId)) return false;
    tabIds.add(tabId);
    return true;
  });
}

function hasValidTabActivities(value: unknown): value is Array<[number, TabGroupTabActivity]> {
  if (!Array.isArray(value)) return false;
  const tabIds = new Set<number>();
  return value.every((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2) return false;
    const [tabId, activity] = entry;
    if (!Number.isInteger(tabId) || tabId < 0 || !activity || typeof activity !== 'object') return false;
    const { lastOperationAt, expiresAt } = activity as Partial<TabGroupTabActivity>;
    if (
      typeof lastOperationAt !== 'number'
      || typeof expiresAt !== 'number'
      || !Number.isFinite(lastOperationAt)
      || !Number.isFinite(expiresAt)
      || expiresAt < lastOperationAt
    ) return false;
    if (tabIds.has(tabId)) return false;
    tabIds.add(tabId);
    return true;
  });
}

function serializeTabGroupSession(session: TabGroupSession): StoredTabGroupSession {
  return {
    groupId: session.groupId,
    windowId: session.windowId,
    title: session.title,
    ownedTabIds: [...session.ownedTabIds],
    workspaceTabIds: [...session.workspaceTabIds.entries()],
    tabWorkspaceOwners: [...session.tabWorkspaceOwners.entries()],
    tabActivities: [...session.tabActivities.entries()].map(([tabId, activity]) => [tabId, { ...activity }]),
    leaseId: session.leaseId,
    idleDeadlineAt: session.idleDeadlineAt,
  };
}

function isStoredTabGroupSession(value: unknown): value is StoredTabGroupSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Partial<StoredTabGroupSession>;
  return Number.isInteger(session.groupId)
    && Number.isInteger(session.windowId)
    && typeof session.title === 'string'
    && Array.isArray(session.ownedTabIds)
    && session.ownedTabIds.every((tabId) => Number.isInteger(tabId))
    && (session.workspaceTabIds === undefined || hasValidWorkspaceTabBindings(session.workspaceTabIds))
    && (session.tabWorkspaceOwners === undefined || hasValidTabWorkspaceOwners(session.tabWorkspaceOwners))
    && (session.tabActivities === undefined || hasValidTabActivities(session.tabActivities))
    && (session.leaseId === undefined || (typeof session.leaseId === 'string' && session.leaseId.length > 0))
    && Number.isFinite(session.idleDeadlineAt);
}

function enqueueTabGroupSessionStorageWrite<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = tabGroupSessionStorageWrites.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  tabGroupSessionStorageWrites.set(key, settled);
  void settled.then(() => {
    if (tabGroupSessionStorageWrites.get(key) === settled) tabGroupSessionStorageWrites.delete(key);
  });
  return next;
}

function enqueueTabGroupSessionMutation<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = tabGroupSessionMutations.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  tabGroupSessionMutations.set(key, settled);
  void settled.then(() => {
    if (tabGroupSessionMutations.get(key) === settled) tabGroupSessionMutations.delete(key);
  });
  return next;
}

function withTabGroupCleanupLease<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = tabGroupCleanupLeases.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  tabGroupCleanupLeases.set(key, settled);
  void settled.then(() => {
    if (tabGroupCleanupLeases.get(key) === settled) tabGroupCleanupLeases.delete(key);
  });
  return next;
}

async function waitForTabGroupCleanupLease(key: string): Promise<void> {
  const pending = tabGroupCleanupLeases.get(key);
  if (pending) await pending;
}

async function retryTabGroupStorageOperation<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < TAB_GROUP_STORAGE_RETRY_ATTEMPTS; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      // Let Chrome finish a transient internal storage operation before retrying.
      if (attempt + 1 < TAB_GROUP_STORAGE_RETRY_ATTEMPTS) await Promise.resolve();
    }
  }
  throw lastError;
}

function persistTabGroupSession(key: string, session: TabGroupSession): Promise<void> {
  return enqueueTabGroupSessionStorageWrite(key, async () => {
    if (tabGroupSessions.get(key) !== session) return;
    await retryTabGroupStorageOperation(() => chrome.storage.session.set({
      [getTabGroupSessionStorageKey(key)]: serializeTabGroupSession(session),
    }));
  });
}

type PersistedTabGroupSessionRemoval = 'removed' | 'missing' | 'replaced';

function removePersistedTabGroupSession(
  key: string,
  leaseId: string,
): Promise<PersistedTabGroupSessionRemoval> {
  return enqueueTabGroupSessionStorageWrite(key, async () => {
    const storageKey = getTabGroupSessionStorageKey(key);
    const current = (await retryTabGroupStorageOperation(() => chrome.storage.session.get(storageKey)))[storageKey];
    if (current === undefined) return 'missing';
    if (!isStoredTabGroupSession(current) || current.leaseId !== leaseId) return 'replaced';
    await retryTabGroupStorageOperation(() => chrome.storage.session.remove(storageKey));
    return 'removed';
  });
}

async function readPersistedTabGroupSession(key: string): Promise<StoredTabGroupSession | null> {
  const storageKey = getTabGroupSessionStorageKey(key);
  const stored = (await retryTabGroupStorageOperation(() => chrome.storage.session.get(storageKey)))[storageKey];
  return isStoredTabGroupSession(stored) ? stored : null;
}

async function removeStoredTabGroupRecordIfStillInvalid(storageKey: string, key?: string): Promise<void> {
  await enqueueTabGroupSessionStorageWrite(key ?? storageKey, async () => {
    const current = (await retryTabGroupStorageOperation(() => chrome.storage.session.get(storageKey)))[storageKey];
    const isCurrentRecordValid = key !== undefined
      && isStoredTabGroupSession(current)
      && current.title === key
      && isCanonicalTabGroupSessionKey(key);
    if (current !== undefined && !isCurrentRecordValid) {
      await retryTabGroupStorageOperation(() => chrome.storage.session.remove(storageKey));
    }
  });
}

function getTabGroupIdleTimeout(cmd: Command): number {
  const seconds = cmd.groupIdleTimeoutSeconds;
  if (seconds === undefined) return WINDOW_IDLE_TIMEOUT;
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('strict-background group idle timeout must be positive');
  return seconds * 1000;
}

function validateStrictBackgroundCommand(cmd: Command): void {
  if (!isTabGroupCarrier(cmd)) return;
  getGroupTitle(cmd);
  getTabGroupIdleTimeout(cmd);
}

function resetWindowIdleTimer(workspace: string): void {
  const session = automationSessions.get(workspace);
  if (!session) return;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleDeadlineAt = Date.now() + WINDOW_IDLE_TIMEOUT;
  session.idleTimer = setTimeout(async () => {
    const current = automationSessions.get(workspace);
    if (!current) return;
    try {
      await chrome.windows.remove(current.windowId);
      console.log(`[autocli] Automation window ${current.windowId} (${workspace}) closed (idle timeout)`);
    } catch {
      // Already gone
    }
    automationSessions.delete(workspace);
  }, WINDOW_IDLE_TIMEOUT);
}

function armTabGroupCleanup(key: string, session: TabGroupSession, deadlineAt: number): void {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleDeadlineAt = deadlineAt;
  chrome.alarms.create(getTabGroupCleanupAlarmName(key), { when: deadlineAt });
  session.idleTimer = setTimeout(() => {
    void cleanupTabGroupSession(key, deadlineAt);
  }, Math.max(0, deadlineAt - Date.now()));
}

function getNextTabGroupCleanupDeadline(session: TabGroupSession): number | null {
  let nextDeadlineAt: number | null = null;
  for (const tabId of session.ownedTabIds) {
    const deadlineAt = session.tabActivities.get(tabId)?.expiresAt;
    if (deadlineAt === undefined) continue;
    if (nextDeadlineAt === null || deadlineAt < nextDeadlineAt) nextDeadlineAt = deadlineAt;
  }
  return nextDeadlineAt;
}

function armTabGroupCleanupForOwnedTabs(key: string, session: TabGroupSession): number | null {
  const nextDeadlineAt = getNextTabGroupCleanupDeadline(session);
  if (nextDeadlineAt !== null) armTabGroupCleanup(key, session, nextDeadlineAt);
  return nextDeadlineAt;
}

function recordTabGroupTabActivity(session: TabGroupSession, tabId: number, cmd: Command): void {
  const lastOperationAt = Date.now();
  session.tabActivities.set(tabId, {
    lastOperationAt,
    expiresAt: lastOperationAt + getTabGroupIdleTimeout(cmd),
  });
}

function scheduleTabGroupCleanupRetry(key: string, session?: TabGroupSession): void {
  const retryAt = Date.now() + TAB_GROUP_CLEANUP_RETRY_DELAY;
  chrome.alarms.create(getTabGroupCleanupAlarmName(key), { when: retryAt });
  if (!session) return;

  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    void cleanupTabGroupSession(key);
  }, Math.max(0, retryAt - Date.now()));
}

function scheduleOrphanTabClose(
  key: string,
  session: Pick<TabGroupSession, 'leaseId' | 'groupId'>,
  tabId: number,
): void {
  chrome.alarms.create(getTabGroupOrphanTabCloseAlarmName(key, session.leaseId, session.groupId, tabId), {
    when: Date.now() + TAB_GROUP_CLEANUP_RETRY_DELAY,
  });
}

async function clearOrphanTabCloseAlarm(alarmName: string): Promise<void> {
  try {
    await chrome.alarms.clear(alarmName);
  } catch {
    // The one-shot alarm may already be gone.
  }
}

async function closeOrphanedTab(key: string, leaseId: string, groupId: number, tabId: number): Promise<void> {
  const alarmName = getTabGroupOrphanTabCloseAlarmName(key, leaseId, groupId, tabId);
  let stored: StoredTabGroupSession | null;
  try {
    stored = await readPersistedTabGroupSession(key);
  } catch {
    // No durable ownership proof means the alarm cannot safely delete a tab.
    await clearOrphanTabCloseAlarm(alarmName);
    return;
  }
  if (
    !stored
    || stored.leaseId !== leaseId
    || stored.groupId !== groupId
    || !stored.ownedTabIds.includes(tabId)
    || !stored.tabWorkspaceOwners?.some(([ownedTabId]) => ownedTabId === tabId)
  ) {
    await clearOrphanTabCloseAlarm(alarmName);
    return;
  }
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    await clearOrphanTabCloseAlarm(alarmName);
    return;
  }
  if (tab.groupId !== groupId) {
    await clearOrphanTabCloseAlarm(alarmName);
    return;
  }

  let groupState: TabGroupSessionState;
  try {
    groupState = await getTabGroupSessionState({
      groupId,
      windowId: tab.windowId,
      title: key,
      ownedTabIds: new Set([tabId]),
      workspaceTabIds: new Map(),
      tabWorkspaceOwners: new Map(),
      tabActivities: new Map(),
      leaseId: '',
      idleTimer: null,
      idleDeadlineAt: 0,
    });
  } catch {
    groupState = 'unavailable';
  }
  if (groupState === 'missing') {
    await clearOrphanTabCloseAlarm(alarmName);
    return;
  }
  if (groupState === 'unavailable') {
    await clearOrphanTabCloseAlarm(alarmName);
    return;
  }

  try {
    await chrome.tabs.remove(tabId);
    await clearOrphanTabCloseAlarm(alarmName);
  } catch {
    scheduleOrphanTabClose(key, { groupId, leaseId }, tabId);
  }
}

/** Get or create the dedicated automation window.
 *  @param initialUrl — if provided (http/https), used as the initial page instead of about:blank.
 *    This avoids an extra blank-page→target-domain navigation on first command.
 */
async function getAutomationWindow(workspace: string, initialUrl?: string): Promise<number> {
  // Check if our window is still alive
  const existing = automationSessions.get(workspace);
  if (existing) {
    try {
      await chrome.windows.get(existing.windowId);
      return existing.windowId;
    } catch {
      // Window was closed by user
      automationSessions.delete(workspace);
    }
  }

  // Use the target URL directly if it's a safe navigation URL, otherwise fall back to about:blank.
  const startUrl = (initialUrl && isSafeNavigationUrl(initialUrl)) ? initialUrl : BLANK_PAGE;

  // Note: Do NOT set `state` parameter here. Chrome 146+ rejects 'normal' as an invalid
  // state value for windows.create(). The window defaults to 'normal' state anyway.
  const win = await chrome.windows.create({
    url: startUrl,
    focused: false,
    width: 1280,
    height: 900,
    type: 'normal',
  });
  const session: AutomationSession = {
    windowId: win.id!,
    idleTimer: null,
    idleDeadlineAt: Date.now() + WINDOW_IDLE_TIMEOUT,
  };
  automationSessions.set(workspace, session);
  console.log(`[autocli] Created automation window ${session.windowId} (${workspace}, start=${startUrl})`);
  resetWindowIdleTimer(workspace);
  // Wait for the initial tab to finish loading instead of a fixed 200ms sleep.
  const tabs = await chrome.tabs.query({ windowId: win.id! });
  if (tabs[0]?.id) {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 500); // fallback cap
      const listener = (tabId: number, info: chrome.tabs.TabChangeInfo) => {
        if (tabId === tabs[0].id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timeout);
          resolve();
        }
      };
      // Check if already complete before listening
      if (tabs[0].status === 'complete') {
        clearTimeout(timeout);
        resolve();
      } else {
        chrome.tabs.onUpdated.addListener(listener);
      }
    });
  }
  return session.windowId;
}

// Clean up when the automation window is closed
chrome.windows.onRemoved.addListener((windowId) => {
  for (const [workspace, session] of automationSessions.entries()) {
    if (session.windowId === windowId) {
      console.log(`[autocli] Automation window closed (${workspace})`);
      if (session.idleTimer) clearTimeout(session.idleTimer);
      automationSessions.delete(workspace);
    }
  }
});

// Keep the ownership ledger small when a user or Chrome closes one of our
// tabs before the next command or idle cleanup reconciliation runs.
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [key, session] of tabGroupSessions.entries()) {
    if (!session.ownedTabIds.has(tabId)) continue;
    void enqueueTabGroupSessionMutation(key, async () => {
      if (tabGroupSessions.get(key) !== session || !session.ownedTabIds.delete(tabId)) return;
      removeTabGroupTabMetadata(session, tabId);
      const nextDeadlineAt = armTabGroupCleanupForOwnedTabs(key, session);
      if (nextDeadlineAt === null) armTabGroupCleanup(key, session, Date.now());
      try {
        await persistTabGroupSession(key, session);
      } catch {
        // A later command or cleanup reconciliation retries without inferring
        // ownership from the other tabs in the group.
        scheduleTabGroupCleanupRetry(key, session);
      }
    });
  }
});

// ─── Lifecycle events ────────────────────────────────────────────────

let initialized = false;

function initialize(): void {
  if (initialized) return;
  initialized = true;
  chrome.alarms.create('keepalive', { periodInMinutes: 0.4 }); // ~24 seconds
  executor.registerListeners();
  void connect();
  console.log('[autocli] AutoCLI extension initialized');
}

chrome.runtime.onInstalled.addListener(() => {
  initialize();
});

chrome.runtime.onStartup.addListener(() => {
  initialize();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    void connect();
    return;
  }
  if (alarm.name === TAB_GROUP_RESTORE_RETRY_ALARM) {
    void restoreTabGroupCleanupAlarms();
    return;
  }
  const orphanTab = getTabGroupOrphanTabCloseAlarm(alarm.name);
  if (orphanTab) {
    void closeOrphanedTab(orphanTab.key, orphanTab.leaseId, orphanTab.groupId, orphanTab.tabId);
    return;
  }
  const sessionKey = getTabGroupSessionKeyFromAlarmName(alarm.name);
  if (sessionKey) void cleanupTabGroupSession(sessionKey);
});

void restoreTabGroupCleanupAlarms();

// ─── Popup status API ───────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'getStatus') {
    sendResponse({
      connected: ws?.readyState === WebSocket.OPEN,
      reconnecting: reconnectTimer !== null,
    });
  }
  return false;
});

// ─── Command dispatcher ─────────────────────────────────────────────

async function handleCommand(cmd: Command): Promise<Result> {
  const workspace = getWorkspaceKey(cmd.workspace);
  let tabGroupActivityKey: string | undefined;
  try {
    validateStrictBackgroundCommand(cmd);

    // Strict-background cleanup is still fenced per group while a command runs,
    // but timestamps are updated only for the tab that the command actually
    // operates on. A list or another workspace's command must not extend every
    // tab in the shared physical group.
    if (isTabGroupCarrier(cmd)) {
      // This synchronous fence is visible to an in-flight cleanup before it can
      // issue the next tabs.remove call, even while renewal is queued behind it.
      tabGroupActivityKey = getTabGroupSessionKey(getGroupTitle(cmd));
      beginTabGroupCommand(tabGroupActivityKey);
      // A cleanup that already submitted chrome.tabs.remove cannot be cancelled.
      // Wait for that same-title cleanup to finish before resolving a tab, so a
      // later command never starts using a tab Chrome is concurrently deleting.
      await waitForTabGroupCleanupLease(tabGroupActivityKey);
      // Enforce the title's single-group invariant for every strict command,
      // including read-only list and close-window paths that do not create a
      // session themselves.
      await findUniqueTabGroupsByTitle(getGroupTitle(cmd));
    } else {
      resetWindowIdleTimer(workspace);
    }

    switch (cmd.action) {
      case 'exec':
        return await handleExec(cmd, workspace);
      case 'navigate':
        return await handleNavigate(cmd, workspace);
      case 'tabs':
        return await handleTabs(cmd, workspace);
      case 'cookies':
        return await handleCookies(cmd);
      case 'screenshot':
        return await handleScreenshot(cmd, workspace);
      case 'close-window':
        return await handleCloseWindow(cmd, workspace);
      case 'cdp':
        return await handleCdp(cmd, workspace);
      case 'sessions':
        return await handleSessions(cmd);
      case 'set-file-input':
        return await handleSetFileInput(cmd, workspace);
      case 'read-article':
        return await handleReadArticle(cmd, workspace);
      default:
        return { id: cmd.id, ok: false, error: `Unknown action: ${cmd.action}` };
    }
  } catch (err) {
    return {
      id: cmd.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (tabGroupActivityKey) {
      endTabGroupCommand(tabGroupActivityKey);
      // An alarm may have fired while this command held the cleanup fence. Run
      // the per-tab expiry sweep once the command releases it instead of
      // renewing unrelated tabs in the same group.
      cleanupExpiredTabGroupTabsAfterCommand(tabGroupActivityKey);
    }
  }
}

// ─── Action handlers ─────────────────────────────────────────────────

/** Internal blank page used when no user URL is provided. */
const BLANK_PAGE = 'about:blank';

/** Check if a URL can be attached via CDP — only allow http(s) and blank pages. */
function isDebuggableUrl(url?: string): boolean {
  if (!url) return true;  // empty/undefined = tab still loading, allow it
  return url.startsWith('http://') || url.startsWith('https://') || url === 'about:blank' || url.startsWith('data:');
}

/** Check if a URL is safe for user-facing navigation (http/https only). */
function isSafeNavigationUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

/** Minimal URL normalization for same-page comparison: root slash + default port only. */
function normalizeUrlForComparison(url?: string): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) {
      parsed.port = '';
    }
    const pathname = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

function isTargetUrl(currentUrl: string | undefined, targetUrl: string): boolean {
  return normalizeUrlForComparison(currentUrl) === normalizeUrlForComparison(targetUrl);
}

function setWorkspaceSession(workspace: string, session: Pick<AutomationSession, 'windowId'>): void {
  const existing = automationSessions.get(workspace);
  if (existing?.idleTimer) clearTimeout(existing.idleTimer);
  automationSessions.set(workspace, {
    ...session,
    idleTimer: null,
    idleDeadlineAt: Date.now() + WINDOW_IDLE_TIMEOUT,
  });
}

type ResolvedTab = { tabId: number; tab: chrome.tabs.Tab | null };

async function getHostWindowId(): Promise<number> {
  try {
    const lastFocused = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (lastFocused.id !== undefined) return lastFocused.id;
  } catch {
    // Fall through to getAll.
  }
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  const host = windows.find((win) => win.id !== undefined);
  if (host?.id === undefined) {
    throw new Error('strict-background mode requires an existing normal Chrome window');
  }
  return host.id;
}

type TabGroupSessionState = 'live' | 'missing' | 'unavailable';

function isCanonicalTabGroupSessionKey(key: string): boolean {
  return key.startsWith('AutoCLI-') && !key.includes('\n') && !key.includes('\r');
}

function isCurrentTabGroupCleanup(key: string, session: TabGroupSession, deadlineAt: number): boolean {
  return tabGroupSessions.get(key) === session && session.idleDeadlineAt === deadlineAt;
}

function isCurrentTabGroupCleanupAttempt(
  key: string,
  session: TabGroupSession,
  deadlineAt: number,
  activityGeneration: number,
): boolean {
  return isCurrentTabGroupCleanup(key, session, deadlineAt)
    && isTabGroupActivityCurrent(key, activityGeneration)
    && !isTabGroupCommandActive(key);
}

function getLiveOwnedTabIds(tabs: chrome.tabs.Tab[], ownedTabIds: Set<number>): number[] {
  return tabs
    .map((tab) => tab.id)
    .filter((tabId): tabId is number => tabId !== undefined && ownedTabIds.has(tabId));
}

function removeWorkspaceTabBindingsForTab(session: TabGroupSession, tabId: number): boolean {
  let changed = false;
  for (const [workspace, boundTabId] of session.workspaceTabIds.entries()) {
    if (boundTabId !== tabId) continue;
    session.workspaceTabIds.delete(workspace);
    changed = true;
  }
  return changed;
}

function removeTabWorkspaceOwner(session: TabGroupSession, tabId: number): boolean {
  const removed = session.tabWorkspaceOwners.delete(tabId);
  return removeWorkspaceTabBindingsForTab(session, tabId) || removed;
}

function removeTabGroupTabMetadata(session: TabGroupSession, tabId: number): boolean {
  const removedActivity = session.tabActivities.delete(tabId);
  return removeTabWorkspaceOwner(session, tabId) || removedActivity;
}

function createLegacyTabActivity(expiresAt: number): TabGroupTabActivity {
  // Older records only had a group-level deadline. Preserve that deadline as
  // the migration boundary instead of inventing a newer last-operation time.
  return { lastOperationAt: expiresAt, expiresAt };
}

function ensureOwnedTabActivities(session: TabGroupSession): boolean {
  let changed = false;
  for (const tabId of session.ownedTabIds) {
    if (session.tabActivities.has(tabId)) continue;
    session.tabActivities.set(tabId, createLegacyTabActivity(session.idleDeadlineAt));
    changed = true;
  }
  for (const tabId of session.tabActivities.keys()) {
    if (session.ownedTabIds.has(tabId)) continue;
    session.tabActivities.delete(tabId);
    changed = true;
  }
  return changed;
}

function pruneWorkspaceTabBindings(session: TabGroupSession, liveOwnedTabIds: Set<number>): boolean {
  let changed = false;
  for (const [workspace, tabId] of session.workspaceTabIds.entries()) {
    if (liveOwnedTabIds.has(tabId)) continue;
    session.workspaceTabIds.delete(workspace);
    changed = true;
  }
  return changed;
}

function pruneTabWorkspaceOwners(session: TabGroupSession, liveOwnedTabIds: Set<number>): boolean {
  let changed = false;
  for (const tabId of session.tabWorkspaceOwners.keys()) {
    if (liveOwnedTabIds.has(tabId)) continue;
    session.tabWorkspaceOwners.delete(tabId);
    changed = true;
  }
  return changed;
}

function pruneTabActivities(session: TabGroupSession, liveOwnedTabIds: Set<number>): boolean {
  let changed = false;
  for (const tabId of session.tabActivities.keys()) {
    if (liveOwnedTabIds.has(tabId)) continue;
    session.tabActivities.delete(tabId);
    changed = true;
  }
  return changed;
}

async function getTabGroupSessionState(session: TabGroupSession): Promise<TabGroupSessionState> {
  try {
    const group = await chrome.tabGroups.get(session.groupId);
    return group.title === session.title ? 'live' : 'missing';
  } catch {
    try {
      const groups = await chrome.tabGroups.query({ title: session.title });
      return groups.some((group) => group.id === session.groupId && group.title === session.title)
        ? 'live'
        : 'missing';
    } catch {
      return 'unavailable';
    }
  }
}

async function reconcileTabGroupSession(key: string, session: TabGroupSession): Promise<TabGroupSessionState> {
  const groupState = await getTabGroupSessionState(session);
  if (groupState !== 'live') return groupState;

  const knownOwnedTabIds = new Set(session.ownedTabIds);
  let groupTabs: chrome.tabs.Tab[];
  try {
    groupTabs = await chrome.tabs.query({ groupId: session.groupId });
  } catch {
    return 'unavailable';
  }

  const liveOwnedTabIds = new Set(getLiveOwnedTabIds(groupTabs, knownOwnedTabIds));
  const staleOwnedTabIds = [...knownOwnedTabIds].filter((tabId) => !liveOwnedTabIds.has(tabId));
  const prunedWorkspaceBindings = pruneWorkspaceTabBindings(session, liveOwnedTabIds);
  const prunedTabOwners = pruneTabWorkspaceOwners(session, liveOwnedTabIds);
  const prunedTabActivities = pruneTabActivities(session, liveOwnedTabIds);
  if (staleOwnedTabIds.length > 0) {
    for (const tabId of staleOwnedTabIds) session.ownedTabIds.delete(tabId);
  }
  const restoredMissingActivities = ensureOwnedTabActivities(session);
  const nextDeadlineAt = getNextTabGroupCleanupDeadline(session);
  const deadlineChanged = nextDeadlineAt !== null && nextDeadlineAt !== session.idleDeadlineAt;
  if (deadlineChanged && nextDeadlineAt !== null) {
    armTabGroupCleanup(key, session, nextDeadlineAt);
  }
  if (
    staleOwnedTabIds.length > 0
    || prunedWorkspaceBindings
    || prunedTabOwners
    || prunedTabActivities
    || restoredMissingActivities
    || deadlineChanged
  ) {
    await persistTabGroupSession(key, session);
  }
  return 'live';
}

async function retryTabGroupCleanup(
  key: string,
  session: TabGroupSession,
  expectedDeadlineAt?: number,
): Promise<void> {
  if (expectedDeadlineAt !== undefined && !isCurrentTabGroupCleanup(key, session, expectedDeadlineAt)) return;
  // A retry does not change the durable deadline. A storage outage must not
  // turn into an untracked session or grant cleanup permission over user tabs.
  scheduleTabGroupCleanupRetry(key, session);
  console.warn(`[autocli] Retrying cleanup of tab group ${session.title}`);
}

async function restoreTabGroupSessionAfterDiscardRace(
  key: string,
  session: TabGroupSession,
): Promise<void> {
  if (tabGroupSessions.get(key) !== session) return;
  try {
    await persistTabGroupSession(key, session);
  } catch {
    scheduleTabGroupCleanupRetry(key, session);
    return;
  }
  if (tabGroupSessions.get(key) !== session) return;

  const nextDeadlineAt = getNextTabGroupCleanupDeadline(session);
  if (nextDeadlineAt !== null && nextDeadlineAt > Date.now()) {
    armTabGroupCleanup(key, session, nextDeadlineAt);
  } else {
    scheduleTabGroupCleanupRetry(key, session);
  }
}

async function discardTabGroupSession(
  key: string,
  session?: TabGroupSession,
  expectedDeadlineAt?: number,
  expectedActivityGeneration?: number,
): Promise<boolean> {
  const activityChanged = (): boolean => expectedActivityGeneration !== undefined
    && !isTabGroupActivityCurrent(key, expectedActivityGeneration);
  const current = tabGroupSessions.get(key);
  if (!session) return false;
  if (session && current !== session) return false;
  if (expectedDeadlineAt !== undefined && (!session || !isCurrentTabGroupCleanup(key, session, expectedDeadlineAt))) {
    return false;
  }
  if (activityChanged()) return false;
  if (current?.idleTimer) {
    clearTimeout(current.idleTimer);
    current.idleTimer = null;
  }

  try {
    const removal = await removePersistedTabGroupSession(key, session.leaseId);
    if (removal === 'replaced') {
      if (tabGroupSessions.get(key) === session) await restoreTabGroupSessionAfterDiscardRace(key, session);
      return false;
    }
  } catch {
    if (activityChanged()) return false;
    if (session && tabGroupSessions.get(key) === session) {
      await retryTabGroupCleanup(key, session, expectedDeadlineAt);
    }
    return false;
  }

  if (activityChanged()) {
    if (session) await restoreTabGroupSessionAfterDiscardRace(key, session);
    return false;
  }
  if (session && tabGroupSessions.get(key) !== session) return false;
  if (expectedDeadlineAt !== undefined && (!session || !isCurrentTabGroupCleanup(key, session, expectedDeadlineAt))) {
    return false;
  }

  try {
    await chrome.alarms.clear(getTabGroupCleanupAlarmName(key));
  } catch {
    // The alarm may already be gone.
  }

  if (activityChanged()) {
    if (session) await restoreTabGroupSessionAfterDiscardRace(key, session);
    return false;
  }
  if (session && tabGroupSessions.get(key) !== session) return false;
  if (expectedDeadlineAt !== undefined && (!session || !isCurrentTabGroupCleanup(key, session, expectedDeadlineAt))) {
    const latest = tabGroupSessions.get(key);
    if (latest) armTabGroupCleanupForOwnedTabs(key, latest);
    return false;
  }

  if (tabGroupSessions.get(key) === session) {
    tabGroupSessions.delete(key);
    tabGroupActivityGenerations.delete(key);
  }
  return true;
}

async function getExistingTabGroupSession(
  key: string,
  expectedActivityGeneration?: number,
): Promise<TabGroupSession | null> {
  const existing = tabGroupSessions.get(key);
  if (existing) {
    const state = await reconcileTabGroupSession(key, existing);
    if (state === 'missing') {
      await discardTabGroupSession(key, existing, existing.idleDeadlineAt, expectedActivityGeneration);
      return null;
    }
    return existing;
  }

  const stored = await readPersistedTabGroupSession(key);
  if (!stored || stored.title !== key || !isCanonicalTabGroupSessionKey(key)) return null;

  const concurrent = tabGroupSessions.get(key);
  if (concurrent) return concurrent;
  const restored: TabGroupSession = {
    groupId: stored.groupId,
    windowId: stored.windowId,
    title: stored.title,
    ownedTabIds: new Set(stored.ownedTabIds),
    workspaceTabIds: new Map(stored.workspaceTabIds ?? []),
    // Older ledgers cannot establish a safe owner for their tabs. Leave them
    // unowned rather than adopting them from the shared group.
    tabWorkspaceOwners: new Map(stored.tabWorkspaceOwners ?? []),
    tabActivities: new Map(stored.tabActivities ?? stored.ownedTabIds.map((tabId) => [
      tabId,
      createLegacyTabActivity(stored.idleDeadlineAt),
    ])),
    leaseId: stored.leaseId ?? createTabGroupSessionLeaseId(),
    idleTimer: null,
    idleDeadlineAt: stored.idleDeadlineAt,
  };
  tabGroupSessions.set(key, restored);

  const state = await reconcileTabGroupSession(key, restored);
  if (state === 'missing') {
    await discardTabGroupSession(key, restored, restored.idleDeadlineAt, expectedActivityGeneration);
    return null;
  }
  if (
    stored.workspaceTabIds === undefined
    || stored.tabWorkspaceOwners === undefined
    || stored.tabActivities === undefined
    || stored.leaseId === undefined
  ) {
    await persistTabGroupSession(key, restored);
  }
  return restored;
}

async function touchTabGroupTab(cmd: Command, workspace: string, tabId: number): Promise<void> {
  if (!isTabGroupCarrier(cmd)) return;
  const key = getTabGroupSessionKey(getGroupTitle(cmd));
  await enqueueTabGroupSessionMutation(key, async () => {
    const session = tabGroupSessions.get(key) ?? await getExistingTabGroupSession(key);
    if (
      !session
      || !session.ownedTabIds.has(tabId)
      || session.tabWorkspaceOwners.get(tabId) !== workspace
    ) {
      throw new Error(`strict-background-stale-tab: Tab ${tabId} is no longer owned by workspace ${workspace}`);
    }

    const previousDeadlineAt = session.idleDeadlineAt;
    const previousActivity = session.tabActivities.get(tabId);
    recordTabGroupTabActivity(session, tabId, cmd);
    beginTabGroupActivity(key);
    armTabGroupCleanupForOwnedTabs(key, session);
    try {
      await persistTabGroupSession(key, session);
    } catch (error) {
      if (previousActivity) {
        session.tabActivities.set(tabId, previousActivity);
      } else {
        session.tabActivities.delete(tabId);
      }
      armTabGroupCleanup(key, session, previousDeadlineAt);
      throw error;
    }
  });
}

async function touchWorkspaceTabOnStrictBackgroundRelease(cmd: Command, workspace: string): Promise<void> {
  const key = getTabGroupSessionKey(getGroupTitle(cmd));
  const session = await getExistingTabGroupSession(key);
  if (!session) return;
  const tabId = cmd.tabId ?? session.workspaceTabIds.get(workspace);
  if (tabId === undefined || session.tabWorkspaceOwners.get(tabId) !== workspace) return;
  await touchTabGroupTab(cmd, workspace, tabId);
}

function cleanupExpiredTabGroupTabsAfterCommand(key: string): void {
  const session = tabGroupSessions.get(key);
  if (!session) return;
  const nextDeadlineAt = getNextTabGroupCleanupDeadline(session);
  if (nextDeadlineAt === null) return;
  if (nextDeadlineAt <= Date.now()) {
    void cleanupTabGroupSession(key);
  } else {
    armTabGroupCleanup(key, session, nextDeadlineAt);
  }
}

async function cleanupTabGroupSession(key: string, expectedDeadlineAt?: number): Promise<void> {
  return withTabGroupCleanupLease(key, () => cleanupTabGroupSessionLocked(key, expectedDeadlineAt));
}

async function cleanupTabGroupSessionLocked(key: string, expectedDeadlineAt?: number): Promise<void> {
  const activityGeneration = tabGroupActivityGenerations.get(key) ?? 0;
  if (isTabGroupCommandActive(key)) {
    const activeSession = tabGroupSessions.get(key);
    if (activeSession) scheduleTabGroupCleanupRetry(key, activeSession);
    return;
  }
  let current: TabGroupSession | null;
  try {
    current = await getExistingTabGroupSession(key, activityGeneration);
  } catch {
    scheduleTabGroupCleanupRetry(key, tabGroupSessions.get(key));
    return;
  }
  if (!isTabGroupActivityCurrent(key, activityGeneration)) {
    if (isTabGroupCommandActive(key) && current) scheduleTabGroupCleanupRetry(key, current);
    return;
  }
  if (!current) {
    try {
      await chrome.alarms.clear(getTabGroupCleanupAlarmName(key));
    } catch {
      // The alarm may already be gone.
    }
    return;
  }

  const deadlineAt = current.idleDeadlineAt;
  if (expectedDeadlineAt !== undefined && expectedDeadlineAt !== deadlineAt) return;
  if (!isCurrentTabGroupCleanupAttempt(key, current, deadlineAt, activityGeneration)) return;
  if (Date.now() < deadlineAt) {
    armTabGroupCleanup(key, current, deadlineAt);
    try {
      await persistTabGroupSession(key, current);
    } catch {
      // The existing durable deadline is unchanged, and the alarm remains armed.
    }
    return;
  }

  let state: TabGroupSessionState;
  try {
    state = await reconcileTabGroupSession(key, current);
  } catch {
    if (!isCurrentTabGroupCleanupAttempt(key, current, deadlineAt, activityGeneration)) return;
    await retryTabGroupCleanup(key, current, deadlineAt);
    return;
  }
  if (!isCurrentTabGroupCleanupAttempt(key, current, deadlineAt, activityGeneration)) return;
  if (state === 'missing') {
    await discardTabGroupSession(key, current, deadlineAt, activityGeneration);
    return;
  }
  if (state === 'unavailable') {
    await retryTabGroupCleanup(key, current, deadlineAt);
    return;
  }
  if (!isCurrentTabGroupCleanup(key, current, deadlineAt)) return;

  if (current.ownedTabIds.size === 0) {
    if (await discardTabGroupSession(key, current, deadlineAt, activityGeneration)) {
      console.log(`[autocli] Tab group ${current.title} released (no owned tabs)`);
    }
    return;
  }

  let groupTabs: chrome.tabs.Tab[];
  try {
    groupTabs = await chrome.tabs.query({ groupId: current.groupId });
  } catch {
    if (!isCurrentTabGroupCleanupAttempt(key, current, deadlineAt, activityGeneration)) return;
    await retryTabGroupCleanup(key, current, deadlineAt);
    return;
  }
  if (!isCurrentTabGroupCleanupAttempt(key, current, deadlineAt, activityGeneration)) return;

  const now = Date.now();
  const expiredTabIds = getLiveOwnedTabIds(groupTabs, current.ownedTabIds)
    .filter((tabId) => current!.tabActivities.get(tabId)?.expiresAt !== undefined
      && current!.tabActivities.get(tabId)!.expiresAt <= now);

  if (expiredTabIds.length === 0) {
    // An old alarm can race a per-tab touch or stale-ledger reconciliation.
    // Recompute from the individual tab deadlines instead of deleting a tab
    // merely because the previous group-level scheduler deadline elapsed.
    const nextDeadlineAt = armTabGroupCleanupForOwnedTabs(key, current);
    if (nextDeadlineAt !== null) {
      try {
        await persistTabGroupSession(key, current);
      } catch {
        await retryTabGroupCleanup(key, current, deadlineAt);
      }
    }
    return;
  }

  for (const tabId of expiredTabIds) {
    if (!isCurrentTabGroupCleanupAttempt(key, current, deadlineAt, activityGeneration)) return;
    try {
      // Recheck membership immediately before removal. A user may have moved
      // this tab out of the group after the group query; in that case the
      // following reconciliation only drops the AutoCLI ledger entry.
      const tab = await chrome.tabs.get(tabId);
      if (tab.groupId !== current.groupId) continue;
      await chrome.tabs.remove(tabId);
    } catch {
      // The tab may have been closed after the live-tab query.
    }
  }

  let remainingState: TabGroupSessionState;
  try {
    remainingState = await reconcileTabGroupSession(key, current);
  } catch {
    if (!isCurrentTabGroupCleanupAttempt(key, current, deadlineAt, activityGeneration)) return;
    await retryTabGroupCleanup(key, current, deadlineAt);
    return;
  }
  if (!isCurrentTabGroupCleanupAttempt(key, current, deadlineAt, activityGeneration)) return;
  if (remainingState === 'missing') {
    await discardTabGroupSession(key, current, deadlineAt, activityGeneration);
    return;
  }
  if (remainingState === 'unavailable') {
    await retryTabGroupCleanup(key, current, deadlineAt);
    return;
  }
  if (!isCurrentTabGroupCleanupAttempt(key, current, deadlineAt, activityGeneration)) return;

  if (current.ownedTabIds.size > 0) {
    const nextDeadlineAt = getNextTabGroupCleanupDeadline(current);
    if (nextDeadlineAt !== null && nextDeadlineAt > Date.now()) {
      armTabGroupCleanup(key, current, nextDeadlineAt);
      try {
        await persistTabGroupSession(key, current);
      } catch {
        await retryTabGroupCleanup(key, current, deadlineAt);
      }
    } else {
      await retryTabGroupCleanup(key, current, deadlineAt);
    }
    return;
  }

  if (await discardTabGroupSession(key, current, deadlineAt, activityGeneration)) {
    console.log(`[autocli] Tab group ${current.title} released (idle timeout)`);
  }
}

async function restoreTabGroupCleanupAlarms(): Promise<void> {
  try {
    const records = await retryTabGroupStorageOperation(() => chrome.storage.session.get());
    for (const [storageKey, value] of Object.entries(records)) {
      if (!storageKey.startsWith(TAB_GROUP_SESSION_STORAGE_PREFIX)) continue;
      let key: string;
      try {
        key = decodeURIComponent(storageKey.slice(TAB_GROUP_SESSION_STORAGE_PREFIX.length));
      } catch {
        await removeStoredTabGroupRecordIfStillInvalid(storageKey);
        continue;
      }
      if (!isStoredTabGroupSession(value) || value.title !== key || !isCanonicalTabGroupSessionKey(key)) {
        await removeStoredTabGroupRecordIfStillInvalid(storageKey, key);
        continue;
      }

      const session = await getExistingTabGroupSession(key);
      if (!session) continue;
      if (session.idleDeadlineAt <= Date.now()) {
        void cleanupTabGroupSession(key);
      } else {
        armTabGroupCleanup(key, session, session.idleDeadlineAt);
      }
    }
  } catch {
    // Storage can be temporarily unavailable while Chrome starts the extension.
    chrome.alarms.create(TAB_GROUP_RESTORE_RETRY_ALARM, {
      when: Date.now() + TAB_GROUP_CLEANUP_RETRY_DELAY,
    });
  }
}

async function abandonUnpersistedTabGroupSession(key: string, session: TabGroupSession): Promise<void> {
  if (tabGroupSessions.get(key) !== session) return;
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
  tabGroupSessions.delete(key);
  tabGroupActivityGenerations.delete(key);
  try {
    await chrome.alarms.clear(getTabGroupCleanupAlarmName(key));
  } catch {
    // The alarm may already be gone.
  }
  try {
    await removePersistedTabGroupSession(key, session.leaseId);
  } catch {
    // If a failed set actually reached Chrome, a later reconciliation removes
    // the stale ID after this command's created tab has been closed.
  }
}

async function rollbackNewOwnedTabRegistration(
  key: string,
  session: TabGroupSession,
  tabId: number,
): Promise<void> {
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // Retain the ID when the tab cannot be closed. A retry alarm is only safe
    // after the failed tab's ownership has been durably recorded.
    try {
      await persistTabGroupSession(key, session);
      scheduleOrphanTabClose(key, session, tabId);
    } catch {
      // The command still fails; we never infer ownership from group membership.
    }
    return;
  }

  session.ownedTabIds.delete(tabId);
  removeTabGroupTabMetadata(session, tabId);
  const nextDeadlineAt = armTabGroupCleanupForOwnedTabs(key, session);
  if (nextDeadlineAt === null) armTabGroupCleanup(key, session, Date.now());
  try {
    await persistTabGroupSession(key, session);
  } catch {
    // A stale stored ID is harmless: reconciliation only removes IDs that were
    // already recorded as AutoCLI-owned and are no longer in the live group.
  }
}

async function registerNewOwnedTab(
  key: string,
  session: TabGroupSession,
  tabId: number,
  cmd: Command,
  workspace?: string,
): Promise<void> {
  await enqueueTabGroupSessionMutation(key, async () => {
    if (tabGroupSessions.get(key) !== session) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        // No current session can authorize a cross-restart retry here.
      }
      throw new Error(`strict-background group ${session.title} was released before the new tab could be registered`);
    }

    session.ownedTabIds.add(tabId);
    if (workspace) {
      session.workspaceTabIds.set(workspace, tabId);
      session.tabWorkspaceOwners.set(tabId, workspace);
    }
    const previousDeadlineAt = session.idleDeadlineAt;
    const previousActivity = session.tabActivities.get(tabId);
    recordTabGroupTabActivity(session, tabId, cmd);
    beginTabGroupActivity(key);
    armTabGroupCleanupForOwnedTabs(key, session);
    try {
      await persistTabGroupSession(key, session);
    } catch (error) {
      if (previousActivity) {
        session.tabActivities.set(tabId, previousActivity);
      } else {
        session.tabActivities.delete(tabId);
      }
      armTabGroupCleanup(key, session, previousDeadlineAt);
      await rollbackNewOwnedTabRegistration(key, session, tabId);
      throw error;
    }
  });
}

async function findUniqueTabGroupsByTitle(title: string) {
  const exactGroups = (await chrome.tabGroups.query({ title }))
    .filter((group) => group.id !== undefined && group.title === title);
  if (exactGroups.length > 1) {
    throw new Error(
      `strict-background found multiple open tab groups named ${title}; refusing to choose one`,
    );
  }
  return exactGroups;
}

async function createTabGroupSession(title: string, key: string, cmd: Command): Promise<TabGroupSession> {
  const existing = await getExistingTabGroupSession(key);
  if (existing) {
    await findUniqueTabGroupsByTitle(title);
    armTabGroupCleanupForOwnedTabs(key, existing);
    return existing;
  }

  const exactGroups = await findUniqueTabGroupsByTitle(title);
  const reusable = exactGroups[0];
  if (reusable?.id !== undefined) {
    const groupTabs = await chrome.tabs.query({ groupId: reusable.id });
    const windowId = reusable.windowId ?? groupTabs[0]?.windowId;
    if (windowId === undefined) {
      throw new Error(`strict-background group ${title} has no normal host window`);
    }
    const session: TabGroupSession = {
      groupId: reusable.id,
      windowId,
      title,
      ownedTabIds: new Set(),
      workspaceTabIds: new Map(),
      tabWorkspaceOwners: new Map(),
      tabActivities: new Map(),
      leaseId: createTabGroupSessionLeaseId(),
      idleTimer: null,
      idleDeadlineAt: Date.now() + getTabGroupIdleTimeout(cmd),
    };
    tabGroupSessions.set(key, session);
    try {
      armTabGroupCleanup(key, session, session.idleDeadlineAt);
      await persistTabGroupSession(key, session);
    } catch (error) {
      await abandonUnpersistedTabGroupSession(key, session);
      throw error;
    }
    return session;
  }

  const windowId = await getHostWindowId();
  const seedTab = await chrome.tabs.create({ windowId, url: BLANK_PAGE, active: false });
  if (!seedTab.id) throw new Error('Failed to create strict-background seed tab');
  let groupId: number | undefined;
  let session: TabGroupSession | undefined;
  try {
    groupId = await chrome.tabs.group({ tabIds: [seedTab.id] });
    await chrome.tabGroups.update(groupId, { title, color: 'blue', collapsed: true });
    const confirmedGroups = await findUniqueTabGroupsByTitle(title);
    if (!confirmedGroups.some((group) => group.id === groupId)) {
      throw new Error(`strict-background group ${title} disappeared while it was being created`);
    }
    const lastOperationAt = Date.now();
    session = {
      groupId,
      windowId,
      title,
      ownedTabIds: new Set([seedTab.id]),
      workspaceTabIds: new Map([[getWorkspaceKey(cmd.workspace), seedTab.id]]),
      tabWorkspaceOwners: new Map([[seedTab.id, getWorkspaceKey(cmd.workspace)]]),
      tabActivities: new Map([[seedTab.id, {
        lastOperationAt,
        expiresAt: lastOperationAt + getTabGroupIdleTimeout(cmd),
      }]]),
      leaseId: createTabGroupSessionLeaseId(),
      idleTimer: null,
      idleDeadlineAt: lastOperationAt + getTabGroupIdleTimeout(cmd),
    };
    tabGroupSessions.set(key, session);
    beginTabGroupActivity(key);
    armTabGroupCleanupForOwnedTabs(key, session);
    await persistTabGroupSession(key, session);
    return session;
  } catch (error) {
    if (session) await abandonUnpersistedTabGroupSession(key, session);
    try {
      await chrome.tabs.remove(seedTab.id);
    } catch {
      // Only retry when Chrome confirms this newly created tab belongs to the
      // expected AutoCLI group; otherwise a reused tab ID must never be closed.
      // No persisted session exists yet, so a durable retry alarm would not
      // have authority to close this tab after a restart.
    }
    throw error;
  }
}

async function getTabGroupSession(cmd: Command): Promise<TabGroupSession> {
  const title = getGroupTitle(cmd);
  const key = getTabGroupSessionKey(title);
  const existing = await getExistingTabGroupSession(key);
  if (existing) {
    await findUniqueTabGroupsByTitle(title);
    armTabGroupCleanupForOwnedTabs(key, existing);
    return existing;
  }

  const pending = tabGroupSessionLocks.get(key);
  if (pending) {
    const session = await pending;
    await findUniqueTabGroupsByTitle(title);
    armTabGroupCleanupForOwnedTabs(key, session);
    return session;
  }

  const creation = createTabGroupSession(title, key, cmd);
  tabGroupSessionLocks.set(key, creation);
  try {
    return await creation;
  } finally {
    if (tabGroupSessionLocks.get(key) === creation) {
      tabGroupSessionLocks.delete(key);
    }
  }
}

async function clearWorkspaceTabBinding(
  key: string,
  session: TabGroupSession,
  workspace: string,
  tabId: number,
): Promise<void> {
  if (session.workspaceTabIds.get(workspace) !== tabId) return;
  await enqueueTabGroupSessionMutation(key, async () => {
    if (tabGroupSessions.get(key) !== session || session.workspaceTabIds.get(workspace) !== tabId) return;
    session.workspaceTabIds.delete(workspace);
    await persistTabGroupSession(key, session);
  });
}

async function pruneStaleTabGroupTab(
  key: string,
  session: TabGroupSession,
  tabId: number,
): Promise<void> {
  await enqueueTabGroupSessionMutation(key, async () => {
    if (tabGroupSessions.get(key) !== session) return;
    const removed = session.ownedTabIds.delete(tabId);
    const removedMetadata = removeTabGroupTabMetadata(session, tabId);
    if (!removed && !removedMetadata) return;
    const nextDeadlineAt = armTabGroupCleanupForOwnedTabs(key, session);
    if (nextDeadlineAt === null) armTabGroupCleanup(key, session, Date.now());
    await persistTabGroupSession(key, session);
  });
}

async function resolveTabGroupTab(
  tabId: number | undefined,
  workspace: string,
  cmd: Command,
  initialUrl?: string,
): Promise<ResolvedTab> {
  const key = getTabGroupSessionKey(getGroupTitle(cmd));
  const session = await getTabGroupSession(cmd);

  if (tabId !== undefined) {
    const owner = session.tabWorkspaceOwners.get(tabId);
    if (owner !== workspace) {
      if (owner !== undefined) {
        throw new Error(`strict-background-tab-not-owned: Tab ${tabId} belongs to workspace ${owner}`);
      }
      throw new Error(`strict-background-stale-tab: Tab ${tabId} is not owned by workspace ${workspace}`);
    }

    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      await pruneStaleTabGroupTab(key, session, tabId);
      throw new Error(`strict-background-stale-tab: Tab ${tabId} no longer exists`);
    }
    if (tab.groupId !== session.groupId) {
      await pruneStaleTabGroupTab(key, session, tabId);
      throw new Error(`strict-background-stale-tab: Tab ${tabId} is no longer in group ${session.title}`);
    }
    if (!session.ownedTabIds.has(tabId)) {
      await pruneStaleTabGroupTab(key, session, tabId);
      throw new Error(`strict-background-stale-tab: Tab ${tabId} is no longer owned by AutoCLI`);
    }
    if (!isDebuggableUrl(tab.url)) {
      throw new Error(`Tab ${tabId} URL is not debuggable (${tab.url})`);
    }
    return { tabId, tab };
  }

  const boundTabId = session.workspaceTabIds.get(workspace);
  if (boundTabId !== undefined) {
    try {
      const boundTab = await chrome.tabs.get(boundTabId);
      if (
        boundTab.groupId === session.groupId
        && session.ownedTabIds.has(boundTabId)
        && session.tabWorkspaceOwners.get(boundTabId) === workspace
        && isDebuggableUrl(boundTab.url)
      ) {
        return { tabId: boundTabId, tab: boundTab };
      }
      if (boundTab.groupId !== session.groupId) {
        await pruneStaleTabGroupTab(key, session, boundTabId);
      } else {
        await clearWorkspaceTabBinding(key, session, workspace, boundTabId);
      }
    } catch {
      // The tab can disappear after reconciliation but before this lookup.
      // Prune the whole ownership record so the current command can recreate
      // the workspace's background tab instead of surfacing a stale-ID error.
      await pruneStaleTabGroupTab(key, session, boundTabId);
    }
  }

  // Never pick an arbitrary owned tab from a shared group. A different logical
  // caller may own it, so an unbound workspace always gets a fresh background tab.
  const startUrl = initialUrl && isSafeNavigationUrl(initialUrl) ? initialUrl : BLANK_PAGE;
  const tab = await chrome.tabs.create({ windowId: session.windowId, url: startUrl, active: false });
  if (!tab.id) throw new Error('Failed to create strict-background tab');
  try {
    await chrome.tabs.group({ groupId: session.groupId, tabIds: [tab.id] });
  } catch (error) {
    try {
      await chrome.tabs.remove(tab.id);
    } catch {
      // This tab was not registered, so it has no durable ownership proof for
      // a cross-restart retry alarm.
    }
    throw error;
  }
  await registerNewOwnedTab(key, session, tab.id, cmd, workspace);
  return { tabId: tab.id, tab };
}

/**
 * Resolve target tab in the automation window, returning both the tabId and
 * the Tab object (when available) so callers can skip a redundant chrome.tabs.get().
 */
async function resolveTab(tabId: number | undefined, workspace: string, initialUrl?: string, cmd?: Command): Promise<ResolvedTab> {
  if (cmd && isTabGroupCarrier(cmd)) {
    return resolveTabGroupTab(tabId, workspace, cmd, initialUrl);
  }

  // Even when an explicit tabId is provided, validate it is still debuggable.
  if (tabId !== undefined) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const session = automationSessions.get(workspace);
      const matchesSession = session ? tab.windowId === session.windowId : false;
      if (isDebuggableUrl(tab.url) && matchesSession) return { tabId, tab };
      if (session && !matchesSession && isDebuggableUrl(tab.url)) {
        // Tab drifted to another window but content is still valid.
        // Try to move it back instead of abandoning it.
        console.warn(`[autocli] Tab ${tabId} drifted to window ${tab.windowId}, moving back to ${session.windowId}`);
        try {
          await chrome.tabs.move(tabId, { windowId: session.windowId, index: -1 });
          const moved = await chrome.tabs.get(tabId);
          if (moved.windowId === session.windowId && isDebuggableUrl(moved.url)) {
            return { tabId, tab: moved };
          }
        } catch (moveErr) {
          console.warn(`[autocli] Failed to move tab back: ${moveErr}`);
        }
      } else if (!isDebuggableUrl(tab.url)) {
        console.warn(`[autocli] Tab ${tabId} URL is not debuggable (${tab.url}), re-resolving`);
      }
    } catch {
      console.warn(`[autocli] Tab ${tabId} no longer exists, re-resolving`);
    }
  }

  // Get (or create) the automation window
  const windowId = await getAutomationWindow(workspace, initialUrl);

  // Prefer an existing debuggable tab
  const tabs = await chrome.tabs.query({ windowId });
  const debuggableTab = tabs.find(t => t.id && isDebuggableUrl(t.url));
  if (debuggableTab?.id) return { tabId: debuggableTab.id, tab: debuggableTab };

  // No debuggable tab — another extension may have hijacked the tab URL.
  const reuseTab = tabs.find(t => t.id);
  if (reuseTab?.id) {
    await chrome.tabs.update(reuseTab.id, { url: BLANK_PAGE });
    await new Promise(resolve => setTimeout(resolve, 300));
    try {
      const updated = await chrome.tabs.get(reuseTab.id);
      if (isDebuggableUrl(updated.url)) return { tabId: reuseTab.id, tab: updated };
      console.warn(`[autocli] data: URI was intercepted (${updated.url}), creating fresh tab`);
    } catch {
      // Tab was closed during navigation
    }
  }

  // Fallback: create a new tab
  const newTab = await chrome.tabs.create({ windowId, url: BLANK_PAGE, active: true });
  if (!newTab.id) throw new Error('Failed to create tab in automation window');
  return { tabId: newTab.id, tab: newTab };
}

/** Convenience wrapper returning just the tabId (used by most handlers) */
async function resolveTabId(tabId: number | undefined, workspace: string, initialUrl?: string, cmd?: Command): Promise<number> {
  const resolved = await resolveTab(tabId, workspace, initialUrl, cmd);
  return resolved.tabId;
}

async function listAutomationTabs(workspace: string): Promise<chrome.tabs.Tab[]> {
  const session = automationSessions.get(workspace);
  if (!session) return [];
  try {
    return await chrome.tabs.query({ windowId: session.windowId });
  } catch {
    automationSessions.delete(workspace);
    return [];
  }
}

async function listAutomationWebTabs(workspace: string): Promise<chrome.tabs.Tab[]> {
  const tabs = await listAutomationTabs(workspace);
  return tabs.filter((tab) => isDebuggableUrl(tab.url));
}

async function listTabGroupWebTabs(cmd: Command, workspace: string): Promise<chrome.tabs.Tab[]> {
  const key = getTabGroupSessionKey(getGroupTitle(cmd));
  const session = await getExistingTabGroupSession(key);
  if (!session) return [];
  const tabs = await chrome.tabs.query({ groupId: session.groupId });
  return tabs.filter((tab) =>
    tab.id !== undefined
      && session.ownedTabIds.has(tab.id)
      && session.tabWorkspaceOwners.get(tab.id) === workspace
      && isDebuggableUrl(tab.url)
  );
}

async function assertOwnedTabForClose(cmd: Command, workspace: string, tabId: number): Promise<void> {
  const title = getGroupTitle(cmd);
  const key = getTabGroupSessionKey(title);
  const session = await getExistingTabGroupSession(key);
  if (!session || !session.ownedTabIds.has(tabId) || session.tabWorkspaceOwners.get(tabId) !== workspace) {
    throw new Error(`strict-background-tab-not-owned: Tab ${tabId} is not owned by workspace ${workspace}`);
  }
  const groups = await findUniqueTabGroupsByTitle(title);
  const tab = await chrome.tabs.get(tabId);
  if (tabGroupSessions.get(key) !== session || !session.ownedTabIds.has(tabId)
      || session.tabWorkspaceOwners.get(tabId) !== workspace
      || groups.length !== 1 || groups[0].id !== session.groupId || tab.groupId !== session.groupId) {
    throw new Error(`strict-background-stale-tab: Tab ${tabId} is no longer in group ${title}`);
  }
}

async function removeOwnedTab(cmd: Command, workspace: string, tabId: number): Promise<void> {
  if (!isTabGroupCarrier(cmd)) return;
  const title = getGroupTitle(cmd);
  const key = getTabGroupSessionKey(title);
  await enqueueTabGroupSessionMutation(key, async () => {
    const session = tabGroupSessions.get(key);
    if (!session) return;
    if (session.tabWorkspaceOwners.get(tabId) !== workspace) return;
    const removed = session.ownedTabIds.delete(tabId);
    const removedMetadata = removeTabGroupTabMetadata(session, tabId);
    if (!removed && !removedMetadata) return;
    const nextDeadlineAt = armTabGroupCleanupForOwnedTabs(key, session);
    if (nextDeadlineAt === null) armTabGroupCleanup(key, session, Date.now());
    await persistTabGroupSession(key, session);
  });
}

async function handleExec(cmd: Command, workspace: string): Promise<Result> {
  if (!cmd.code) return { id: cmd.id, ok: false, error: 'Missing code' };
  const tabId = await resolveTabId(cmd.tabId, workspace, undefined, cmd);
  try {
    const aggressive = workspace.startsWith('operate:');
    const data = await executor.evaluateAsync(tabId, cmd.code, aggressive);
    await touchTabGroupTab(cmd, workspace, tabId);
    return { id: cmd.id, ok: true, data };
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleNavigate(cmd: Command, workspace: string): Promise<Result> {
  if (!cmd.url) return { id: cmd.id, ok: false, error: 'Missing url' };
  if (!isSafeNavigationUrl(cmd.url)) {
    return { id: cmd.id, ok: false, error: 'Blocked URL scheme -- only http:// and https:// are allowed' };
  }
  // Pass target URL so that first-time window creation can start on the right domain
  const resolved = await resolveTab(cmd.tabId, workspace, cmd.url, cmd);
  const tabId = resolved.tabId;

  const beforeTab = resolved.tab ?? await chrome.tabs.get(tabId);
  const beforeNormalized = normalizeUrlForComparison(beforeTab.url);
  const targetUrl = cmd.url;

  // Fast-path: tab is already at the target URL and fully loaded.
  if (beforeTab.status === 'complete' && isTargetUrl(beforeTab.url, targetUrl)) {
    await touchTabGroupTab(cmd, workspace, tabId);
    return {
      id: cmd.id,
      ok: true,
      data: { title: beforeTab.title, url: beforeTab.url, tabId, timedOut: false },
    };
  }

  // Detach any existing debugger before top-level navigation.
  // Some sites (observed on creator.xiaohongshu.com flows) can invalidate the
  // current inspected target during navigation, which leaves a stale CDP attach
  // state and causes the next Runtime.evaluate to fail with
  // "Inspected target navigated or closed". Resetting here forces a clean
  // re-attach after navigation.
  await executor.detach(tabId);

  await chrome.tabs.update(tabId, { url: targetUrl });

  // Wait until navigation completes. Resolve when status is 'complete' AND either:
  // - the URL matches the target (handles same-URL / canonicalized navigations), OR
  // - the URL differs from the pre-navigation URL (handles redirects).
  let timedOut = false;
  await new Promise<void>((resolve) => {
    let settled = false;
    let checkTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      if (checkTimer) clearTimeout(checkTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve();
    };

    const isNavigationDone = (url: string | undefined): boolean => {
      return isTargetUrl(url, targetUrl) || normalizeUrlForComparison(url) !== beforeNormalized;
    };

    const listener = (id: number, info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (id !== tabId) return;
      if (info.status === 'complete' && isNavigationDone(tab.url ?? info.url)) {
        finish();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);

    // Also check if the tab already navigated (e.g. instant cache hit)
    checkTimer = setTimeout(async () => {
      try {
        const currentTab = await chrome.tabs.get(tabId);
        if (currentTab.status === 'complete' && isNavigationDone(currentTab.url)) {
          finish();
        }
      } catch { /* tab gone */ }
    }, 100);

    // Timeout fallback with warning
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      console.warn(`[autocli] Navigate to ${targetUrl} timed out after 15s`);
      finish();
    }, 15000);
  });

  let tab = await chrome.tabs.get(tabId);

  // Post-navigation drift detection: if the tab moved to another window
  // during navigation (e.g. a tab-management extension regrouped it),
  // try to move it back to maintain session isolation.
  const session = automationSessions.get(workspace);
  if (!isTabGroupCarrier(cmd) && session && tab.windowId !== session.windowId) {
    console.warn(`[autocli] Tab ${tabId} drifted to window ${tab.windowId} during navigation, moving back to ${session.windowId}`);
    try {
      await chrome.tabs.move(tabId, { windowId: session.windowId, index: -1 });
      tab = await chrome.tabs.get(tabId);
    } catch (moveErr) {
      console.warn(`[autocli] Failed to recover drifted tab: ${moveErr}`);
    }
  }

  await touchTabGroupTab(cmd, workspace, tabId);

  return {
    id: cmd.id,
    ok: true,
    data: { title: tab.title, url: tab.url, tabId, timedOut },
  };
}

async function handleTabs(cmd: Command, workspace: string): Promise<Result> {
  switch (cmd.op) {
    case 'list': {
      const tabs = isTabGroupCarrier(cmd)
        ? await listTabGroupWebTabs(cmd, workspace)
        : await listAutomationWebTabs(workspace);
      const data = tabs
        .map((t, i) => ({
          index: i,
          tabId: t.id,
          url: t.url,
          title: t.title,
          active: t.active,
        }));
      return { id: cmd.id, ok: true, data };
    }
    case 'new': {
      if (cmd.url && !isSafeNavigationUrl(cmd.url)) {
        return { id: cmd.id, ok: false, error: 'Blocked URL scheme -- only http:// and https:// are allowed' };
      }
      if (isTabGroupCarrier(cmd)) {
        const session = await getTabGroupSession(cmd);
        const key = getTabGroupSessionKey(getGroupTitle(cmd));
        const tab = await chrome.tabs.create({ windowId: session.windowId, url: cmd.url ?? BLANK_PAGE, active: false });
        if (!tab.id) return { id: cmd.id, ok: false, error: 'Failed to create strict-background tab' };
        try {
          await chrome.tabs.group({ groupId: session.groupId, tabIds: [tab.id] });
        } catch (error) {
          try {
            await chrome.tabs.remove(tab.id);
          } catch {
            // This tab was not registered, so it cannot be retried safely
            // after an extension restart.
          }
          throw error;
        }
        await registerNewOwnedTab(key, session, tab.id, cmd, workspace);
        return { id: cmd.id, ok: true, data: { tabId: tab.id, url: tab.url } };
      }
      const windowId = await getAutomationWindow(workspace);
      const tab = await chrome.tabs.create({ windowId, url: cmd.url ?? BLANK_PAGE, active: true });
      return { id: cmd.id, ok: true, data: { tabId: tab.id, url: tab.url } };
    }
    case 'close': {
      if (cmd.index !== undefined) {
        const tabs = isTabGroupCarrier(cmd)
          ? await listTabGroupWebTabs(cmd, workspace)
          : await listAutomationWebTabs(workspace);
        const target = tabs[cmd.index];
        if (!target?.id) return { id: cmd.id, ok: false, error: `Tab index ${cmd.index} not found` };
        if (isTabGroupCarrier(cmd)) await assertOwnedTabForClose(cmd, workspace, target.id);
        await chrome.tabs.remove(target.id);
        await executor.detach(target.id);
        await removeOwnedTab(cmd, workspace, target.id);
        return { id: cmd.id, ok: true, data: { closed: target.id } };
      }
      if (isTabGroupCarrier(cmd) && cmd.tabId === undefined) {
        const boundTabId = (await getExistingTabGroupSession(getTabGroupSessionKey(getGroupTitle(cmd))))
          ?.workspaceTabIds.get(workspace);
        if (boundTabId === undefined) {
          return { id: cmd.id, ok: false, error: `No strict-background tab is bound to workspace ${workspace}` };
        }
        cmd = { ...cmd, tabId: boundTabId };
      }
      const tabId = await resolveTabId(cmd.tabId, workspace, undefined, cmd);
      if (isTabGroupCarrier(cmd)) await assertOwnedTabForClose(cmd, workspace, tabId);
      await chrome.tabs.remove(tabId);
      await executor.detach(tabId);
      await removeOwnedTab(cmd, workspace, tabId);
      return { id: cmd.id, ok: true, data: { closed: tabId } };
    }
    case 'select': {
      if (isTabGroupCarrier(cmd)) {
        return { id: cmd.id, ok: false, error: 'unsupported-operation: tabs select is disabled in strict-background mode' };
      }
      if (cmd.index === undefined && cmd.tabId === undefined)
        return { id: cmd.id, ok: false, error: 'Missing index or tabId' };
      if (cmd.tabId !== undefined) {
        const session = automationSessions.get(workspace);
        let tab: chrome.tabs.Tab;
        try {
          tab = await chrome.tabs.get(cmd.tabId);
        } catch {
          return { id: cmd.id, ok: false, error: `Tab ${cmd.tabId} no longer exists` };
        }
        if (!session || tab.windowId !== session.windowId) {
          return { id: cmd.id, ok: false, error: `Tab ${cmd.tabId} is not in the automation window` };
        }
        await chrome.tabs.update(cmd.tabId, { active: true });
        return { id: cmd.id, ok: true, data: { selected: cmd.tabId } };
      }
      const tabs = await listAutomationWebTabs(workspace);
      const target = tabs[cmd.index!];
      if (!target?.id) return { id: cmd.id, ok: false, error: `Tab index ${cmd.index} not found` };
      await chrome.tabs.update(target.id, { active: true });
      return { id: cmd.id, ok: true, data: { selected: target.id } };
    }
    default:
      return { id: cmd.id, ok: false, error: `Unknown tabs op: ${cmd.op}` };
  }
}

async function handleCookies(cmd: Command): Promise<Result> {
  if (!cmd.domain && !cmd.url) {
    return { id: cmd.id, ok: false, error: 'Cookie scope required: provide domain or url to avoid dumping all cookies' };
  }
  const details: chrome.cookies.GetAllDetails = {};
  if (cmd.domain) details.domain = cmd.domain;
  if (cmd.url) details.url = cmd.url;
  const cookies = await chrome.cookies.getAll(details);
  const data = cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    expirationDate: c.expirationDate,
  }));
  return { id: cmd.id, ok: true, data };
}

async function handleScreenshot(cmd: Command, workspace: string): Promise<Result> {
  const tabId = await resolveTabId(cmd.tabId, workspace, undefined, cmd);
  try {
    const data = await executor.screenshot(tabId, {
      format: cmd.format,
      quality: cmd.quality,
      fullPage: cmd.fullPage,
    });
    await touchTabGroupTab(cmd, workspace, tabId);
    return { id: cmd.id, ok: true, data };
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** CDP methods permitted via the 'cdp' passthrough action. */
const CDP_ALLOWLIST = new Set([
  // Agent DOM context
  'Accessibility.getFullAXTree',
  'DOM.getDocument',
  'DOM.getBoxModel',
  'DOM.getContentQuads',
  'DOM.querySelectorAll',
  'DOM.scrollIntoViewIfNeeded',
  'DOMSnapshot.captureSnapshot',
  // Native input events
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
  // Page metrics & screenshots
  'Page.getLayoutMetrics',
  'Page.captureScreenshot',
  // Runtime.enable needed for CDP attach setup (Runtime.evaluate goes through 'exec' action)
  'Runtime.enable',
  // Emulation (used by screenshot full-page)
  'Emulation.setDeviceMetricsOverride',
  'Emulation.clearDeviceMetricsOverride',
]);

async function handleCdp(cmd: Command, workspace: string): Promise<Result> {
  if (!cmd.cdpMethod) return { id: cmd.id, ok: false, error: 'Missing cdpMethod' };
  if (!CDP_ALLOWLIST.has(cmd.cdpMethod)) {
    return { id: cmd.id, ok: false, error: `CDP method not permitted: ${cmd.cdpMethod}` };
  }
  const tabId = await resolveTabId(cmd.tabId, workspace, undefined, cmd);
  try {
    const aggressive = workspace.startsWith('operate:');
    await executor.ensureAttached(tabId, aggressive);
    const data = await chrome.debugger.sendCommand(
      { tabId },
      cmd.cdpMethod,
      cmd.cdpParams ?? {},
    );
    await touchTabGroupTab(cmd, workspace, tabId);
    return { id: cmd.id, ok: true, data };
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleCloseWindow(cmd: Command, workspace: string): Promise<Result> {
  if (isTabGroupCarrier(cmd)) {
    validateStrictBackgroundCommand(cmd);
    await touchWorkspaceTabOnStrictBackgroundRelease(cmd, workspace);
    return { id: cmd.id, ok: true, data: { released: true } };
  }
  const session = automationSessions.get(workspace);
  if (session) {
    try {
      await chrome.windows.remove(session.windowId);
    } catch {
      // Window may already be closed
    }
    if (session.idleTimer) clearTimeout(session.idleTimer);
    automationSessions.delete(workspace);
  }
  return { id: cmd.id, ok: true, data: { closed: true } };
}

async function handleSetFileInput(cmd: Command, workspace: string): Promise<Result> {
  if (!cmd.files || !Array.isArray(cmd.files) || cmd.files.length === 0) {
    return { id: cmd.id, ok: false, error: 'Missing or empty files array' };
  }
  const tabId = await resolveTabId(cmd.tabId, workspace, undefined, cmd);
  try {
    await executor.setFileInputFiles(tabId, cmd.files, cmd.selector);
    await touchTabGroupTab(cmd, workspace, tabId);
    return { id: cmd.id, ok: true, data: { count: cmd.files.length } };
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleReadArticle(cmd: Command, workspace: string): Promise<Result> {
  if (!cmd.url) return { id: cmd.id, ok: false, error: 'Missing url' };

  // Step 1: navigate (reuses existing handler: creates window, resolves tab, waits for load).
  const navResult = await handleNavigate(cmd, workspace);
  if (!navResult.ok) return { id: cmd.id, ok: false, error: navResult.error };
  const navData = navResult.data as { tabId: number; url?: string; title?: string } | undefined;
  if (!navData?.tabId) return { id: cmd.id, ok: false, error: 'Navigate returned no tabId' };
  const tabId = navData.tabId;

  // Step 2: wait for DOM to settle so SPAs have rendered before extraction.
  try {
    await executor.evaluateAsync(tabId, `
      new Promise(resolve => {
        if (!document.body) { setTimeout(() => resolve('nobody'), 3000); return; }
        let timer = null, cap = null;
        const done = (r) => { clearTimeout(timer); clearTimeout(cap); obs.disconnect(); resolve(r); };
        const reset = () => { clearTimeout(timer); timer = setTimeout(() => done('quiet'), 500); };
        const obs = new MutationObserver(reset);
        obs.observe(document.body, { childList: true, subtree: true, attributes: true });
        reset();
        cap = setTimeout(() => done('capped'), 3000);
      })
    `);
  } catch {
    // DOM-stability is best-effort; extraction below is the real gate.
  }

  // Step 3: inject the vendored Readability library into the page's isolated world.
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['reader/Readability.js'],
    });
  } catch (err) {
    return { id: cmd.id, ok: false, error: `Failed to inject Readability: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Step 4: run the extractor. Readability is now on globalThis in the isolated world.
  let injectionResults: chrome.scripting.InjectionResult<unknown>[];
  try {
    injectionResults = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const R = (globalThis as unknown as { Readability?: new (doc: Document) => { parse(): unknown } }).Readability;
        if (!R) return { __err: 'Readability not loaded in page context' };
        // Clone so Readability's destructive parse does not mutate the live DOM.
        const docClone = document.cloneNode(true) as Document;
        const article = new R(docClone).parse() as null | {
          title: string;
          byline: string | null;
          dir: string | null;
          lang: string | null;
          content: string;
          textContent: string;
          length: number;
          excerpt: string;
          siteName: string | null;
          publishedTime: string | null;
        };
        if (!article) return { __err: 'Readability could not extract an article from this page' };
        return {
          title: article.title,
          byline: article.byline,
          dir: article.dir,
          lang: article.lang,
          content: article.content,
          textContent: article.textContent,
          length: article.length,
          excerpt: article.excerpt,
          siteName: article.siteName,
          publishedTime: article.publishedTime,
          url: document.location.href,
        };
      },
    });
  } catch (err) {
    return { id: cmd.id, ok: false, error: `Failed to run extractor: ${err instanceof Error ? err.message : String(err)}` };
  }

  const payload = injectionResults[0]?.result as Record<string, unknown> | undefined;
  if (!payload) return { id: cmd.id, ok: false, error: 'Extractor returned no result' };
  if (typeof payload.__err === 'string') return { id: cmd.id, ok: false, error: payload.__err };

  await touchTabGroupTab(cmd, workspace, tabId);
  return { id: cmd.id, ok: true, data: payload };
}

async function handleSessions(cmd: Command): Promise<Result> {
  const now = Date.now();
  const data = await Promise.all([...automationSessions.entries()].map(async ([workspace, session]) => ({
    workspace,
    windowId: session.windowId,
    tabCount: (await chrome.tabs.query({ windowId: session.windowId })).filter((tab) => isDebuggableUrl(tab.url)).length,
    idleMsRemaining: Math.max(0, session.idleDeadlineAt - now),
  })));
  return { id: cmd.id, ok: true, data };
}

export const __test__ = {
  handleNavigate,
  handleCommand,
  isTargetUrl,
  handleTabs,
  handleCloseWindow,
  handleSessions,
  resolveTabId,
  resetWindowIdleTimer,
  getSession: (workspace: string = 'default') => automationSessions.get(workspace) ?? null,
  getAutomationWindowId: (workspace: string = 'default') => automationSessions.get(workspace)?.windowId ?? null,
  setAutomationWindowId: (workspace: string, windowId: number | null) => {
    if (windowId === null) {
      const session = automationSessions.get(workspace);
      if (session?.idleTimer) clearTimeout(session.idleTimer);
      automationSessions.delete(workspace);
      return;
    }
    setWorkspaceSession(workspace, {
      windowId,
    });
  },
  setSession: (workspace: string, session: { windowId: number }) => {
    setWorkspaceSession(workspace, session);
  },
};

// ─── Daemon proxy: relay localhost requests from content scripts ──
const DAEMON_PORT = 19925;
const DAEMON_BASE = `http://localhost:${DAEMON_PORT}`;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'daemon-fetch') {
    const { path, method, body } = msg;
    const url = `${DAEMON_BASE}${path}`;
    const opts: RequestInit = {
      method: method || 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    };

    fetch(url, opts)
      .then(async (resp) => {
        const text = await resp.text();
        sendResponse({ ok: resp.ok, status: resp.status, body: text });
      })
      .catch((e) => {
        sendResponse({ ok: false, status: 0, body: '', error: e.message });
      });

    return true; // async response
  }

  if (msg?.type === 'daemon-stream') {
    const { path, body } = msg;
    const url = `${DAEMON_BASE}${path}`;

    // For streaming, we can't use sendResponse (one-shot).
    // Instead, use a port-based approach via chrome.runtime.connect.
    // But since content scripts initiate this, we handle it differently —
    // content.js will use the port approach directly.
    sendResponse({ error: 'Use daemon-stream-port instead' });
    return false;
  }

  if (msg?.type === 'getStatus') {
    // Move existing getStatus handler here (already handled above)
  }

  return false;
});

// Port-based streaming for AI generate — uses existing daemon WebSocket
const aiStreamPorts = new Map<string, chrome.runtime.Port>();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'daemon-stream') return;

  const streamId = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  aiStreamPorts.set(streamId, port);

  port.onMessage.addListener(async (msg) => {
    // If WS not connected, try reconnecting once before giving up
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      await connect();
      // Wait briefly for connection to establish
      await new Promise(r => setTimeout(r, 1000));
    }

    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'ai-generate',
        streamId,
        ...msg,
      }));
    } else {
      port.postMessage({ type: 'error', status: 0, body: 'Daemon not connected. Run: autocli' });
      try { port.disconnect(); } catch {}
      aiStreamPorts.delete(streamId);
    }
  });

  port.onDisconnect.addListener(() => {
    aiStreamPorts.delete(streamId);
  });
});

// ─── Selector Tool: inject on extension icon click ──────────────
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    // Check if already injected — if so, just toggle
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => !!(window as SelectorWindow).__autocliSelectorActive,
    });
    if (result?.result) {
      // Already injected, re-run content.js to toggle
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['selector/content.js'] });
    } else {
      // First time: inject engine + dom-clean + content
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['selector/engine.js'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['selector/dom-clean.js'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['selector/content.js'] });
    }
  } catch (e) {
    console.error('[autocli] Selector inject failed:', e);
  }
});
