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
  const alarmListeners: Array<(alarm: { name: string }) => void> = [];
  const tabRemovedListeners: Array<(tabId: number) => void> = [];
  const sessionStorage: Record<string, unknown> = {};
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
          if (index < 0) throw new Error(`Unknown tab ${tabId}`);
          const [tab] = tabs.splice(index, 1);
          tabRemovedListeners.forEach((listener) => listener(tabId));
          if (tab.groupId !== undefined && !tabs.some((entry) => entry.groupId === tab.groupId)) {
            const groupIndex = groups.findIndex((entry) => entry.id === tab.groupId);
            if (groupIndex >= 0) groups.splice(groupIndex, 1);
          }
        }
      }),
      get: vi.fn(async (tabId: number) => {
        const tab = tabs.find((entry) => entry.id === tabId);
        if (!tab) throw new Error(`Unknown tab ${tabId}`);
        return tab;
      }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() } as Listener<(id: number, info: chrome.tabs.TabChangeInfo) => void>,
      onRemoved: {
        addListener: vi.fn((listener: (tabId: number) => void) => tabRemovedListeners.push(listener)),
        removeListener: vi.fn(),
      } as Listener<(tabId: number) => void>,
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
      clear: vi.fn(async () => true),
      onAlarm: {
        addListener: vi.fn((listener: (alarm: { name: string }) => void) => alarmListeners.push(listener)),
        removeListener: vi.fn(),
      } as Listener<(alarm: { name: string }) => void>,
    },
    storage: {
      session: {
        get: vi.fn(async (keys?: string | string[] | Record<string, unknown>) => {
          if (keys === undefined) return { ...sessionStorage };
          const requested = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
          return Object.fromEntries(requested.flatMap((key) =>
            Object.prototype.hasOwnProperty.call(sessionStorage, key) ? [[key, sessionStorage[key]]] : []
          ));
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(sessionStorage, items);
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          for (const key of (Array.isArray(keys) ? keys : [keys])) delete sessionStorage[key];
        }),
      },
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

  return {
    chrome,
    tabs,
    groups,
    query,
    create,
    group,
    update,
    sessionStorage,
    emitAlarm: async (name: string) => {
      for (const listener of [...alarmListeners]) listener({ name });
      await Promise.resolve();
      await Promise.resolve();
    },
    resetWorkerListeners: () => {
      alarmListeners.length = 0;
      tabRemovedListeners.length = 0;
    },
  };
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

  it('shares one strict-background tab group for concurrent commands with the same group name across workspaces', async () => {
    vi.useFakeTimers();
    try {
      const { chrome, tabs, groups, sessionStorage } = createChromeMock();
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
        workspace: 'site:zhihu',
        carrier: 'tab-group-background',
        groupName: 'work',
        groupIdleTimeoutSeconds: 1,
      }, 'site:zhihu');

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
      expect(Object.keys(sessionStorage)).toEqual([
        `autocli.tabGroupSession.${encodeURIComponent('AutoCLI-work')}`,
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
      expect(sessionStorage).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps implicit navigation tabs isolated by workspace inside one shared group', async () => {
    const { chrome, tabs, groups, sessionStorage } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    const twitter = await mod.__test__.handleNavigate({
      id: 'workspace-nav-1',
      action: 'navigate',
      url: 'https://twitter-target.example',
      workspace: 'site:twitter',
      carrier: 'tab-group-background',
      groupName: 'work',
    }, 'site:twitter');
    const zhihu = await mod.__test__.handleNavigate({
      id: 'workspace-nav-2',
      action: 'navigate',
      url: 'https://zhihu-target.example',
      workspace: 'site:zhihu',
      carrier: 'tab-group-background',
      groupName: 'work',
    }, 'site:zhihu');

    expect(twitter.ok).toBe(true);
    expect(zhihu.ok).toBe(true);
    const twitterTabId = (twitter.data as { tabId: number }).tabId;
    const zhihuTabId = (zhihu.data as { tabId: number }).tabId;
    expect(twitterTabId).not.toBe(zhihuTabId);
    expect(groups.filter((group) => group.title === 'AutoCLI-work')).toHaveLength(1);
    expect(tabs.find((tab) => tab.id === twitterTabId)?.url).toBe('https://twitter-target.example');
    expect(tabs.find((tab) => tab.id === zhihuTabId)?.url).toBe('https://zhihu-target.example');

    const twitterFollowUp = await mod.__test__.handleNavigate({
      id: 'workspace-nav-3',
      action: 'navigate',
      url: 'https://twitter-follow-up.example',
      workspace: 'site:twitter',
      carrier: 'tab-group-background',
      groupName: 'work',
    }, 'site:twitter');

    expect(twitterFollowUp.ok).toBe(true);
    expect((twitterFollowUp.data as { tabId: number }).tabId).toBe(twitterTabId);
    expect(tabs.find((tab) => tab.id === twitterTabId)?.url).toBe('https://twitter-follow-up.example');
    expect(tabs.find((tab) => tab.id === zhihuTabId)?.url).toBe('https://zhihu-target.example');
    const stored = sessionStorage[`autocli.tabGroupSession.${encodeURIComponent('AutoCLI-work')}`] as {
      workspaceTabIds: Array<[string, number]>;
    };
    expect(stored.workspaceTabIds).toEqual(expect.arrayContaining([
      ['site:twitter', twitterTabId],
      ['site:zhihu', zhihuTabId],
    ]));
  });

  it('isolates shared-group lists and refuses explicit foreign tabs', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./background');
    const base = { action: 'tabs' as const, carrier: 'tab-group-background' as const, groupName: 'work' };

    const twitter = await mod.__test__.handleCommand({
      id: 'owner-twitter', ...base, op: 'new', url: 'https://twitter.example', workspace: 'site:twitter',
    });
    const zhihu = await mod.__test__.handleCommand({
      id: 'owner-zhihu', ...base, op: 'new', url: 'https://zhihu.example', workspace: 'site:zhihu',
    });
    const twitterTabId = (twitter.data as { tabId: number }).tabId;
    const zhihuTabId = (zhihu.data as { tabId: number }).tabId;

    const twitterList = await mod.__test__.handleCommand({
      id: 'owner-list-twitter', ...base, op: 'list', workspace: 'site:twitter',
    });
    const zhihuList = await mod.__test__.handleCommand({
      id: 'owner-list-zhihu', ...base, op: 'list', workspace: 'site:zhihu',
    });
    expect((twitterList.data as Array<{ tabId: number }>).map((tab) => tab.tabId)).toContain(twitterTabId);
    expect((twitterList.data as Array<{ tabId: number }>).map((tab) => tab.tabId)).not.toContain(zhihuTabId);
    expect((zhihuList.data as Array<{ tabId: number }>).map((tab) => tab.tabId)).toEqual([zhihuTabId]);

    const foreignNavigate = await mod.__test__.handleCommand({
      id: 'owner-foreign-navigate', action: 'navigate', url: 'https://blocked.example', tabId: twitterTabId,
      workspace: 'site:zhihu', carrier: 'tab-group-background', groupName: 'work',
    });
    const foreignClose = await mod.__test__.handleCommand({
      id: 'owner-foreign-close', ...base, op: 'close', tabId: twitterTabId, workspace: 'site:zhihu',
    });
    expect(foreignNavigate).toEqual(expect.objectContaining({ ok: false, error: expect.stringContaining('strict-background-tab-not-owned:') }));
    expect(foreignClose).toEqual(expect.objectContaining({ ok: false, error: expect.stringContaining('strict-background-tab-not-owned:') }));
  });

  it('does not create a strict-background group for list or close without an owned tab', async () => {
    const { chrome, groups, create } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./background');
    const base = {
      action: 'tabs' as const, carrier: 'tab-group-background' as const, groupName: 'work', workspace: 'site:twitter',
    };

    const listed = await mod.__test__.handleCommand({ id: 'empty-list', ...base, op: 'list' });
    const closed = await mod.__test__.handleCommand({ id: 'empty-close', ...base, op: 'close' });
    expect(listed).toEqual(expect.objectContaining({ ok: true, data: [] }));
    expect(closed).toEqual(expect.objectContaining({ ok: false, error: expect.stringContaining('No strict-background tab') }));
    expect(groups).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps multiple tabs of one workspace listable and closable by that workspace only', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./background');
    const base = { action: 'tabs' as const, carrier: 'tab-group-background' as const, groupName: 'work', workspace: 'site:twitter' };
    const first = await mod.__test__.handleCommand({ id: 'multi-first', ...base, op: 'new', url: 'https://one.example' });
    const second = await mod.__test__.handleCommand({ id: 'multi-second', ...base, op: 'new', url: 'https://two.example' });
    const firstTabId = (first.data as { tabId: number }).tabId;
    const secondTabId = (second.data as { tabId: number }).tabId;
    const listed = await mod.__test__.handleCommand({ id: 'multi-list', ...base, op: 'list' });
    const listedIds = (listed.data as Array<{ tabId: number }>).map((tab) => tab.tabId);
    expect(listedIds).toEqual(expect.arrayContaining([firstTabId, secondTabId]));

    const index = listedIds.indexOf(firstTabId);
    const closed = await mod.__test__.handleCommand({ id: 'multi-close', ...base, op: 'close', index });
    expect(closed).toEqual(expect.objectContaining({ ok: true, data: { closed: firstTabId } }));
    const afterClose = await mod.__test__.handleCommand({ id: 'multi-list-after', ...base, op: 'list' });
    expect((afterClose.data as Array<{ tabId: number }>).map((tab) => tab.tabId)).toContain(secondTabId);
    expect((afterClose.data as Array<{ tabId: number }>).map((tab) => tab.tabId)).not.toContain(firstTabId);
  });

  it('returns a retryable stale-tab error and prunes its ownership ledger', async () => {
    const { chrome, sessionStorage } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./background');
    const created = await mod.__test__.handleCommand({
      id: 'stale-create', action: 'tabs', op: 'new', url: 'https://stale.example', workspace: 'site:twitter',
      carrier: 'tab-group-background', groupName: 'work',
    });
    const tabId = (created.data as { tabId: number }).tabId;
    await chrome.tabs.remove(tabId);

    const stale = await mod.__test__.handleCommand({
      id: 'stale-use', action: 'navigate', url: 'https://retry.example', tabId, workspace: 'site:twitter',
      carrier: 'tab-group-background', groupName: 'work',
    });
    expect(stale).toEqual(expect.objectContaining({ ok: false, error: expect.stringContaining('strict-background-stale-tab:') }));
    await vi.waitFor(() => {
      const stored = sessionStorage[`autocli.tabGroupSession.${encodeURIComponent('AutoCLI-work')}`] as {
        ownedTabIds: number[]; tabWorkspaceOwners: Array<[number, string]>;
      };
      expect(stored.ownedTabIds).not.toContain(tabId);
      expect(stored.tabWorkspaceOwners).not.toContainEqual([tabId, 'site:twitter']);
    });
  });

  it('prunes stale owned tab IDs when a later command uses the same group from another workspace', async () => {
    const { chrome, tabs, groups, sessionStorage } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    const created = await mod.__test__.handleTabs({
      id: '27',
      action: 'tabs',
      op: 'new',
      url: 'https://live.example',
      workspace: 'site:twitter',
      carrier: 'tab-group-background',
      groupName: 'work',
    }, 'site:twitter');
    expect(created.ok).toBe(true);

    const groupId = groups.find((group) => group.title === 'AutoCLI-work')?.id;
    const staleTabIndex = tabs.findIndex((tab) => tab.groupId === groupId && tab.url === 'about:blank');
    const liveTabId = (created.data as { tabId: number }).tabId;
    expect(staleTabIndex).toBeGreaterThanOrEqual(0);
    tabs.splice(staleTabIndex, 1);

    const listed = await mod.__test__.handleTabs({
      id: '28',
      action: 'tabs',
      op: 'list',
      workspace: 'site:zhihu',
      carrier: 'tab-group-background',
      groupName: 'work',
    }, 'site:zhihu');

    expect(listed.ok).toBe(true);
    // A different workspace shares the physical group but must not see the
    // remaining AutoCLI tab owned by site:twitter.
    expect(listed.data).toEqual([]);
    const stored = sessionStorage[`autocli.tabGroupSession.${encodeURIComponent('AutoCLI-work')}`] as {
      ownedTabIds: number[];
    };
    expect(stored.ownedTabIds).toEqual([liveTabId]);
  });

  it('keeps ownership metadata when a live tab query is temporarily unavailable', async () => {
    const { chrome, tabs, groups, sessionStorage } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    const created = await mod.__test__.handleTabs({
      id: '29',
      action: 'tabs',
      op: 'new',
      url: 'https://temporary-failure.example',
      workspace: 'site:twitter',
      carrier: 'tab-group-background',
      groupName: 'work',
    }, 'site:twitter');
    expect(created.ok).toBe(true);

    const groupId = groups.find((group) => group.title === 'AutoCLI-work')?.id;
    const ownedBeforeFailure = tabs.filter((tab) => tab.groupId === groupId).map((tab) => tab.id).sort();
    chrome.tabs.query.mockRejectedValueOnce(new Error('temporary tabs query failure'));

    const listed = await mod.__test__.handleTabs({
      id: '30',
      action: 'tabs',
      op: 'list',
      workspace: 'site:zhihu',
      carrier: 'tab-group-background',
      groupName: 'work',
    }, 'site:zhihu');

    expect(listed.ok).toBe(true);
    expect(groups.filter((group) => group.title === 'AutoCLI-work')).toHaveLength(1);
    const stored = sessionStorage[`autocli.tabGroupSession.${encodeURIComponent('AutoCLI-work')}`] as {
      ownedTabIds: number[];
    };
    expect([...stored.ownedTabIds].sort()).toEqual(ownedBeforeFailure);
  });

  it('expires owned tabs independently without extending sibling tabs in the same group', async () => {
    const { chrome, tabs, groups, emitAlarm, sessionStorage } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const startedAt = 1_000_000;
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    try {
      const mod = await import('./background');
      const first = await mod.__test__.handleCommand({
        id: 'per-tab-1',
        action: 'tabs',
        op: 'new',
        url: 'https://first.example',
        workspace: 'site:twitter',
        carrier: 'tab-group-background',
        groupName: 'work',
        groupIdleTimeoutSeconds: 5,
      });
      expect(first.ok).toBe(true);
      const firstTabId = (first.data as { tabId: number }).tabId;
      const groupId = groups.find((group) => group.title === 'AutoCLI-work')?.id;
      expect(groupId).toBeDefined();
      tabs.push({ id: 99, windowId: 2, groupId, url: 'https://user.example', title: 'user', active: false });

      dateNow.mockReturnValue(startedAt + 1_000);
      const second = await mod.__test__.handleCommand({
        id: 'per-tab-2',
        action: 'tabs',
        op: 'new',
        url: 'https://second.example',
        workspace: 'site:zhihu',
        carrier: 'tab-group-background',
        groupName: 'work',
        groupIdleTimeoutSeconds: 5,
      });
      expect(second.ok).toBe(true);
      const secondTabId = (second.data as { tabId: number }).tabId;

      dateNow.mockReturnValue(startedAt + 2_000);
      const listed = await mod.__test__.handleCommand({
        id: 'per-tab-list',
        action: 'tabs',
        op: 'list',
        workspace: 'site:twitter',
        carrier: 'tab-group-background',
        groupName: 'work',
        groupIdleTimeoutSeconds: 5,
      });
      expect(listed.ok).toBe(true);

      const storageKey = `autocli.tabGroupSession.${encodeURIComponent('AutoCLI-work')}`;
      const beforeExpiry = sessionStorage[storageKey] as {
        idleDeadlineAt: number;
        tabActivities: Array<[number, { lastOperationAt: number; expiresAt: number }]>;
      };
      expect(beforeExpiry.tabActivities.find(([tabId]) => tabId === firstTabId)?.[1]).toEqual({
        lastOperationAt: startedAt,
        expiresAt: startedAt + 5_000,
      });
      expect(beforeExpiry.tabActivities.find(([tabId]) => tabId === secondTabId)?.[1]).toEqual({
        lastOperationAt: startedAt + 1_000,
        expiresAt: startedAt + 6_000,
      });
      expect(beforeExpiry.idleDeadlineAt).toBe(startedAt + 5_000);

      dateNow.mockReturnValue(startedAt + 5_001);
      await emitAlarm(`autocli-tab-group-cleanup:${encodeURIComponent('AutoCLI-work')}`);
      await vi.waitFor(() => {
        expect(tabs.some((tab) => tab.id === firstTabId)).toBe(false);
      });
      expect(tabs.some((tab) => tab.id === secondTabId)).toBe(true);
      expect(tabs.some((tab) => tab.id === 99)).toBe(true);

      const afterFirstExpiry = sessionStorage[storageKey] as {
        ownedTabIds: number[];
        idleDeadlineAt: number;
        tabActivities: Array<[number, { lastOperationAt: number; expiresAt: number }]>;
      };
      expect(afterFirstExpiry.ownedTabIds).toEqual([secondTabId]);
      expect(afterFirstExpiry.tabActivities).toEqual([[
        secondTabId,
        { lastOperationAt: startedAt + 1_000, expiresAt: startedAt + 6_000 },
      ]]);
      expect(afterFirstExpiry.idleDeadlineAt).toBe(startedAt + 6_000);

      dateNow.mockReturnValue(startedAt + 6_001);
      await emitAlarm(`autocli-tab-group-cleanup:${encodeURIComponent('AutoCLI-work')}`);
      await vi.waitFor(() => {
        expect(tabs.some((tab) => tab.id === secondTabId)).toBe(false);
      });
      expect(tabs.some((tab) => tab.id === 99)).toBe(true);
      expect(groups.filter((group) => group.title === 'AutoCLI-work')).toHaveLength(1);
      expect(sessionStorage).toEqual({});
    } finally {
      dateNow.mockRestore();
    }
  });

  it('refreshes only the tab with a successful strict-background operation', async () => {
    const { chrome, tabs, groups, emitAlarm, sessionStorage } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const startedAt = 2_000_000;
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    const executor = await import('./cdp');
    const screenshotSpy = vi.spyOn(executor, 'screenshot').mockResolvedValue('screenshot-data');
    try {
      const mod = await import('./background');
      const first = await mod.__test__.handleCommand({
        id: 'target-touch-1',
        action: 'tabs',
        op: 'new',
        url: 'https://first-target.example',
        workspace: 'site:twitter',
        carrier: 'tab-group-background',
        groupName: 'work',
        groupIdleTimeoutSeconds: 5,
      });
      const second = await mod.__test__.handleCommand({
        id: 'target-touch-2',
        action: 'tabs',
        op: 'new',
        url: 'https://second-target.example',
        workspace: 'site:zhihu',
        carrier: 'tab-group-background',
        groupName: 'work',
        groupIdleTimeoutSeconds: 5,
      });
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      const firstTabId = (first.data as { tabId: number }).tabId;
      const secondTabId = (second.data as { tabId: number }).tabId;
      const groupId = groups.find((group) => group.title === 'AutoCLI-work')?.id;
      tabs.push({ id: 99, windowId: 2, groupId, url: 'https://user.example', title: 'user', active: false });

      dateNow.mockReturnValue(startedAt + 1_000);
      const screenshot = await mod.__test__.handleCommand({
        id: 'target-touch-3',
        action: 'screenshot',
        tabId: secondTabId,
        workspace: 'site:zhihu',
        carrier: 'tab-group-background',
        groupName: 'work',
        groupIdleTimeoutSeconds: 5,
      });
      expect(screenshot).toEqual({ id: 'target-touch-3', ok: true, data: 'screenshot-data' });

      const storageKey = `autocli.tabGroupSession.${encodeURIComponent('AutoCLI-work')}`;
      const stored = sessionStorage[storageKey] as {
        tabActivities: Array<[number, { lastOperationAt: number; expiresAt: number }]>;
      };
      expect(stored.tabActivities.find(([tabId]) => tabId === firstTabId)?.[1]).toEqual({
        lastOperationAt: startedAt,
        expiresAt: startedAt + 5_000,
      });
      expect(stored.tabActivities.find(([tabId]) => tabId === secondTabId)?.[1]).toEqual({
        lastOperationAt: startedAt + 1_000,
        expiresAt: startedAt + 6_000,
      });

      dateNow.mockReturnValue(startedAt + 5_001);
      await emitAlarm(`autocli-tab-group-cleanup:${encodeURIComponent('AutoCLI-work')}`);
      await vi.waitFor(() => {
        expect(tabs.some((tab) => tab.id === firstTabId)).toBe(false);
      });
      expect(tabs.some((tab) => tab.id === secondTabId)).toBe(true);
      expect(tabs.some((tab) => tab.id === 99)).toBe(true);

      // Drain the remaining tab before restoring the real clock so this test's
      // in-memory scheduler cannot outlive its mocked Chrome instance.
      dateNow.mockReturnValue(startedAt + 6_001);
      await emitAlarm(`autocli-tab-group-cleanup:${encodeURIComponent('AutoCLI-work')}`);
      await vi.waitFor(() => {
        expect(tabs.some((tab) => tab.id === secondTabId)).toBe(false);
      });
    } finally {
      screenshotSpy.mockRestore();
      dateNow.mockRestore();
    }
  });

  it('does not refresh a tab when its strict-background operation fails', async () => {
    const { chrome, tabs, emitAlarm, sessionStorage } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const startedAt = 3_000_000;
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    const executor = await import('./cdp');
    const screenshotSpy = vi.spyOn(executor, 'screenshot').mockRejectedValue(new Error('screenshot failed'));
    try {
      const mod = await import('./background');
      const created = await mod.__test__.handleCommand({
        id: 'failed-touch-1',
        action: 'tabs',
        op: 'new',
        url: 'https://failed-touch.example',
        workspace: 'site:twitter',
        carrier: 'tab-group-background',
        groupName: 'work',
        groupIdleTimeoutSeconds: 5,
      });
      expect(created.ok).toBe(true);
      const tabId = (created.data as { tabId: number }).tabId;

      dateNow.mockReturnValue(startedAt + 1_000);
      const screenshot = await mod.__test__.handleCommand({
        id: 'failed-touch-2',
        action: 'screenshot',
        tabId,
        workspace: 'site:twitter',
        carrier: 'tab-group-background',
        groupName: 'work',
        groupIdleTimeoutSeconds: 5,
      });
      expect(screenshot.ok).toBe(false);
      expect(screenshot.error).toContain('screenshot failed');

      const storageKey = `autocli.tabGroupSession.${encodeURIComponent('AutoCLI-work')}`;
      const stored = sessionStorage[storageKey] as {
        tabActivities: Array<[number, { lastOperationAt: number; expiresAt: number }]>;
      };
      expect(stored.tabActivities.find(([storedTabId]) => storedTabId === tabId)?.[1]).toEqual({
        lastOperationAt: startedAt,
        expiresAt: startedAt + 5_000,
      });

      dateNow.mockReturnValue(startedAt + 5_001);
      await emitAlarm(`autocli-tab-group-cleanup:${encodeURIComponent('AutoCLI-work')}`);
      await vi.waitFor(() => {
        expect(tabs.some((tab) => tab.id === tabId)).toBe(false);
      });
    } finally {
      screenshotSpy.mockRestore();
      dateNow.mockRestore();
    }
  });

  it('migrates a legacy session record to per-tab activity without extending its deadline', async () => {
    const { chrome, tabs, groups, emitAlarm, sessionStorage } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const legacyDeadlineAt = 4_005_000;
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(4_000_000);
    const storageKey = `autocli.tabGroupSession.${encodeURIComponent('AutoCLI-work')}`;
    groups.push({ id: 200, title: 'AutoCLI-work', windowId: 2, collapsed: true, color: 'blue' });
    tabs.push(
      { id: 10, windowId: 2, groupId: 200, url: 'https://legacy-owned.example', title: 'legacy owned', active: false },
      { id: 99, windowId: 2, groupId: 200, url: 'https://user.example', title: 'user', active: false },
    );
    sessionStorage[storageKey] = {
      groupId: 200,
      windowId: 2,
      title: 'AutoCLI-work',
      ownedTabIds: [10],
      workspaceTabIds: [['site:twitter', 10]],
      tabWorkspaceOwners: [[10, 'site:twitter']],
      leaseId: 'legacy-session',
      idleDeadlineAt: legacyDeadlineAt,
    };

    try {
      await import('./background');
      await vi.waitFor(() => {
        const migrated = sessionStorage[storageKey] as {
          tabActivities?: Array<[number, { lastOperationAt: number; expiresAt: number }]>;
        };
        expect(migrated.tabActivities).toEqual([[
          10,
          { lastOperationAt: legacyDeadlineAt, expiresAt: legacyDeadlineAt },
        ]]);
      });
      expect(chrome.alarms.create).toHaveBeenCalledWith(
        `autocli-tab-group-cleanup:${encodeURIComponent('AutoCLI-work')}`,
        { when: legacyDeadlineAt },
      );

      dateNow.mockReturnValue(legacyDeadlineAt + 1);
      await emitAlarm(`autocli-tab-group-cleanup:${encodeURIComponent('AutoCLI-work')}`);
      await vi.waitFor(() => {
        expect(tabs.some((tab) => tab.id === 10)).toBe(false);
      });
      expect(tabs.some((tab) => tab.id === 99)).toBe(true);
      expect(sessionStorage).toEqual({});
    } finally {
      dateNow.mockRestore();
    }
  });

  it('keeps a renewed session record when idle cleanup overlaps a new command', async () => {
    const { chrome, tabs, groups, emitAlarm, sessionStorage } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    const created = await mod.__test__.handleTabs({
      id: '31',
      action: 'tabs',
      op: 'new',
      url: 'https://old.example',
      workspace: 'site:twitter',
      carrier: 'tab-group-background',
      groupName: 'work',
      groupIdleTimeoutSeconds: 120,
    }, 'site:twitter');
    expect(created.ok).toBe(true);

    const groupId = groups.find((group) => group.title === 'AutoCLI-work')?.id;
    expect(groupId).toBeDefined();
    tabs.push({ id: 99, windowId: 2, groupId, url: 'https://user.example', title: 'user', active: false });
    const cleanupAlarm = chrome.alarms.create.mock.calls.find(([name]) =>
      typeof name === 'string' && name.startsWith('autocli-tab-group-cleanup:')
    );
    const originalSession = sessionStorage[`autocli.tabGroupSession.${encodeURIComponent('AutoCLI-work')}`] as {
      idleDeadlineAt: number;
    };
    expect(cleanupAlarm).toBeDefined();
    expect(originalSession).toBeDefined();

    const defaultStorageRemove = chrome.storage.session.remove.getMockImplementation();
    expect(defaultStorageRemove).toBeDefined();
    let releaseStorageRemove: (() => void) | undefined;
    let storageRemoveStarted = false;
    chrome.storage.session.remove.mockImplementation(async (keys: string | string[]) => {
      if (!storageRemoveStarted) {
        storageRemoveStarted = true;
        await new Promise<void>((resolve) => {
          releaseStorageRemove = resolve;
        });
      }
      return defaultStorageRemove!(keys);
    });

    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(originalSession.idleDeadlineAt + 1);
    try {
      await emitAlarm(cleanupAlarm![0]);
      await vi.waitFor(() => {
        expect(storageRemoveStarted).toBe(true);
      });

      const renewed = mod.__test__.handleCommand({
        id: '32',
        action: 'tabs',
        op: 'new',
        url: 'https://new.example',
        workspace: 'site:zhihu',
        carrier: 'tab-group-background',
        groupName: 'work',
        groupIdleTimeoutSeconds: 120,
      });

      releaseStorageRemove!();
      const renewedResult = await renewed;
      expect(renewedResult.ok).toBe(true);
      const newTabId = (renewedResult.data as { tabId: number }).tabId;

      await vi.waitFor(() => {
        const stored = sessionStorage[`autocli.tabGroupSession.${encodeURIComponent('AutoCLI-work')}`] as {
          ownedTabIds: number[];
        } | undefined;
        expect(stored?.ownedTabIds).toContain(newTabId);
      });
      expect(tabs.some((tab) => tab.id === 99)).toBe(true);

      const renewedSession = sessionStorage[`autocli.tabGroupSession.${encodeURIComponent('AutoCLI-work')}`] as {
        idleDeadlineAt: number;
      };
      dateNow.mockReturnValue(renewedSession.idleDeadlineAt + 1);
      await emitAlarm(cleanupAlarm![0]);
      await vi.waitFor(() => {
        expect(tabs.some((tab) => tab.id === newTabId)).toBe(false);
      });
      expect(tabs.some((tab) => tab.id === 99)).toBe(true);
      expect(sessionStorage).toEqual({});
    } finally {
      dateNow.mockRestore();
    }
  });

  it('removes persisted owned tabs when the restarted worker receives the cleanup alarm', async () => {
    const { chrome, tabs, groups, emitAlarm, resetWorkerListeners, sessionStorage } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const firstWorker = await import('./background');
    const created = await firstWorker.__test__.handleTabs({
      id: '20',
      action: 'tabs',
      op: 'new',
      url: 'https://restart.example',
      workspace: 'site:twitter',
      carrier: 'tab-group-background',
      groupName: 'work',
      groupIdleTimeoutSeconds: 120,
    }, 'site:twitter');

    expect(created.ok).toBe(true);
    const groupId = groups.find((entry) => entry.title === 'AutoCLI-work')?.id;
    expect(groupId).toBeDefined();
    const cleanupAlarm = chrome.alarms.create.mock.calls.find(([name]) =>
      typeof name === 'string' && name.startsWith('autocli-tab-group-cleanup:')
    );
    expect(cleanupAlarm).toBeDefined();
    const alarmCountBeforeRestart = chrome.alarms.create.mock.calls.length;
    const storedSession = Object.values(sessionStorage).find((value): value is { idleDeadlineAt: number } =>
      typeof value === 'object'
      && value !== null
      && 'idleDeadlineAt' in value
      && typeof value.idleDeadlineAt === 'number'
    );
    expect(storedSession).toBeDefined();

    // A restarted MV3 worker has no in-memory session or timer from the first worker.
    resetWorkerListeners();
    vi.resetModules();
    await import('./background');
    await vi.waitFor(() => {
      expect(chrome.alarms.create.mock.calls.length).toBeGreaterThan(alarmCountBeforeRestart);
    });
    expect(tabs.some((tab) => tab.groupId === groupId)).toBe(true);

    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(storedSession!.idleDeadlineAt + 1);
    try {
      await emitAlarm(cleanupAlarm![0]);
      await vi.waitFor(() => {
        expect(tabs.some((tab) => tab.groupId === groupId)).toBe(false);
      });
    } finally {
      dateNow.mockRestore();
    }

    expect(groups.some((group) => group.id === groupId)).toBe(false);
  });

  it('prunes stale owned tab IDs while restoring a title-only session', async () => {
    const { chrome, tabs, groups, resetWorkerListeners, sessionStorage } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const firstWorker = await import('./background');
    const created = await firstWorker.__test__.handleTabs({
      id: '33',
      action: 'tabs',
      op: 'new',
      url: 'https://restore-live.example',
      workspace: 'site:twitter',
      carrier: 'tab-group-background',
      groupName: 'work',
      groupIdleTimeoutSeconds: 120,
    }, 'site:twitter');
    expect(created.ok).toBe(true);

    const groupId = groups.find((group) => group.title === 'AutoCLI-work')?.id;
    const liveTabId = (created.data as { tabId: number }).tabId;
    const staleTabIndex = tabs.findIndex((tab) => tab.groupId === groupId && tab.url === 'about:blank');
    expect(staleTabIndex).toBeGreaterThanOrEqual(0);
    tabs.splice(staleTabIndex, 1);

    resetWorkerListeners();
    vi.resetModules();
    await import('./background');

    await vi.waitFor(() => {
      const stored = sessionStorage[`autocli.tabGroupSession.${encodeURIComponent('AutoCLI-work')}`] as {
        ownedTabIds: number[];
      } | undefined;
      expect(stored?.ownedTabIds).toEqual([liveTabId]);
    });
  });

  it('refreshes only the released workspace tab after a worker restart', async () => {
    const { chrome, sessionStorage, resetWorkerListeners } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const firstWorker = await import('./background');
    await firstWorker.__test__.handleTabs({
      id: '23',
      action: 'tabs',
      op: 'new',
      url: 'https://restart-release.example',
      workspace: 'site:twitter',
      carrier: 'tab-group-background',
      groupName: 'work',
      groupIdleTimeoutSeconds: 120,
    }, 'site:twitter');
    const initialSession = Object.values(sessionStorage).find((value): value is { idleDeadlineAt: number } =>
      typeof value === 'object'
      && value !== null
      && 'idleDeadlineAt' in value
      && typeof value.idleDeadlineAt === 'number'
    );
    expect(initialSession).toBeDefined();

    resetWorkerListeners();
    vi.resetModules();
    const restartAt = initialSession!.idleDeadlineAt - 60_000;
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(restartAt);
    try {
      const restartedWorker = await import('./background');
      const released = await restartedWorker.__test__.handleCloseWindow({
        id: '24',
        action: 'close-window',
        workspace: 'site:twitter',
        carrier: 'tab-group-background',
        groupName: 'work',
        groupIdleTimeoutSeconds: 120,
      }, 'site:twitter');

      expect(released.ok).toBe(true);
      const renewedSession = Object.values(sessionStorage).find((value): value is {
        idleDeadlineAt: number;
        workspaceTabIds: Array<[string, number]>;
        tabActivities: Array<[number, { lastOperationAt: number; expiresAt: number }]>;
      } =>
        typeof value === 'object'
        && value !== null
        && 'idleDeadlineAt' in value
        && typeof value.idleDeadlineAt === 'number'
      );
      expect(renewedSession).toBeDefined();
      const releasedTabId = renewedSession!.workspaceTabIds.find(([workspace]) => workspace === 'site:twitter')?.[1];
      expect(releasedTabId).toBeDefined();
      const releasedActivity = renewedSession!.tabActivities.find(([tabId]) => tabId === releasedTabId)?.[1];
      expect(releasedActivity).toEqual({
        lastOperationAt: restartAt,
        expiresAt: restartAt + 120_000,
      });
      // The seed tab was not released, so it remains the group's earliest
      // per-tab expiry rather than being extended by another tab's close.
      expect(renewedSession!.idleDeadlineAt).toBe(initialSession!.idleDeadlineAt);
    } finally {
      dateNow.mockRestore();
    }
  });

  it('stops idle cleanup after a new command renews the group during tab removal', async () => {
    const { chrome, tabs, groups, emitAlarm, sessionStorage } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    const created = await mod.__test__.handleTabs({
      id: '25',
      action: 'tabs',
      op: 'new',
      url: 'https://renew-during-cleanup.example',
      workspace: 'site:twitter',
      carrier: 'tab-group-background',
      groupName: 'work',
      groupIdleTimeoutSeconds: 120,
    }, 'site:twitter');
    expect(created.ok).toBe(true);
    const groupId = groups.find((entry) => entry.title === 'AutoCLI-work')?.id;
    const createdTabId = (created.data as { tabId: number }).tabId;
    const cleanupAlarm = chrome.alarms.create.mock.calls.find(([name]) =>
      typeof name === 'string' && name.startsWith('autocli-tab-group-cleanup:')
    );
    const storedSession = Object.values(sessionStorage).find((value): value is { idleDeadlineAt: number } =>
      typeof value === 'object'
      && value !== null
      && 'idleDeadlineAt' in value
      && typeof value.idleDeadlineAt === 'number'
    );
    expect(groupId).toBeDefined();
    expect(cleanupAlarm).toBeDefined();
    expect(storedSession).toBeDefined();

    const remove = chrome.tabs.remove;
    const defaultRemove = remove.getMockImplementation();
    expect(defaultRemove).toBeDefined();
    let releaseFirstRemoval: (() => void) | undefined;
    let firstRemovalStarted = false;
    let secondRemovalStarted = false;
    remove.mockImplementation(async (tabIdOrIds: number | number[]) => {
      if (!firstRemovalStarted) {
        firstRemovalStarted = true;
        await new Promise<void>((resolve) => {
          releaseFirstRemoval = resolve;
        });
      } else {
        secondRemovalStarted = true;
      }
      return defaultRemove!(tabIdOrIds);
    });

    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(storedSession!.idleDeadlineAt + 1);
    try {
      await emitAlarm(cleanupAlarm![0]);
      await vi.waitFor(() => {
        expect(firstRemovalStarted).toBe(true);
      });

      const released = await mod.__test__.handleCloseWindow({
        id: '26',
        action: 'close-window',
        workspace: 'site:twitter',
        carrier: 'tab-group-background',
        groupName: 'work',
        groupIdleTimeoutSeconds: 120,
      }, 'site:twitter');
      expect(released.ok).toBe(true);

      releaseFirstRemoval!();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(secondRemovalStarted).toBe(false);
      expect(tabs.some((tab) => tab.id === createdTabId)).toBe(true);
    } finally {
      dateNow.mockRestore();
    }
  });

  it('closes remaining owned tabs when an earlier owned tab is already gone', async () => {
    vi.useFakeTimers();
    try {
      const { chrome, tabs, groups } = createChromeMock();
      vi.stubGlobal('chrome', chrome);

      const mod = await import('./background');
      const created = await mod.__test__.handleTabs({
        id: '21',
        action: 'tabs',
        op: 'new',
        url: 'https://stale-tab.example',
        workspace: 'site:twitter',
        carrier: 'tab-group-background',
        groupName: 'work',
        groupIdleTimeoutSeconds: 1,
      }, 'site:twitter');

      expect(created.ok).toBe(true);
      const groupId = groups.find((entry) => entry.title === 'AutoCLI-work')?.id;
      expect(groupId).toBeDefined();
      const seedIndex = tabs.findIndex((tab) => tab.groupId === groupId && tab.url === 'about:blank');
      expect(seedIndex).toBeGreaterThanOrEqual(0);
      tabs.splice(seedIndex, 1);

      await mod.__test__.handleCloseWindow({
        id: '22',
        action: 'close-window',
        workspace: 'site:twitter',
        carrier: 'tab-group-background',
        groupName: 'work',
        groupIdleTimeoutSeconds: 1,
      }, 'site:twitter');
      await vi.advanceTimersByTimeAsync(1000);

      expect(tabs.some((tab) => tab.groupId === groupId)).toBe(false);
      expect(groups.some((group) => group.id === groupId)).toBe(false);
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
        workspace: 'site:zhihu',
        carrier: 'tab-group-background',
        groupName: 'dev',
      }, 'site:zhihu'),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(groups.filter((group) => group.title === 'AutoCLI-work')).toHaveLength(1);
    expect(groups.filter((group) => group.title === 'AutoCLI-dev')).toHaveLength(1);
  });

  it('retries a transient session-storage write before returning strict-background success', async () => {
    const { chrome, sessionStorage } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    chrome.storage.session.set.mockRejectedValueOnce(new Error('temporary storage failure'));

    const mod = await import('./background');
    const result = await mod.__test__.handleCommand({
      id: '34',
      action: 'tabs',
      op: 'new',
      url: 'https://storage-retry.example',
      workspace: 'site:twitter',
      carrier: 'tab-group-background',
      groupName: 'work',
    });

    expect(result.ok).toBe(true);
    expect(chrome.storage.session.set.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(sessionStorage[`autocli.tabGroupSession.${encodeURIComponent('AutoCLI-work')}`]).toEqual(
      expect.objectContaining({
        title: 'AutoCLI-work',
        ownedTabIds: expect.arrayContaining([10, 11]),
      }),
    );
  });

  it('rolls back a newly created group when its first ownership record cannot be persisted', async () => {
    const { chrome, tabs, groups, sessionStorage } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    chrome.storage.session.set.mockRejectedValue(new Error('storage offline'));

    const mod = await import('./background');
    const result = await mod.__test__.handleCommand({
      id: '35',
      action: 'tabs',
      op: 'new',
      url: 'https://storage-offline.example',
      workspace: 'site:twitter',
      carrier: 'tab-group-background',
      groupName: 'work',
    });

    expect(result.ok).toBe(false);
    expect(groups.filter((group) => group.title === 'AutoCLI-work')).toHaveLength(0);
    expect(tabs.some((tab) => tab.url === 'about:blank' || tab.url === 'https://storage-offline.example')).toBe(false);
    expect(sessionStorage).toEqual({});
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });

  it('rolls back only a new tab when an existing group cannot persist its updated ownership', async () => {
    const { chrome, tabs, groups, sessionStorage } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    const created = await mod.__test__.handleTabs({
      id: '36',
      action: 'tabs',
      op: 'new',
      url: 'https://stored.example',
      workspace: 'site:twitter',
      carrier: 'tab-group-background',
      groupName: 'work',
    }, 'site:twitter');
    expect(created.ok).toBe(true);

    const groupId = groups.find((group) => group.title === 'AutoCLI-work')?.id;
    expect(groupId).toBeDefined();
    tabs.push({ id: 99, windowId: 2, groupId, url: 'https://user.example', title: 'user', active: false });

    chrome.storage.session.set.mockImplementation(async (_items: Record<string, unknown>) => {
      throw new Error('storage offline');
    });

    await expect(mod.__test__.handleTabs({
      id: '37',
      action: 'tabs',
      op: 'new',
      url: 'https://rollback-only-this-tab.example',
      workspace: 'site:zhihu',
      carrier: 'tab-group-background',
      groupName: 'work',
    }, 'site:zhihu')).rejects.toThrow('storage offline');

    expect(tabs.some((tab) => tab.url === 'https://rollback-only-this-tab.example')).toBe(false);
    expect(tabs.some((tab) => tab.id === 99)).toBe(true);
    expect(groups.filter((group) => group.title === 'AutoCLI-work')).toHaveLength(1);
    const stored = sessionStorage[`autocli.tabGroupSession.${encodeURIComponent('AutoCLI-work')}`] as {
      ownedTabIds: number[];
    };
    expect(stored.ownedTabIds).toEqual(expect.arrayContaining([10, 11]));
    expect(stored.ownedTabIds).not.toContain(12);
  });

  it('retries storage restoration and keyed cleanup instead of treating an unavailable record as absent', async () => {
    const { chrome, emitAlarm } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    chrome.storage.session.get.mockRejectedValue(new Error('storage offline'));

    await import('./background');
    await vi.waitFor(() => {
      expect(chrome.alarms.create).toHaveBeenCalledWith('autocli-tab-group-restore', expect.objectContaining({ when: expect.any(Number) }));
    });

    await emitAlarm(`autocli-tab-group-cleanup:${encodeURIComponent('AutoCLI-work')}`);

    await vi.waitFor(() => {
      expect(chrome.alarms.create).toHaveBeenCalledWith(
        `autocli-tab-group-cleanup:${encodeURIComponent('AutoCLI-work')}`,
        expect.objectContaining({ when: expect.any(Number) }),
      );
    });
    expect(chrome.alarms.clear).not.toHaveBeenCalled();
  });

  it('does not let restore delete a valid session written after its stale invalid snapshot', async () => {
    const { chrome, sessionStorage } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const storageKey = `autocli.tabGroupSession.${encodeURIComponent('AutoCLI-work')}`;
    sessionStorage[storageKey] = { malformed: true };
    const defaultGet = chrome.storage.session.get.getMockImplementation();
    expect(defaultGet).toBeDefined();
    let snapshotReadStarted = false;
    let releaseSnapshotRead: (() => void) | undefined;
    chrome.storage.session.get.mockImplementation(async (keys?: string | string[] | Record<string, unknown>) => {
      if (keys === undefined && !snapshotReadStarted) {
        snapshotReadStarted = true;
        const staleSnapshot = { ...sessionStorage };
        await new Promise<void>((resolve) => {
          releaseSnapshotRead = resolve;
        });
        return staleSnapshot;
      }
      return defaultGet!(keys);
    });

    const mod = await import('./background');
    await vi.waitFor(() => {
      expect(snapshotReadStarted).toBe(true);
    });

    const created = await mod.__test__.handleCommand({
      id: 'restore-race-1',
      action: 'tabs',
      op: 'new',
      url: 'https://restore-race.example',
      workspace: 'site:twitter',
      carrier: 'tab-group-background',
      groupName: 'work',
    });
    expect(created.ok).toBe(true);
    const newTabId = (created.data as { tabId: number }).tabId;
    const recordBeforeRestore = sessionStorage[storageKey] as {
      leaseId: string;
      ownedTabIds: number[];
    };
    expect(recordBeforeRestore.ownedTabIds).toContain(newTabId);
    expect(recordBeforeRestore.leaseId).toEqual(expect.any(String));

    releaseSnapshotRead!();
    await vi.waitFor(() => {
      const finalRecord = sessionStorage[storageKey] as {
        leaseId: string;
        ownedTabIds: number[];
      } | undefined;
      expect(finalRecord?.leaseId).toBe(recordBeforeRestore.leaseId);
      expect(finalRecord?.ownedTabIds).toContain(newTabId);
    });
  });

  it('keeps user tabs and schedules another cleanup when stale-ID pruning cannot be persisted', async () => {
    const { chrome, tabs, groups, emitAlarm, sessionStorage } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    const created = await mod.__test__.handleTabs({
      id: '38',
      action: 'tabs',
      op: 'new',
      url: 'https://cleanup-storage-failure.example',
      workspace: 'site:twitter',
      carrier: 'tab-group-background',
      groupName: 'work',
      groupIdleTimeoutSeconds: 120,
    }, 'site:twitter');
    expect(created.ok).toBe(true);

    const groupId = groups.find((group) => group.title === 'AutoCLI-work')?.id;
    const cleanupAlarm = chrome.alarms.create.mock.calls.find(([name]) =>
      typeof name === 'string' && name.startsWith('autocli-tab-group-cleanup:')
    );
    const stored = sessionStorage[`autocli.tabGroupSession.${encodeURIComponent('AutoCLI-work')}`] as {
      idleDeadlineAt: number;
    };
    expect(groupId).toBeDefined();
    expect(cleanupAlarm).toBeDefined();
    expect(stored).toBeDefined();
    tabs.push({ id: 99, windowId: 2, groupId, url: 'https://user.example', title: 'user', active: false });

    chrome.storage.session.set.mockRejectedValue(new Error('storage offline'));
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(stored.idleDeadlineAt + 1);
    try {
      await emitAlarm(cleanupAlarm![0]);
      await vi.waitFor(() => {
        expect(tabs.some((tab) => tab.id === 99)).toBe(true);
        expect(tabs.some((tab) => tab.groupId === groupId && tab.id !== 99)).toBe(false);
      });
    } finally {
      dateNow.mockRestore();
    }

    expect(chrome.storage.session.remove).not.toHaveBeenCalled();
    expect(chrome.alarms.create).toHaveBeenCalledWith(
      cleanupAlarm![0],
      expect.objectContaining({ when: expect.any(Number) }),
    );
  });

  it('does not remove an explicit target tab after a same-group command reaches the activity fence', async () => {
    const { chrome, tabs, groups, emitAlarm, sessionStorage } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    const created = await mod.__test__.handleCommand({
      id: '39',
      action: 'tabs',
      op: 'new',
      url: 'https://activity-fence.example',
      workspace: 'site:twitter',
      carrier: 'tab-group-background',
      groupName: 'work',
      groupIdleTimeoutSeconds: 120,
    });
    expect(created.ok).toBe(true);

    const targetTabId = (created.data as { tabId: number }).tabId;
    const groupId = groups.find((group) => group.title === 'AutoCLI-work')?.id;
    const cleanupAlarm = chrome.alarms.create.mock.calls.find(([name]) =>
      typeof name === 'string' && name.startsWith('autocli-tab-group-cleanup:')
    );
    const stored = sessionStorage[`autocli.tabGroupSession.${encodeURIComponent('AutoCLI-work')}`] as {
      idleDeadlineAt: number;
    };
    expect(groupId).toBeDefined();
    expect(cleanupAlarm).toBeDefined();
    expect(stored).toBeDefined();

    const defaultQuery = chrome.tabs.query.getMockImplementation();
    expect(defaultQuery).toBeDefined();
    let groupQueryCount = 0;
    let cleanupQueryBlocked = false;
    let releaseCleanupQuery: (() => void) | undefined;
    chrome.tabs.query.mockImplementation(async (queryInfo: { windowId?: number; groupId?: number } = {}) => {
      if (queryInfo.groupId === groupId) {
        groupQueryCount++;
        if (groupQueryCount === 3) {
          cleanupQueryBlocked = true;
          await new Promise<void>((resolve) => {
            releaseCleanupQuery = resolve;
          });
        }
      }
      return defaultQuery!(queryInfo);
    });

    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(stored.idleDeadlineAt + 1);
    try {
      await emitAlarm(cleanupAlarm![0]);
      await vi.waitFor(() => {
        expect(cleanupQueryBlocked).toBe(true);
      });

      const command = mod.__test__.handleCommand({
        id: '40',
        action: 'screenshot',
        tabId: targetTabId,
        workspace: 'site:zhihu',
        carrier: 'tab-group-background',
        groupName: 'work',
        groupIdleTimeoutSeconds: 120,
      });
      releaseCleanupQuery!();
      await command;

      expect(tabs.some((tab) => tab.id === targetTabId)).toBe(true);
      expect(chrome.tabs.remove).not.toHaveBeenCalledWith(targetTabId);
    } finally {
      dateNow.mockRestore();
    }
  });

  it('waits for an in-flight cleanup removal before a later same-group command resolves a tab', async () => {
    const { chrome, tabs, groups, emitAlarm, sessionStorage, create } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    const created = await mod.__test__.handleCommand({
      id: 'cleanup-lease-1',
      action: 'tabs',
      op: 'new',
      url: 'https://old-tab.example',
      workspace: 'site:twitter',
      carrier: 'tab-group-background',
      groupName: 'work',
      groupIdleTimeoutSeconds: 120,
    });
    expect(created.ok).toBe(true);

    const groupId = groups.find((group) => group.title === 'AutoCLI-work')?.id;
    const cleanupAlarm = chrome.alarms.create.mock.calls.find(([name]) =>
      typeof name === 'string' && name.startsWith('autocli-tab-group-cleanup:')
    );
    const stored = sessionStorage[`autocli.tabGroupSession.${encodeURIComponent('AutoCLI-work')}`] as {
      idleDeadlineAt: number;
    };
    expect(groupId).toBeDefined();
    expect(cleanupAlarm).toBeDefined();
    tabs.push({ id: 94, windowId: 2, groupId, url: 'https://user-tab.example', title: 'user', active: false });

    const defaultRemove = chrome.tabs.remove.getMockImplementation();
    expect(defaultRemove).toBeDefined();
    let removalStarted = false;
    let releaseRemoval: (() => void) | undefined;
    chrome.tabs.remove.mockImplementation(async (tabIdOrIds: number | number[]) => {
      if (!removalStarted) {
        removalStarted = true;
        await new Promise<void>((resolve) => {
          releaseRemoval = resolve;
        });
      }
      return defaultRemove!(tabIdOrIds);
    });

    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(stored.idleDeadlineAt + 1);
    try {
      await emitAlarm(cleanupAlarm![0]);
      await vi.waitFor(() => {
        expect(removalStarted).toBe(true);
      });

      const createCallsBeforeCommand = create.mock.calls.length;
      const command = mod.__test__.handleCommand({
        id: 'cleanup-lease-2',
        action: 'tabs',
        op: 'new',
        url: 'https://new-tab.example',
        workspace: 'site:zhihu',
        carrier: 'tab-group-background',
        groupName: 'work',
        groupIdleTimeoutSeconds: 120,
      });
      await Promise.resolve();
      await Promise.resolve();

      // The later command has declared activity, but cannot resolve/create a
      // tab until the earlier cleanup's Chrome removal settles.
      expect(create).toHaveBeenCalledTimes(createCallsBeforeCommand);

      releaseRemoval!();
      const result = await command;
      expect(result.ok).toBe(true);
      const newTabId = (result.data as { tabId: number }).tabId;
      expect(tabs.some((tab) => tab.id === newTabId)).toBe(true);
      expect(chrome.tabs.remove).not.toHaveBeenCalledWith(newTabId);
    } finally {
      dateNow.mockRestore();
    }
  });

  it('does not leave a durable orphan-close alarm when persistence cannot prove ownership', async () => {
    const { chrome, tabs, groups, emitAlarm, sessionStorage } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    const created = await mod.__test__.handleTabs({
      id: '41',
      action: 'tabs',
      op: 'new',
      url: 'https://registered.example',
      workspace: 'site:twitter',
      carrier: 'tab-group-background',
      groupName: 'work',
    }, 'site:twitter');
    expect(created.ok).toBe(true);

    const defaultRemove = chrome.tabs.remove.getMockImplementation();
    expect(defaultRemove).toBeDefined();
    chrome.storage.session.set.mockImplementation(async (_items: Record<string, unknown>) => {
      throw new Error('storage offline');
    });
    chrome.tabs.remove.mockRejectedValue(new Error('temporary tab close failure'));

    await expect(mod.__test__.handleTabs({
      id: '42',
      action: 'tabs',
      op: 'new',
      url: 'https://alarm-close.example',
      workspace: 'site:zhihu',
      carrier: 'tab-group-background',
      groupName: 'work',
    }, 'site:zhihu')).rejects.toThrow('storage offline');

    const alarmCloseTab = tabs.find((tab) => tab.url === 'https://alarm-close.example');
    const groupId = groups.find((group) => group.title === 'AutoCLI-work')?.id;
    expect(alarmCloseTab?.id).toBeDefined();
    expect(groupId).toBeDefined();
    expect(chrome.alarms.create.mock.calls.some(([name]) =>
      typeof name === 'string' && name.startsWith('autocli-tab-group-orphan-tab:')
    )).toBe(false);

    chrome.tabs.remove.mockImplementation(defaultRemove!);
    expect(tabs.some((tab) => tab.id === alarmCloseTab!.id)).toBe(true);
    expect(groups.filter((group) => group.title === 'AutoCLI-work')).toHaveLength(1);
  });

  it('does not create an orphan-close alarm for an unpersisted seed tab', async () => {
    const { chrome, tabs, groups, emitAlarm } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    chrome.storage.session.set.mockRejectedValue(new Error('storage offline'));
    const defaultRemove = chrome.tabs.remove.getMockImplementation();
    expect(defaultRemove).toBeDefined();
    chrome.tabs.remove.mockRejectedValue(new Error('temporary tab close failure'));

    const mod = await import('./background');
    const result = await mod.__test__.handleCommand({
      id: '43',
      action: 'tabs',
      op: 'new',
      url: 'https://seed-alarm-close.example',
      workspace: 'site:twitter',
      carrier: 'tab-group-background',
      groupName: 'work',
    });
    expect(result.ok).toBe(false);

    const seedTab = tabs.find((tab) => tab.url === 'about:blank');
    const groupId = groups.find((group) => group.title === 'AutoCLI-work')?.id;
    expect(seedTab?.id).toBeDefined();
    expect(groupId).toBeDefined();
    expect(chrome.alarms.create.mock.calls.some(([name]) =>
      typeof name === 'string' && name.startsWith('autocli-tab-group-orphan-tab:')
    )).toBe(false);
    chrome.tabs.remove.mockImplementation(defaultRemove!);
    expect(tabs.some((tab) => tab.id === seedTab!.id)).toBe(true);
  });

  it('does not close an orphan alarm tab after Chrome moves it out of the expected group', async () => {
    const { chrome, tabs, groups, emitAlarm, sessionStorage } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    const created = await mod.__test__.handleTabs({
      id: '49',
      action: 'tabs',
      op: 'new',
      url: 'https://registered-for-reuse.example',
      workspace: 'site:twitter',
      carrier: 'tab-group-background',
      groupName: 'work',
    }, 'site:twitter');
    expect(created.ok).toBe(true);

    const defaultRemove = chrome.tabs.remove.getMockImplementation();
    expect(defaultRemove).toBeDefined();
    chrome.storage.session.set.mockImplementation(async (_items: Record<string, unknown>) => {
      throw new Error('storage offline');
    });
    chrome.tabs.remove.mockRejectedValue(new Error('temporary tab close failure'));

    await expect(mod.__test__.handleTabs({
      id: '50',
      action: 'tabs',
      op: 'new',
      url: 'https://reused-id.example',
      workspace: 'site:zhihu',
      carrier: 'tab-group-background',
      groupName: 'work',
    }, 'site:zhihu')).rejects.toThrow('storage offline');

    const orphanedTab = tabs.find((tab) => tab.url === 'https://reused-id.example');
    const groupId = groups.find((group) => group.title === 'AutoCLI-work')?.id;
    expect(orphanedTab?.id).toBeDefined();
    expect(groupId).toBeDefined();
    const stored = sessionStorage[`autocli.tabGroupSession.${encodeURIComponent('AutoCLI-work')}`] as {
      leaseId: string;
    };
    const orphanAlarm = `autocli-tab-group-orphan-tab:${encodeURIComponent('AutoCLI-work')}:${stored.leaseId}:${groupId}:${orphanedTab!.id}`;

    // A tab ID can be reused or moved before an alarm runs. The alarm must not
    // remove it unless it is still in the exact AutoCLI group it was created in.
    orphanedTab!.groupId = undefined;
    chrome.tabs.remove.mockImplementation(defaultRemove!);
    const removeCallCountBeforeAlarm = chrome.tabs.remove.mock.calls.length;
    await emitAlarm(orphanAlarm);

    expect(tabs.some((tab) => tab.id === orphanedTab!.id)).toBe(true);
    expect(chrome.tabs.remove).toHaveBeenCalledTimes(removeCallCountBeforeAlarm);
    expect(chrome.alarms.clear).toHaveBeenCalledWith(orphanAlarm);
  });

  it('refuses to choose among pre-existing duplicate tab groups without ownership metadata', async () => {
    const { chrome, tabs, groups } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    groups.push(
      { id: 100, title: 'AutoCLI-work', windowId: 2 },
      { id: 101, title: 'AutoCLI-work', windowId: 2 },
    );
    tabs.push(
      { id: 90, windowId: 2, groupId: 100, url: 'https://user-one.example', title: 'user one', active: false },
      { id: 91, windowId: 2, groupId: 101, url: 'https://user-two.example', title: 'user two', active: false },
    );

    const mod = await import('./background');
    const result = await mod.__test__.handleCommand({
      id: '44',
      action: 'tabs',
      op: 'new',
      url: 'https://should-not-create.example',
      workspace: 'site:twitter',
      carrier: 'tab-group-background',
      groupName: 'work',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('multiple open tab groups');
    expect(tabs.some((tab) => tab.url === 'https://should-not-create.example')).toBe(false);
    expect(groups.filter((group) => group.title === 'AutoCLI-work')).toHaveLength(2);
  });

  it('refuses a command when an owned session has an additional same-title group', async () => {
    const { chrome, tabs, groups, create } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    const created = await mod.__test__.handleCommand({
      id: '45',
      action: 'tabs',
      op: 'new',
      url: 'https://owned-session.example',
      workspace: 'site:twitter',
      carrier: 'tab-group-background',
      groupName: 'work',
    });
    expect(created.ok).toBe(true);

    groups.push({ id: 101, title: 'AutoCLI-work', windowId: 2 });
    tabs.push({
      id: 90,
      windowId: 2,
      groupId: 101,
      url: 'https://user-in-duplicate.example',
      title: 'user duplicate',
      active: false,
    });
    const createCountBeforeRejectedCommand = create.mock.calls.length;

    const result = await mod.__test__.handleCommand({
      id: '46',
      action: 'tabs',
      op: 'new',
      url: 'https://must-not-create.example',
      workspace: 'site:zhihu',
      carrier: 'tab-group-background',
      groupName: 'work',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('multiple open tab groups');
    expect(create).toHaveBeenCalledTimes(createCountBeforeRejectedCommand);
    expect(tabs.some((tab) => tab.url === 'https://must-not-create.example')).toBe(false);
    expect(tabs.some((tab) => tab.id === 90)).toBe(true);
    expect(groups.filter((group) => group.title === 'AutoCLI-work')).toHaveLength(2);
  });

  it('refuses list and close-window when an owned session has an additional same-title group', async () => {
    const { chrome, tabs, groups } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    const created = await mod.__test__.handleCommand({
      id: '46-list-setup',
      action: 'tabs',
      op: 'new',
      url: 'https://owned-session.example',
      workspace: 'site:twitter',
      carrier: 'tab-group-background',
      groupName: 'work',
    });
    expect(created.ok).toBe(true);

    groups.push({ id: 101, title: 'AutoCLI-work', windowId: 2 });
    tabs.push({
      id: 90,
      windowId: 2,
      groupId: 101,
      url: 'https://user-in-duplicate.example',
      title: 'user duplicate',
      active: false,
    });

    for (const command of [
      { id: '46-list', action: 'tabs' as const, op: 'list' as const },
      { id: '46-close', action: 'close-window' as const },
    ]) {
      const result = await mod.__test__.handleCommand({
        ...command,
        workspace: 'site:twitter',
        carrier: 'tab-group-background',
        groupName: 'work',
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain('multiple open tab groups');
    }
  });

  it('keeps a new session when idle cleanup is blocked deleting its persisted record', async () => {
    const { chrome, tabs, groups, emitAlarm, sessionStorage } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    const created = await mod.__test__.handleCommand({
      id: '47',
      action: 'tabs',
      op: 'new',
      url: 'https://old-session.example',
      workspace: 'site:twitter',
      carrier: 'tab-group-background',
      groupName: 'work',
      groupIdleTimeoutSeconds: 120,
    });
    expect(created.ok).toBe(true);

    const groupId = groups.find((group) => group.title === 'AutoCLI-work')?.id;
    const cleanupAlarm = chrome.alarms.create.mock.calls.find(([name]) =>
      typeof name === 'string' && name.startsWith('autocli-tab-group-cleanup:')
    );
    const storedSession = sessionStorage[`autocli.tabGroupSession.${encodeURIComponent('AutoCLI-work')}`] as {
      idleDeadlineAt: number;
    };
    expect(groupId).toBeDefined();
    expect(cleanupAlarm).toBeDefined();
    expect(storedSession).toBeDefined();

    // Keep the group live after AutoCLI's old tabs are closed, so cleanup reaches
    // the final persisted-session discard path rather than the missing-group path.
    tabs.push({ id: 91, windowId: 2, groupId, url: 'https://user-tab.example', title: 'user', active: false });

    const defaultStorageRemove = chrome.storage.session.remove.getMockImplementation();
    expect(defaultStorageRemove).toBeDefined();
    let storageRemoveStarted = false;
    let releaseStorageRemove: (() => void) | undefined;
    chrome.storage.session.remove.mockImplementation(async (keys: string | string[]) => {
      if (!storageRemoveStarted) {
        storageRemoveStarted = true;
        await new Promise<void>((resolve) => {
          releaseStorageRemove = resolve;
        });
      }
      return defaultStorageRemove!(keys);
    });

    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(storedSession.idleDeadlineAt + 1);
    try {
      await emitAlarm(cleanupAlarm![0]);
      await vi.waitFor(() => {
        expect(storageRemoveStarted).toBe(true);
      });

      const command = mod.__test__.handleCommand({
        id: '48',
        action: 'tabs',
        op: 'new',
        url: 'https://new-session.example',
        workspace: 'site:twitter',
        carrier: 'tab-group-background',
        groupName: 'work',
        groupIdleTimeoutSeconds: 120,
      });
      releaseStorageRemove!();

      const result = await command;
      expect(result.ok).toBe(true);
      const newTabId = (result.data as { tabId: number }).tabId;
      await vi.waitFor(() => {
        const stored = sessionStorage[`autocli.tabGroupSession.${encodeURIComponent('AutoCLI-work')}`] as {
          ownedTabIds: number[];
        } | undefined;
        expect(stored?.ownedTabIds).toContain(newTabId);
      });

      expect(groups.filter((group) => group.title === 'AutoCLI-work')).toHaveLength(1);
      expect(tabs.some((tab) => tab.id === newTabId)).toBe(true);
      expect(tabs.some((tab) => tab.id === 91)).toBe(true);
      expect(chrome.windows.create).not.toHaveBeenCalled();
    } finally {
      dateNow.mockRestore();
    }
  });

  it('defers idle cleanup until a long-running strict-background command releases its lease', async () => {
    const { chrome, tabs, groups, emitAlarm, sessionStorage } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const startedAt = 1_000_000;
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    let screenshotStarted = false;
    let releaseScreenshot: (() => void) | undefined;
    const executor = await import('./cdp');
    const screenshotSpy = vi.spyOn(executor, 'screenshot').mockImplementation(async () => {
      screenshotStarted = true;
      await new Promise<void>((resolve) => {
        releaseScreenshot = resolve;
      });
      return 'screenshot-data';
    });

    try {
      const mod = await import('./background');
      const created = await mod.__test__.handleCommand({
        id: '51',
        action: 'tabs',
        op: 'new',
        url: 'https://lease-target.example',
        workspace: 'site:twitter',
        carrier: 'tab-group-background',
        groupName: 'work',
        groupIdleTimeoutSeconds: 1,
      });
      expect(created.ok).toBe(true);

      const targetTabId = (created.data as { tabId: number }).tabId;
      const groupId = groups.find((group) => group.title === 'AutoCLI-work')?.id;
      const cleanupAlarm = chrome.alarms.create.mock.calls.find(([name]) =>
        typeof name === 'string' && name.startsWith('autocli-tab-group-cleanup:')
      );
      expect(groupId).toBeDefined();
      expect(cleanupAlarm).toBeDefined();
      tabs.push({ id: 92, windowId: 2, groupId, url: 'https://user-tab.example', title: 'user', active: false });

      const screenshot = mod.__test__.handleCommand({
        id: '52',
        action: 'screenshot',
        tabId: targetTabId,
        workspace: 'site:twitter',
        carrier: 'tab-group-background',
        groupName: 'work',
        groupIdleTimeoutSeconds: 1,
      });
      await vi.waitFor(() => {
        expect(screenshotStarted).toBe(true);
      });

      dateNow.mockReturnValue(startedAt + 1_001);
      await emitAlarm(cleanupAlarm![0]);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(tabs.some((tab) => tab.id === targetTabId)).toBe(true);
      expect(chrome.tabs.remove).not.toHaveBeenCalledWith(targetTabId);

      releaseScreenshot!();
      await expect(screenshot).resolves.toEqual({ id: '52', ok: true, data: 'screenshot-data' });

      await vi.waitFor(() => {
        expect(tabs.some((tab) => tab.id === 10)).toBe(false);
      });
      const renewedSession = sessionStorage[`autocli.tabGroupSession.${encodeURIComponent('AutoCLI-work')}`] as {
        idleDeadlineAt: number;
      };
      expect(renewedSession.idleDeadlineAt).toBe(startedAt + 2_001);

      dateNow.mockReturnValue(startedAt + 2_002);
      await emitAlarm(cleanupAlarm![0]);
      await vi.waitFor(() => {
        expect(tabs.some((tab) => tab.id === targetTabId)).toBe(false);
      });
      expect(tabs.some((tab) => tab.id === 92)).toBe(true);
    } finally {
      screenshotSpy.mockRestore();
      dateNow.mockRestore();
    }
  });

  it('prunes an externally closed owned tab from the title-only session immediately', async () => {
    const { chrome, tabs, groups, sessionStorage } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    const created = await mod.__test__.handleCommand({
      id: '53',
      action: 'tabs',
      op: 'new',
      url: 'https://closed-by-chrome.example',
      workspace: 'site:twitter',
      carrier: 'tab-group-background',
      groupName: 'work',
    });
    expect(created.ok).toBe(true);

    const closedTabId = (created.data as { tabId: number }).tabId;
    const groupId = groups.find((group) => group.title === 'AutoCLI-work')?.id;
    expect(groupId).toBeDefined();
    tabs.push({ id: 93, windowId: 2, groupId, url: 'https://user-tab.example', title: 'user', active: false });

    await chrome.tabs.remove(closedTabId);
    await vi.waitFor(() => {
      const stored = sessionStorage[`autocli.tabGroupSession.${encodeURIComponent('AutoCLI-work')}`] as {
        ownedTabIds: number[];
        workspaceTabIds: Array<[string, number]>;
      };
      expect(stored.ownedTabIds).not.toContain(closedTabId);
      expect(stored.workspaceTabIds).not.toContainEqual(['site:twitter', closedTabId]);
    });

    const listedFromAnotherWorkspace = await mod.__test__.handleCommand({
      id: '54',
      action: 'tabs',
      op: 'list',
      workspace: 'site:zhihu',
      carrier: 'tab-group-background',
      groupName: 'work',
    });
    expect(listedFromAnotherWorkspace.ok).toBe(true);
    expect(groups.filter((group) => group.title === 'AutoCLI-work')).toHaveLength(1);
    expect(tabs.some((tab) => tab.id === 93)).toBe(true);
  });
});
