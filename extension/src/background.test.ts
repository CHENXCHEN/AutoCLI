// Based on OpenCLI (https://github.com/jackwener/opencli) by jackwener
// Licensed under Apache-2.0. Modified for AutoCLI.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Listener<T extends (...args: any[]) => void> = { addListener: (fn: T) => void };

type MockTab = {
  id: number;
  windowId: number;
  groupId?: number;
  url?: string;
  title?: string;
  active?: boolean;
  status?: string;
};

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(_url: string) {}
  send(_data: string): void {}
  close(): void {
    this.onclose?.();
  }
}

function createChromeMock() {
  let nextTabId = 10;
  let nextGroupId = 100;
  const groups: Array<{ id: number; title?: string; windowId: number; collapsed?: boolean; color?: string }> = [];
  const tabs: MockTab[] = [
    { id: 1, windowId: 1, url: 'https://automation.example', title: 'automation', active: true, status: 'complete' },
    { id: 2, windowId: 2, url: 'https://user.example', title: 'user', active: true, status: 'complete' },
    { id: 3, windowId: 1, url: 'chrome://extensions', title: 'chrome', active: false, status: 'complete' },
  ];

  const query = vi.fn(async (queryInfo: { windowId?: number; groupId?: number } = {}) => {
    return tabs.filter((tab) =>
      (queryInfo.windowId === undefined || tab.windowId === queryInfo.windowId) &&
      (queryInfo.groupId === undefined || tab.groupId === queryInfo.groupId)
    );
  });
  const create = vi.fn(async ({ windowId, url, active }: { windowId?: number; url?: string; active?: boolean }) => {
    const tab: MockTab = {
      id: nextTabId++,
      windowId: windowId ?? 999,
      url,
      title: url ?? 'blank',
      active: !!active,
      status: 'complete',
    };
    tabs.push(tab);
    return tab;
  });
  const group = vi.fn(async ({ groupId, tabIds }: { groupId?: number; tabIds: number[] }) => {
    const first = tabs.find((entry) => entry.id === tabIds[0]);
    if (!first) throw new Error('Cannot group unknown tab');
    const resolvedGroupId = groupId ?? nextGroupId++;
    if (groupId === undefined) groups.push({ id: resolvedGroupId, windowId: first.windowId });
    for (const tabId of tabIds) {
      const tab = tabs.find((entry) => entry.id === tabId);
      if (tab) tab.groupId = resolvedGroupId;
    }
    return resolvedGroupId;
  });
  const update = vi.fn(async (tabId: number, updates: { active?: boolean; url?: string }) => {
    const tab = tabs.find((entry) => entry.id === tabId);
    if (!tab) throw new Error(`Unknown tab ${tabId}`);
    if (updates.active !== undefined) tab.active = updates.active;
    if (updates.url !== undefined) tab.url = updates.url;
    return tab;
  });

  const chrome = {
    tabs: {
      query,
      create,
      group,
      update,
      remove: vi.fn(async (tabIdOrIds: number | number[]) => {
        const ids = Array.isArray(tabIdOrIds) ? tabIdOrIds : [tabIdOrIds];
        for (const tabId of ids) {
          const index = tabs.findIndex((entry) => entry.id === tabId);
          if (index >= 0) tabs.splice(index, 1);
        }
      }),
      get: vi.fn(async (tabId: number) => {
        const tab = tabs.find((entry) => entry.id === tabId);
        if (!tab) throw new Error(`Unknown tab ${tabId}`);
        return tab;
      }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() } as Listener<(id: number, info: chrome.tabs.TabChangeInfo) => void>,
    },
    windows: {
      get: vi.fn(async (windowId: number) => ({ id: windowId })),
      create: vi.fn(async ({ url, focused, width, height, type }: any) => ({ id: 1, url, focused, width, height, type })),
      getLastFocused: vi.fn(async () => ({ id: 2, type: 'normal' })),
      getAll: vi.fn(async () => [{ id: 2, type: 'normal' }]),
      remove: vi.fn(async (_windowId: number) => {}),
      onRemoved: { addListener: vi.fn() } as Listener<(windowId: number) => void>,
    },
    tabGroups: {
      get: vi.fn(async (groupId: number) => {
        const groupEntry = groups.find((entry) => entry.id === groupId);
        if (!groupEntry) throw new Error(`Unknown group ${groupId}`);
        return groupEntry;
      }),
      query: vi.fn(async ({ title }: { title?: string } = {}) =>
        groups.filter((entry) => title === undefined || entry.title === title)
      ),
      update: vi.fn(async (groupId: number, updates: { title?: string; collapsed?: boolean; color?: string }) => {
        const groupEntry = groups.find((entry) => entry.id === groupId);
        if (!groupEntry) throw new Error(`Unknown group ${groupId}`);
        Object.assign(groupEntry, updates);
        return groupEntry;
      }),
    },
    alarms: {
      create: vi.fn(),
      onAlarm: { addListener: vi.fn() } as Listener<(alarm: { name: string }) => void>,
    },
    runtime: {
      onInstalled: { addListener: vi.fn() } as Listener<() => void>,
      onStartup: { addListener: vi.fn() } as Listener<() => void>,
      onMessage: { addListener: vi.fn() } as Listener<(msg: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => void>,
      onConnect: { addListener: vi.fn() } as Listener<(port: chrome.runtime.Port) => void>,
      getManifest: vi.fn(() => ({ version: '1.5.6' })),
    },
    action: {
      onClicked: { addListener: vi.fn() } as Listener<(tab: chrome.tabs.Tab) => void>,
    },
    scripting: {
      executeScript: vi.fn(),
    },
    cookies: {
      getAll: vi.fn(async () => []),
    },
  };

  return { chrome, tabs, groups, query, create, group, update };
}

describe('background tab isolation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  it('lists only automation-window web tabs', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    mod.__test__.setAutomationWindowId('site:twitter', 1);

    const result = await mod.__test__.handleTabs({ id: '1', action: 'tabs', op: 'list', workspace: 'site:twitter' }, 'site:twitter');

    expect(result.ok).toBe(true);
    expect(result.data).toEqual([
      {
        index: 0,
        tabId: 1,
        url: 'https://automation.example',
        title: 'automation',
        active: true,
      },
    ]);
  });

  it('creates new tabs inside the automation window', async () => {
    const { chrome, create } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    mod.__test__.setAutomationWindowId('site:twitter', 1);

    const result = await mod.__test__.handleTabs({ id: '2', action: 'tabs', op: 'new', url: 'https://new.example', workspace: 'site:twitter' }, 'site:twitter');

    expect(result.ok).toBe(true);
    expect(create).toHaveBeenCalledWith({ windowId: 1, url: 'https://new.example', active: true });
  });

  it('reports sessions per workspace', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    mod.__test__.setAutomationWindowId('site:twitter', 1);
    mod.__test__.setAutomationWindowId('site:zhihu', 2);

    const result = await mod.__test__.handleSessions({ id: '3', action: 'sessions' });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ workspace: 'site:twitter', windowId: 1 }),
      expect.objectContaining({ workspace: 'site:zhihu', windowId: 2 }),
    ]));
  });

  it('creates strict-background tab group tabs without activating tabs or creating windows', async () => {
    const { chrome, create, group } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');

    const result = await mod.__test__.handleTabs({
      id: '4',
      action: 'tabs',
      op: 'new',
      url: 'https://new.example',
      workspace: 'site:twitter',
      carrier: 'tab-group-background',
      groupName: 'work',
    }, 'site:twitter');

    expect(result.ok).toBe(true);
    expect(chrome.windows.create).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith({ windowId: 2, url: 'about:blank', active: false });
    expect(create).toHaveBeenCalledWith({ windowId: 2, url: 'https://new.example', active: false });
    expect(group).toHaveBeenCalled();
    expect(chrome.tabGroups.update).toHaveBeenCalledWith(expect.any(Number), expect.objectContaining({
      title: 'AutoCLI-work',
      collapsed: true,
    }));
  });

  it('rejects strict-background tab selection without activating any tab', async () => {
    const { chrome, update } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    const result = await mod.__test__.handleTabs({
      id: '5',
      action: 'tabs',
      op: 'select',
      tabId: 2,
      workspace: 'site:twitter',
      carrier: 'tab-group-background',
      groupName: 'work',
    }, 'site:twitter');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('unsupported');
    expect(update).not.toHaveBeenCalledWith(expect.any(Number), expect.objectContaining({ active: true }));
  });

  it('does not navigate or list user tabs already present in a reused strict-background group', async () => {
    const { chrome, tabs, groups, create, update } = createChromeMock();
    groups.push({ id: 123, title: 'AutoCLI-work', windowId: 2, collapsed: true, color: 'blue' });
    tabs.push({
      id: 9,
      windowId: 2,
      groupId: 123,
      url: 'https://user-in-group.example',
      title: 'user group tab',
      active: true,
      status: 'complete',
    });
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    const navigate = await mod.__test__.handleNavigate({
      id: '8',
      action: 'navigate',
      url: 'https://new.example',
      workspace: 'site:twitter',
      carrier: 'tab-group-background',
      groupName: 'work',
    }, 'site:twitter');
    const list = await mod.__test__.handleTabs({
      id: '9',
      action: 'tabs',
      op: 'list',
      workspace: 'site:twitter',
      carrier: 'tab-group-background',
      groupName: 'work',
    }, 'site:twitter');

    expect(navigate.ok).toBe(true);
    expect(tabs.find((tab) => tab.id === 9)?.url).toBe('https://user-in-group.example');
    expect(create).toHaveBeenCalledWith({ windowId: 2, url: 'https://new.example', active: false });
    expect(update).not.toHaveBeenCalledWith(9, expect.anything());
    const listedTabs = list.data as Array<{ tabId: number }>;
    expect(listedTabs).toHaveLength(1);
    expect(listedTabs[0].tabId).not.toBe(9);
  });

  it('returns a clear error for invalid strict-background idle timeout', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    await mod.__test__.handleTabs({
      id: '10',
      action: 'tabs',
      op: 'new',
      workspace: 'site:twitter',
      carrier: 'tab-group-background',
      groupName: 'work',
    }, 'site:twitter');

    const result = await mod.__test__.handleCommand({
      id: '11',
      action: 'tabs',
      op: 'list',
      workspace: 'site:twitter',
      carrier: 'tab-group-background',
      groupName: 'work',
      groupIdleTimeoutSeconds: -1,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('idle timeout');
  });

  it('rejects malformed strict-background close-window without an existing session', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    const missingGroup = await mod.__test__.handleCommand({
      id: '12',
      action: 'close-window',
      workspace: 'site:twitter',
      carrier: 'tab-group-background',
    });
    const invalidTimeout = await mod.__test__.handleCommand({
      id: '13',
      action: 'close-window',
      workspace: 'site:twitter',
      carrier: 'tab-group-background',
      groupName: 'work',
      groupIdleTimeoutSeconds: -1,
    });

    expect(missingGroup.ok).toBe(false);
    expect(missingGroup.error).toContain('group name');
    expect(invalidTimeout.ok).toBe(false);
    expect(invalidTimeout.error).toContain('idle timeout');
    expect(chrome.windows.remove).not.toHaveBeenCalled();
  });

  it('rejects unknown carriers instead of falling back to automation-window behavior', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    const result = await mod.__test__.handleCommand({
      id: '14',
      action: 'tabs',
      op: 'new',
      workspace: 'site:twitter',
      carrier: 'hidden-window',
    } as any);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unknown browser carrier');
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });

  it('releases strict-background sessions without removing the host window', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    await mod.__test__.handleTabs({
      id: '6',
      action: 'tabs',
      op: 'new',
      workspace: 'site:twitter',
      carrier: 'tab-group-background',
      groupName: 'work',
    }, 'site:twitter');

    const result = await mod.__test__.handleCloseWindow({
      id: '7',
      action: 'close-window',
      workspace: 'site:twitter',
      carrier: 'tab-group-background',
      groupName: 'work',
    }, 'site:twitter');

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ released: true });
    expect(chrome.windows.remove).not.toHaveBeenCalled();
  });

  it('shares one strict-background tab group for concurrent commands with the same workspace and group', async () => {
    vi.useFakeTimers();
    try {
      const { chrome, tabs, groups } = createChromeMock();
      vi.stubGlobal('chrome', chrome);

      const mod = await import('./background');
      const first = mod.__test__.handleTabs({
        id: '15',
        action: 'tabs',
        op: 'new',
        url: 'https://first.example',
        workspace: 'site:twitter',
        carrier: 'tab-group-background',
        groupName: 'work',
        groupIdleTimeoutSeconds: 1,
      }, 'site:twitter');
      const second = mod.__test__.handleTabs({
        id: '16',
        action: 'tabs',
        op: 'new',
        url: 'https://second.example',
        workspace: 'site:twitter',
        carrier: 'tab-group-background',
        groupName: 'work',
        groupIdleTimeoutSeconds: 1,
      }, 'site:twitter');

      const results = await Promise.all([first, second]);

      expect(results.every((result) => result.ok)).toBe(true);
      expect(chrome.windows.create).not.toHaveBeenCalled();
      const autocliGroups = groups.filter((group) => group.title === 'AutoCLI-work');
      expect(autocliGroups).toHaveLength(1);
      const groupTabs = tabs.filter((tab) => tab.groupId === autocliGroups[0].id);
      expect(groupTabs.map((tab) => tab.url).sort()).toEqual([
        'about:blank',
        'https://first.example',
        'https://second.example',
      ]);

      const release = await mod.__test__.handleCloseWindow({
        id: '17',
        action: 'close-window',
        workspace: 'site:twitter',
        carrier: 'tab-group-background',
        groupName: 'work',
        groupIdleTimeoutSeconds: 1,
      }, 'site:twitter');
      expect(release.ok).toBe(true);

      await vi.advanceTimersByTimeAsync(1000);

      expect(tabs.some((tab) => tab.groupId === autocliGroups[0].id)).toBe(false);
      expect(chrome.windows.remove).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps strict-background session locks scoped by group name', async () => {
    const { chrome, groups } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    const results = await Promise.all([
      mod.__test__.handleTabs({
        id: '18',
        action: 'tabs',
        op: 'new',
        url: 'https://work.example',
        workspace: 'site:twitter',
        carrier: 'tab-group-background',
        groupName: 'work',
      }, 'site:twitter'),
      mod.__test__.handleTabs({
        id: '19',
        action: 'tabs',
        op: 'new',
        url: 'https://dev.example',
        workspace: 'site:twitter',
        carrier: 'tab-group-background',
        groupName: 'dev',
      }, 'site:twitter'),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(groups.filter((group) => group.title === 'AutoCLI-work')).toHaveLength(1);
    expect(groups.filter((group) => group.title === 'AutoCLI-dev')).toHaveLength(1);
  });
});
