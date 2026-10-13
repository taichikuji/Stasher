const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('bun:test');
const vm = require('node:vm');

const root = join(__dirname, '..');
const backgroundSource = readFileSync(
  join(root, 'src/background/service-worker.js'),
  'utf8'
);
const managerSource = readFileSync(
  join(root, 'src/manager/manager.js'),
  'utf8'
);

const clone = value => JSON.parse(JSON.stringify(value));

function eventSlot(listeners, name) {
  return {
    addListener(listener) {
      listeners[name] = listener;
    },
    removeListener(listener) {
      if (listeners[name] === listener) delete listeners[name];
    }
  };
}

function createLocks() {
  const queues = new Map();
  return {
    request(name, callback) {
      const pending = (queues.get(name) ?? Promise.resolve()).then(() => callback());
      const settled = pending.catch(() => {});
      queues.set(name, settled);
      settled.then(() => {
        if (queues.get(name) === settled) queues.delete(name);
      });
      return pending;
    }
  };
}

function createStorage(initial, options = {}) {
  const values = clone(initial);
  const subscribers = new Set();
  const writes = [];
  return {
    writes,
    locks: createLocks(),
    snapshot: () => clone(values),
    onChanged: {
      addListener: listener => subscribers.add(listener)
    },
    local: {
      async get(query) {
        const keys = typeof query === 'string' ? [query] : Array.isArray(query) ? query : Object.keys(query ?? values);
        if (options.failPreferenceGet && keys.includes('openOnStartup')) throw new Error('Storage read failed');
        if (keys.includes(options.failStorageGetKey)) throw new Error('Storage read failed');
        return clone(Object.fromEntries(keys.filter(key => key in values || (query && typeof query === 'object' && !Array.isArray(query)))
          .map(key => [key, key in values ? values[key] : query[key]])));
      },
      async set(update) {
        writes.push(clone(update));
        if (writes.length === options.failStorageSetAt) throw new Error('Storage update failed');
        const changes = {};
        for (const [key, value] of Object.entries(clone(update))) {
          changes[key] = { ...(key in values ? { oldValue: values[key] } : {}), newValue: value };
          values[key] = value;
        }
        for (const listener of subscribers) listener(clone(changes), 'local');
      },
      async remove(key) {
        const oldValue = values[key];
        delete values[key];
        for (const listener of subscribers) listener({ [key]: { oldValue } }, 'local');
      }
    }
  };
}

function runBackground(options = {}) {
  const listeners = {};
  const createdTabs = [];
  const updatedTabs = [];
  const removedTabs = [];
  const contextMenus = [];
  const errors = [];
  const storage = options.storage ?? createStorage({ stashedItems: options.items ?? [], ...options.preferences }, options);
  const sessionStorage = options.sessionStorage ?? createStorage({});
  storage.session = sessionStorage.local;
  const windows = options.windows ?? [{ id: 4, type: 'normal', focused: true, incognito: false }];
  const permissionRequests = [];
  let groupPermissionGranted = options.groupPermissionGranted !== false;
  let nextStashId = 1;

  const api = {
    runtime: {
      getURL: path => `chrome-extension://stasher/${path}`,
      onInstalled: eventSlot(listeners, 'installed'),
      onStartup: eventSlot(listeners, 'startup')
    },
    storage,
    windows: {
      getAll: async () => clone(windows.filter(w => w.type === 'normal')),
      onCreated: eventSlot(listeners, 'windowCreated')
    },
    action: {
      onClicked: eventSlot(listeners, 'actionClicked')
    },
    permissions: {
      request: async details => {
        permissionRequests.push(clone(details));
        if (options.permissionRequestGranted !== false) groupPermissionGranted = true;
        return groupPermissionGranted;
      }
    },
    contextMenus: {
      create: details => contextMenus.push(clone(details)),
      onClicked: eventSlot(listeners, 'contextMenuClicked')
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      get: async () => clone(options.group ?? {
        title: 'Work',
        color: 'blue'
      })
    },
    tabs: {
      query: async query => {
        if (query.highlighted) return clone(options.highlightedTabs ?? []);
        if (query.groupId === -1) return clone(options.looseTabs ?? []);
        if (query.groupId !== undefined) return clone((options.groupedTabs ?? [])
          .filter(tab => tab.groupId === undefined || tab.groupId === query.groupId));
        if (query.windowId !== undefined) return clone((options.windowTabs ?? []).filter(tab => tab.windowId === undefined || tab.windowId === query.windowId));
        if (query.windowType) return clone((options.windowTabs ?? []).filter(tab =>
          windows.some(window => window.id === tab.windowId && window.type === query.windowType)));
        return clone(options.windowTabs ?? []);
      },
      create: async details => {
        const tab = { id: 100 + createdTabs.length, ...clone(details) };
        createdTabs.push(tab);
        return tab;
      },
      update: async (id, details) => {
        const tab = { id, ...clone(details) };
        updatedTabs.push(tab);
        return tab;
      },
      remove: async ids => {
        removedTabs.push(...ids);
      }
    }
  };

  const context = vm.createContext({
    chrome: api,
    console: { error: (...args) => errors.push(args) },
    crypto: { randomUUID: () => nextStashId++ === 1 ? 'stash-id' : `stash-id-${nextStashId - 1}` },
    navigator: { locks: storage.locks },
    URL
  });
  vm.runInContext(backgroundSource, context);

  return {
    context,
    storage,
    listeners,
    createdTabs,
    updatedTabs,
    removedTabs,
    contextMenus,
    errors,
    permissionRequests,
    windows,
    sessionStorage,
    getItems: () => storage.snapshot().stashedItems
  };
}

function createElement(initialClasses = []) {
  const classes = new Set(initialClasses);
  const listeners = new Map();
  const element = {
    value: '',
    children: [],
    append(...children) {
      this.children.push(...children);
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    replaceChildren(...children) {
      this.children = children;
    },
    addEventListener(type, listener) {
      const handlers = listeners.get(type) ?? [];
      handlers.push(listener);
      listeners.set(type, handlers);
    },
    async trigger(type, event = {}) {
      await Promise.all((listeners.get(type) ?? []).map(listener => listener({ type, target: this, ...event })));
    },
    setAttribute() {},
    focus() { this.focused = true; },
    showModal() { this.open = true; },
    popoverOpen: false,
    showPopover() { this.popoverOpen = true; },
    hidePopover() { this.popoverOpen = false; },
    closest: () => null,
    style: {},
    classList: {
      add: (...names) => names.forEach(name => classes.add(name)),
      contains: name => classes.has(name),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      toggle(name) {
        if (classes.has(name)) {
          classes.delete(name);
          return false;
        }
        classes.add(name);
        return true;
      }
    }
  };
  Object.defineProperty(element, 'innerHTML', {
    get() { return ''; },
    set() { element.children = []; }
  });
  return element;
}

function runManager(initialItems, options = {}) {
  const documentListeners = {};
  const createdTabs = [];
  const createdWindows = [];
  const errors = [];
  const groupedTabs = [];
  const updatedGroups = [];
  const tabs = new Map();
  const storage = options.storage ?? createStorage({ stashedItems: initialItems, ...options.preferences }, options);
  let nextTabId = 20;
  let nextImportId = 1;
  const elements = new Map();
  const timers = new Map();
  let time = 0;
  let nextTimer = 1;

  const api = {
    runtime: {
      getURL: path => `chrome-extension://stasher/${path}`
    },
    storage,
    windows: {
      create: async details => {
        if (options.failWindowCreation) throw new Error('Window creation failed');
        const opened = (Array.isArray(details.url) ? details.url : [details.url]).map(url => ({ id: nextTabId++, url, windowId: 7 }));
        opened.forEach(tab => tabs.set(tab.id, tab));
        const window = { id: 7, tabs: opened, ...clone(details) };
        createdWindows.push(window);
        if (options.missingWindowTabs) delete window.tabs;
        return clone(window);
      }
    },
    permissions: {
      contains: async () => options.groupPermissionGranted !== false
    },
    tabs: {
      create: async details => {
        if (options.failTabCreation) throw new Error('Tab creation failed');
        const tab = { id: nextTabId++, ...clone(details) };
        createdTabs.push(tab);
        const current = { ...tab, groupId: -1, discarded: false, title: `Restored ${details.url}` };
        if (options.pendingNavigation) Object.assign(current, { url: 'about:blank', pendingUrl: details.url, title: '' });
        tabs.set(tab.id, current);
        return clone(current);
      },
      group: async details => {
        if (options.failTabGrouping) throw new Error('Tab grouping failed');
        groupedTabs.push(clone(details));
        for (const id of details.tabIds) {
          tabs.get(id).groupId = 8;
          tabs.get(id).windowId = details.createProperties?.windowId ?? 4;
        }
        return 8;
      }
    },
    tabGroups: {
      update: async (id, details) => {
        if (options.failGroupUpdate) throw new Error('Group update failed');
        updatedGroups.push([id, clone(details)]);
      }
    }
  };

  const document = {
    addEventListener(name, listener) {
      documentListeners[name] = listener;
    },
    getElementById(id) {
      if (!elements.has(id)) {
        const element = createElement();
        element.hidden = id === 'notification-undo';
        elements.set(id, element);
      }
      return elements.get(id);
    },
    createElement,
    createTextNode: text => ({ textContent: text }),
    querySelector: () => null
  };

  const sessionValues = new Map();
  const context = vm.createContext({
    chrome: api,
    Blob,
    File,
    URL,
    clearTimeout: id => timers.delete(id),
    console: { error: (...args) => errors.push(args) },
    crypto: { randomUUID: () => `import-id-${nextImportId++}` },
    document,
    navigator: { locks: storage.locks },
    sessionStorage: {
      getItem: key => sessionValues.get(key) ?? null,
      setItem: (key, value) => sessionValues.set(key, value),
      removeItem: key => sessionValues.delete(key)
    },
    setTimeout(callback, delay) {
      const id = nextTimer++;
      timers.set(id, { callback, at: time + delay });
      return id;
    },
    structuredClone
  });
  vm.runInContext(managerSource, context);

  return {
    context,
    createdTabs,
    createdWindows,
    errors,
    groupedTabs,
    updatedGroups,
    getTab: id => clone(tabs.get(id)),
    storage,
    async advanceTime(milliseconds) {
      const end = time + milliseconds;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        const [id, timer] = next;
        timers.delete(id);
        time = timer.at;
        await timer.callback();
      }
      time = end;
    },
    getElement: id => elements.get(id),
    triggerDocumentEvent: (name, event) => documentListeners[name](event),
    getItems: () => storage.snapshot().stashedItems
  };
}

test('stashes a tab group through the Chromium extension API', async () => {
  const result = runBackground({
    groupedTabs: [
      { id: 11, title: 'One', url: 'https://one.example', windowId: 4, groupId: 7 },
      { id: 12, title: 'Two', url: 'https://two.example', windowId: 4, groupId: 7 }
    ]
  });

  await result.listeners.actionClicked({
    id: 11,
    title: 'One',
    url: 'https://one.example',
    windowId: 4,
    groupId: 7
  });

  assert.deepEqual(result.getItems(), [{
    id: 'stash-id',
    timestamp: result.getItems()[0].timestamp,
    type: 'group',
    title: 'Work',
    color: 'blue',
    tabs: [
      { title: 'One', url: 'https://one.example' },
      { title: 'Two', url: 'https://two.example' }
    ]
  }]);
  assert.equal(Object.hasOwn(result.getItems()[0].tabs[0], 'favIconUrl'), false);
  assert.deepEqual(result.removedTabs, [11, 12]);
  assert.deepEqual(result.createdTabs, [{
    id: 100,
    url: 'chrome-extension://stasher/src/manager/manager.html',
    windowId: 4,
    index: 0,
    pinned: true,
    active: true
  }]);
});

test('stashes all grouped tabs without tab group access', async () => {
  const result = runBackground({
    groupPermissionGranted: false,
    permissionRequestGranted: false,
    groupedTabs: [
      { id: 11, title: 'One', url: 'https://one.example', windowId: 4, groupId: 7 },
      { id: 12, title: 'Two', url: 'https://two.example', windowId: 4, groupId: 7 }
    ]
  });

  await result.listeners.actionClicked({ id: 11, windowId: 4, groupId: 7 });

  assert.equal(result.getItems()[0].type, 'loose');
  assert.deepEqual(result.getItems()[0].tabs.map(tab => tab.url), [
    'https://one.example', 'https://two.example'
  ]);
  assert.deepEqual(result.removedTabs, [11, 12]);
  assert.deepEqual(result.permissionRequests, [{ permissions: ['tabGroups'] }]);

  await result.listeners.actionClicked({ id: 11, windowId: 4, groupId: 7 });
  assert.deepEqual(result.permissionRequests, [
    { permissions: ['tabGroups'] },
    { permissions: ['tabGroups'] }
  ]);
  assert.equal(result.getItems()[0].type, 'loose');
});

test('renders a browser-cached favicon with a letter fallback', () => {
  const result = runManager([]);
  const linkItem = vm.runInContext(
    "createTabListItem({ title: 'Example', url: 'https://example.com/docs' }, 'stash', 0)",
    result.context
  );
  const [icon] = linkItem.children;
  const [favicon] = icon.children;

  assert.equal(icon.classList.contains('link-icon-fallback'), false);
  assert.equal(
    favicon.src,
    'chrome-extension://stasher/_favicon/?pageUrl=https%3A%2F%2Fexample.com%2Fdocs&size=32'
  );

  favicon.onerror();
  assert.equal(icon.children.length, 0);
  assert.equal(icon.classList.contains('link-icon-fallback'), true);
  assert.equal(icon.textContent, 'E');
});

test('registers the tab menu and stashes exactly the right-clicked tab', async () => {
  const result = runBackground();
  const tab = {
    id: 51,
    title: 'Pinned page',
    url: 'https://pinned.example',
    windowId: 4,
    groupId: 7,
    pinned: true
  };

  result.listeners.installed();
  await result.listeners.contextMenuClicked({ menuItemId: 'stash-tab' }, tab);

  assert.deepEqual(result.contextMenus, [{
    id: 'stash-tab',
    title: 'Stash this tab',
    contexts: ['tab'],
    documentUrlPatterns: ['http://*/*', 'https://*/*']
  }]);
  assert.equal(result.getItems()[0].type, 'loose');
  assert.equal('title' in result.getItems()[0], false);
  assert.equal('color' in result.getItems()[0], false);
  assert.deepEqual(result.getItems()[0].tabs, [{
    title: 'Pinned page',
    url: 'https://pinned.example'
  }]);
  assert.deepEqual(result.removedTabs, [51]);
  assert.deepEqual(result.permissionRequests, []);
});

test('stashes eligible loose tabs through the toolbar action', async () => {
  const managerUrl = 'chrome-extension://stasher/src/manager/manager.html';
  const result = runBackground({
    looseTabs: [
      { id: 21, title: 'One', url: 'https://one.example' },
      { id: 22, title: 'Two', url: 'http://two.example' },
      { id: 23, title: 'Pinned', url: 'https://pinned.example', pinned: true },
      { id: 24, title: 'Manager', url: managerUrl },
      { id: 25, title: 'New tab', url: 'chrome://newtab/' },
      { id: 26, title: 'Blank', url: 'about:blank' },
      { id: 27, title: 'Unsupported', url: 'ftp://files.example' }
    ],
    windowTabs: [{ id: 90, url: managerUrl, pinned: true }]
  });

  await result.listeners.actionClicked({
    id: 21,
    windowId: 4,
    groupId: -1,
    url: 'https://one.example'
  });

  assert.deepEqual(result.getItems()[0].tabs, [
    { title: 'One', url: 'https://one.example' },
    { title: 'Two', url: 'http://two.example' }
  ]);
  assert.deepEqual(result.removedTabs, [21, 22]);
  assert.deepEqual(result.createdTabs, []);
  assert.deepEqual(result.updatedTabs, [{ id: 90, active: true, pinned: true }]);
});

test('stashes only highlighted tabs and preserves a shared tab group', async () => {
  const result = runBackground({
    highlightedTabs: [
      { id: 31, title: 'One', url: 'https://one.example', groupId: 7 },
      { id: 32, title: 'Two', url: 'https://two.example', groupId: 7 }
    ]
  });

  await result.listeners.actionClicked({ windowId: 4, groupId: 7 });

  assert.equal(result.getItems()[0].type, 'group');
  assert.equal(result.getItems()[0].title, 'Work');
  assert.equal(result.getItems()[0].color, 'blue');
  assert.deepEqual(result.getItems()[0].tabs, [
    { title: 'One', url: 'https://one.example' },
    { title: 'Two', url: 'https://two.example' }
  ]);
  assert.deepEqual(result.removedTabs, [31, 32]);
});

test('stashes an eligible mixed selection as ungrouped without closing excluded tabs', async () => {
  const result = runBackground({
    highlightedTabs: [
      { id: 41, title: 'Grouped', url: 'https://grouped.example', groupId: 7 },
      { id: 42, title: 'Loose', url: 'https://loose.example', groupId: -1 },
      { id: 43, title: 'Pinned', url: 'https://pinned.example', groupId: -1, pinned: true },
      { id: 44, title: 'Internal', url: 'chrome://settings/', groupId: -1 }
    ]
  });

  await result.listeners.actionClicked({ windowId: 4, groupId: -1 });

  assert.equal(result.getItems()[0].type, 'loose');
  assert.equal('title' in result.getItems()[0], false);
  assert.equal('color' in result.getItems()[0], false);
  assert.deepEqual(result.getItems()[0].tabs, [
    { title: 'Grouped', url: 'https://grouped.example' },
    { title: 'Loose', url: 'https://loose.example' }
  ]);
  assert.deepEqual(result.removedTabs, [41, 42]);
});

test('stashing allows existing and incoming duplicates when the preference is missing, false or invalid', async () => {
  const saved = { id: 'saved', tabs: [{ title: 'Saved title', url: 'https://one.example' }] };
  const incoming = [
    { id: 11, title: 'First title', url: 'https://one.example' },
    { id: 12, title: 'Second title', url: 'https://one.example' }
  ];
  for (const preferences of [{}, { skipDuplicates: false }, { skipDuplicates: 'true' }, { skipDuplicates: 1 }, { skipDuplicates: null }]) {
    const result = runBackground({ items: [saved], looseTabs: incoming, preferences });
    await result.listeners.actionClicked({ windowId: 4, groupId: -1 });
    assert.deepEqual(result.getItems()[0].tabs, incoming.map(({ title, url }) => ({ title, url })));
    assert.deepEqual(result.getItems().slice(1), [saved]);
    assert.deepEqual(result.removedTabs, [11, 12]);
    assert.equal(result.storage.writes.length, 1);
    assert.deepEqual(Object.keys(result.storage.writes[0]), ['stashedItems']);
  }
});

test('skips URLs across all saved stashes and within a new group while preserving order and metadata', async () => {
  const saved = [
    { id: 'project', type: 'group', title: 'Different project', color: 'red', timestamp: '2026-01-01', tabs: [
      { title: 'Custom title', url: 'https://one.example' },
      { title: 'Intentional existing duplicate', url: 'https://one.example' }
    ] },
    { id: 'loose', type: 'loose', tabs: [{ title: 'Saved loose tab', url: 'https://two.example' }] }
  ];
  const result = runBackground({ items: saved, preferences: { skipDuplicates: true }, groupedTabs: [
    { id: 11, title: 'New title', url: 'https://one.example' },
    { id: 12, title: 'First new tab', url: 'https://new.example' },
    { id: 13, title: 'New loose title', url: 'https://two.example' },
    { id: 14, title: 'Repeated new tab', url: 'https://new.example' },
    { id: 15, title: 'Custom title', url: 'https://last.example' }
  ] });
  await result.listeners.actionClicked({ windowId: 4, groupId: 7 });
  const [newStash, ...existing] = result.getItems();
  assert.deepEqual(newStash.tabs, [
    { title: 'First new tab', url: 'https://new.example' },
    { title: 'Custom title', url: 'https://last.example' }
  ]);
  assert.equal(newStash.type, 'group');
  assert.equal(newStash.title, 'Work');
  assert.equal(newStash.color, 'blue');
  assert.deepEqual(existing, saved);
  assert.deepEqual(result.removedTabs, [11, 12, 13, 14, 15]);
  assert.deepEqual(Object.keys(result.storage.writes[0]), ['stashedItems']);
  assert.equal(result.storage.snapshot().skipDuplicates, true);
});

for (const mode of ['loose', 'group', 'selected group', 'mixed selection', 'group without access', 'right-click']) {
  test(`skips duplicate URLs when stashing through ${mode}`, async () => {
    const saved = { id: 'saved', type: 'loose', tabs: [{ title: 'Saved', url: 'https://saved.example' }] };
    const tabs = [
      { id: 11, title: 'Duplicate', url: 'https://saved.example', groupId: 7 },
      { id: 12, title: 'New', url: 'https://new.example', groupId: mode === 'mixed selection' ? -1 : 7 }
    ];
    const result = runBackground({
      items: [saved], preferences: { skipDuplicates: true },
      looseTabs: tabs, groupedTabs: tabs,
      highlightedTabs: mode.includes('selection') || mode === 'selected group' ? tabs : [],
      groupPermissionGranted: mode !== 'group without access',
      permissionRequestGranted: mode !== 'group without access'
    });
    if (mode === 'right-click') {
      await result.listeners.contextMenuClicked({ menuItemId: 'stash-tab' }, { ...tabs[0], windowId: 4, pinned: true });
      assert.deepEqual(result.getItems(), [saved]);
      assert.deepEqual(result.removedTabs, [11]);
      assert.deepEqual(result.permissionRequests, []);
      assert.deepEqual(result.storage.writes, []);
    } else {
      await result.listeners.actionClicked({ windowId: 4, groupId: mode === 'loose' ? -1 : 7 });
      assert.deepEqual(result.getItems()[0].tabs, [{ title: 'New', url: 'https://new.example' }]);
      assert.equal(result.getItems()[0].type, ['loose', 'mixed selection', 'group without access'].includes(mode) ? 'loose' : 'group');
      assert.deepEqual(result.getItems().slice(1), [saved]);
      assert.deepEqual(result.removedTabs, [11, 12]);
    }
    assert.equal(result.createdTabs.length, 1);
  });
}

test('an entirely duplicated stash closes eligible tabs and focuses the manager without writing storage', async () => {
  const managerUrl = 'chrome-extension://stasher/src/manager/manager.html';
  const saved = { id: 'saved', tabs: [{ title: 'Saved', url: 'https://one.example' }] };
  const result = runBackground({ items: [saved], preferences: { skipDuplicates: true }, looseTabs: [
    { id: 11, title: 'Duplicate', url: 'https://one.example' },
    { id: 12, title: 'Another duplicate', url: 'https://one.example' },
    { id: 13, title: 'Pinned duplicate', url: 'https://one.example', pinned: true },
    { id: 14, url: 'about:blank' },
    { id: 15, url: managerUrl }
  ], windowTabs: [{ id: 90, url: managerUrl }] });
  await result.listeners.actionClicked({ windowId: 4, groupId: -1 });
  assert.deepEqual(result.getItems(), [saved]);
  assert.deepEqual(result.storage.writes, []);
  assert.deepEqual(result.removedTabs, [11, 12]);
  assert.deepEqual(result.createdTabs, []);
  assert.deepEqual(result.updatedTabs, [{ id: 90, active: true, pinned: true }]);
});

test('duplicate checks compare exact URLs, including queries, fragments, protocols, paths and trailing slashes', async () => {
  const saved = { id: 'saved', tabs: [
    { title: 'Page', url: 'https://site.example/path?q=1#first' },
    { title: 'Root', url: 'https://site.example' }
  ] };
  const distinct = [
    'https://site.example/path?q=2#first',
    'https://site.example/path?q=1#second',
    'http://site.example/path?q=1#first',
    'https://site.example/other?q=1#first',
    'https://site.example/'
  ];
  const urls = [saved.tabs[0].url, ...distinct, saved.tabs[1].url];
  const result = runBackground({ items: [saved], preferences: { skipDuplicates: true },
    looseTabs: urls.map((url, index) => ({ id: 11 + index, url, title: 'Same title' })) });
  await result.listeners.actionClicked({ windowId: 4, groupId: -1 });
  assert.deepEqual(result.getItems()[0].tabs.map(tab => tab.url), distinct);
  assert.deepEqual(result.removedTabs, urls.map((_, index) => 11 + index));
});

test('stashing reads the current duplicate preference without restarting the service worker', async () => {
  const result = runBackground({ looseTabs: [{ id: 11, title: 'Page', url: 'https://one.example' }] });
  await result.listeners.actionClicked({ windowId: 4, groupId: -1 });
  const saved = result.getItems();
  await result.storage.local.set({ skipDuplicates: true });
  const writes = result.storage.writes.length;
  await result.listeners.actionClicked({ windowId: 4, groupId: -1 });
  assert.deepEqual(result.getItems(), saved);
  assert.equal(result.storage.writes.length, writes);
  await result.storage.local.set({ skipDuplicates: false });
  await result.listeners.actionClicked({ windowId: 4, groupId: -1 });
  assert.equal(result.getItems().length, 2);
  assert.deepEqual(result.removedTabs, [11, 11, 11]);
});

test('storage read and save failures keep all selected tabs open, including duplicates', async () => {
  const saved = { id: 'saved', tabs: [{ title: 'Saved', url: 'https://saved.example' }] };
  for (const failure of [{ failStorageGetKey: 'skipDuplicates' }, { failStorageGetKey: 'stashedItems' }, { failStorageSetAt: 1 }]) {
    const result = runBackground({ ...failure, items: [saved], preferences: { skipDuplicates: true }, looseTabs: [
      { id: 11, title: 'Duplicate', url: 'https://saved.example' },
      { id: 12, title: 'New', url: 'https://new.example' }
    ] });
    await result.listeners.actionClicked({ windowId: 4, groupId: -1 });
    assert.deepEqual(result.getItems(), [saved]);
    assert.deepEqual(result.removedTabs, []);
    assert.equal(result.createdTabs.length, 1);
    assert.equal(result.errors.length, 1);
  }
});

test('concurrent stashing contexts serialize duplicate checks and wait for persistence before closing tabs', async () => {
  const storage = createStorage({ stashedItems: [], skipDuplicates: true });
  const first = runBackground({ storage });
  const second = runBackground({ storage });
  const get = storage.local.get;
  const set = storage.local.set;
  let reads = 0;
  let release;
  let started;
  const writing = new Promise(resolve => { started = resolve; });
  storage.local.get = async query => { reads++; return get(query); };
  storage.local.set = async update => {
    started();
    await new Promise(resolve => { release = resolve; });
    return set(update);
  };
  const tab = { id: 11, title: 'First', url: 'https://same.example', windowId: 4, groupId: -1 };
  const firstStash = first.listeners.contextMenuClicked({ menuItemId: 'stash-tab' }, tab);
  await writing;
  const secondStash = second.listeners.contextMenuClicked({ menuItemId: 'stash-tab' }, { ...tab, id: 12, title: 'Second' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  assert.deepEqual(first.removedTabs, []);
  assert.deepEqual(second.removedTabs, []);
  release();
  await Promise.all([firstStash, secondStash]);
  assert.equal(reads, 2);
  assert.equal(storage.writes.length, 1);
  assert.equal(first.getItems().length, 1);
  assert.deepEqual(first.getItems()[0].tabs, [{ title: 'First', url: tab.url }]);
  assert.deepEqual(first.removedTabs, [11]);
  assert.deepEqual(second.removedTabs, [12]);
});

test('a failed stash write releases the shared lock so the next action can save its copy', async () => {
  const storage = createStorage({ stashedItems: [], skipDuplicates: true }, { failStorageSetAt: 1 });
  const first = runBackground({ storage });
  const second = runBackground({ storage });
  const tab = { id: 11, title: 'First', url: 'https://same.example', windowId: 4, groupId: -1 };
  await Promise.all([
    first.listeners.contextMenuClicked({ menuItemId: 'stash-tab' }, tab),
    second.listeners.contextMenuClicked({ menuItemId: 'stash-tab' }, { ...tab, id: 12, title: 'Second' })
  ]);
  assert.equal(storage.writes.length, 2);
  assert.deepEqual(first.removedTabs, []);
  assert.deepEqual(second.removedTabs, [12]);
  assert.deepEqual(second.getItems()[0].tabs, [{ title: 'Second', url: tab.url }]);
});

test('undoes explicit stash deletion through the Chromium extension API', async () => {
  const stash = {
    id: 'delete-me',
    title: 'Delete me',
    tabs: [{ title: 'One', url: 'https://one.example' }]
  };
  const result = runManager([stash]);

  await vm.runInContext("deleteStash('delete-me')", result.context);

  assert.deepEqual(result.getItems(), []);
  assert.equal(result.getElement('notification').popoverOpen, true);

  await vm.runInContext('handleUndo()', result.context);

  assert.deepEqual(result.getItems(), [stash]);
  assert.equal(result.getElement('notification').popoverOpen, false);
});

test('undoes individual-tab deletion through the Chromium extension API', async () => {
  const stash = {
    id: 'trim-me',
    title: 'Trim me',
    tabs: [
      { title: 'One', url: 'https://one.example' },
      { title: 'Two', url: 'https://two.example' }
    ]
  };
  const result = runManager([stash]);

  await vm.runInContext("removeTabFromStash('trim-me', 0)", result.context);

  assert.deepEqual(result.getItems()[0].tabs, [stash.tabs[1]]);
  assert.equal(result.getElement('notification').popoverOpen, true);

  await vm.runInContext('handleUndo()', result.context);

  assert.deepEqual(result.getItems(), [stash]);
  assert.equal(result.getElement('notification').popoverOpen, false);
});

test('restores a tab group through the Chromium extension API', async () => {
  const stash = {
    id: 'restore-me',
    timestamp: '2026-07-27T00:00:00.000Z',
    type: 'group',
    title: 'Restored',
    color: 'purple',
    tabs: [
      { title: 'One', url: 'https://one.example' },
      { title: 'Two', url: 'https://two.example' }
    ]
  };
  const result = runManager([stash]);

  await vm.runInContext(`restoreGroup(${JSON.stringify(stash)})`, result.context);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(
    result.createdTabs.map(({ id, ...tab }) => tab),
    [
      { url: 'https://one.example', active: false },
      { url: 'https://two.example', active: false }
    ]
  );
  assert.deepEqual(result.groupedTabs, [{ tabIds: [20, 21] }]);
  assert.deepEqual(result.updatedGroups, [[8, {
    title: 'Restored',
    color: 'purple',
    collapsed: false
  }]]);
  assert.deepEqual(result.getItems(), []);
  assert.equal(result.getElement('notification').popoverOpen, true);
  assert.equal(result.getElement('notification-undo').hidden, true);
  assert.match(result.getElement('notification-message').textContent, /Restored your tabs/);

  await vm.runInContext('handleUndo()', result.context);

  assert.deepEqual(result.getItems(), []);
});

test('restores saved groups as ordinary tabs without access and never prompts automatically', async () => {
  const stash = {
    id: 'restore-without-access', type: 'group', title: 'Saved group', color: 'blue',
    tabs: [{ title: 'One', url: 'https://one.example' }]
  };
  const result = runManager([stash], { groupPermissionGranted: false });

  await vm.runInContext(`restoreGroup(${JSON.stringify(stash)})`, result.context);

  assert.equal(result.createdTabs.length, 1);
  assert.deepEqual(result.groupedTabs, []);
  assert.deepEqual(result.updatedGroups, []);
  assert.deepEqual(result.getItems(), []);
});

test('restores a stash when its title is double-clicked', async () => {
  const stash = {
    id: 'double-click-me',
    type: 'group',
    title: 'Double-click me',
    color: 'blue',
    tabs: [{ title: 'One', url: 'https://one.example' }]
  };
  const result = runManager([stash]);
  const header = createElement();

  result.context.header = header;
  result.context.stash = stash;
  vm.runInContext('renderViewMode(header, stash)', result.context);
  const title = header.children.find(child => child.className.includes('group-badge'));
  await title.trigger('dblclick');

  assert.deepEqual(result.createdTabs.map(({ id, ...tab }) => tab), [
    { url: 'https://one.example', active: false }
  ]);
  assert.deepEqual(result.getItems(), []);
});

test('restores legacy pinned metadata as ordinary tabs', async () => {
  const stash = {
    id: 'restore-pinned',
    type: 'loose',
    tabs: [
      { title: 'Pinned', url: 'https://pinned.example', pinned: true },
      { title: 'Legacy', url: 'https://legacy.example' }
    ]
  };
  const result = runManager([stash]);

  await vm.runInContext(`restoreGroup(${JSON.stringify(stash)})`, result.context);

  assert.deepEqual(result.createdTabs.map(({ id, ...tab }) => tab), [
    { url: 'https://pinned.example', active: false },
    { url: 'https://legacy.example', active: false }
  ]);
  assert.deepEqual(result.getItems(), []);
});

test('keeps a stash when restoration fails before cleanup', async () => {
  const stash = {
    id: 'keep-me',
    type: 'group',
    title: 'Keep me',
    color: 'blue',
    tabs: [{ title: 'One', url: 'https://one.example' }]
  };

  for (const keepAfterRestore of [false, true]) {
    for (const failure of ['failTabCreation', 'failTabGrouping', 'failGroupUpdate']) {
      const result = runManager([stash], { [failure]: true, preferences: { keepAfterRestore } });

      await vm.runInContext(`restoreGroup(${JSON.stringify(stash)})`, result.context);

      assert.deepEqual(result.getItems(), [stash]);
      assert.equal(result.errors.length, 1);
    }
  }
});

test('suppresses concurrent restores of the same stash', async () => {
  const stash = {
    id: 'restore-once',
    type: 'loose',
    tabs: [{ title: 'One', url: 'https://one.example' }]
  };
  const result = runManager([stash]);

  await Promise.all([
    vm.runInContext(`restoreGroup(${JSON.stringify(stash)})`, result.context),
    vm.runInContext(`restoreGroup(${JSON.stringify(stash)})`, result.context)
  ]);

  assert.equal(result.createdTabs.length, 1);
  assert.deepEqual(result.getItems(), []);
});

test('a restore keeps its guard while tab creation is pending, even when another creation fails', async () => {
  const stash = { id: 'partial-restore', type: 'loose', tabs: [
    { title: 'One', url: 'https://one.example' },
    { title: 'Two', url: 'https://two.example' }
  ] };
  const result = runManager([stash]);
  const create = result.context.chrome.tabs.create;
  let release;
  let calls = 0;
  result.context.chrome.tabs.create = async details => {
    if (++calls > 1) throw new Error('Tab creation failed');
    await new Promise(resolve => { release = resolve; });
    return create(details);
  };
  const restoring = vm.runInContext(`restoreGroup(${JSON.stringify(stash)})`, result.context);
  await new Promise(setImmediate);
  const callsBeforeRetry = calls;
  await vm.runInContext(`restoreGroup(${JSON.stringify(stash)})`, result.context);
  assert.equal(calls, callsBeforeRetry);
  release();
  await restoring;
  assert.equal(result.createdTabs.length, 1);
  assert.deepEqual(result.getItems(), [stash]);
  assert.match(result.getElement('notification-message').textContent, /Tabs were opened.*kept/);
});

test('reports cleanup failure and retains the restored stash', async () => {
  const stash = {
    id: 'cleanup-fails',
    type: 'loose',
    tabs: [{ title: 'One', url: 'https://one.example' }]
  };
  const result = runManager([stash], { failStorageSetAt: 1 });

  await vm.runInContext(`restoreGroup(${JSON.stringify(stash)})`, result.context);

  assert.equal(result.createdTabs.length, 1);
  assert.deepEqual(result.getItems(), [stash]);
  assert.equal(result.getElement('notification').popoverOpen, true);
  assert.match(result.getElement('notification-message').textContent, /kept to avoid data loss/i);
});

const preferenceKeys = ['openOnStartup', 'keepAfterRestore', 'restoreInNewWindow', 'skipDuplicates', 'editOnDoubleClick'];
const settingsStash = {
  id: 'settings-stash', type: 'group', title: 'Settings test', color: 'blue',
  tabs: [{ title: 'One', url: 'https://one.example' }, { title: 'Two', url: 'https://two.example' }]
};

test('settings default off for missing or invalid values without writing defaults', async () => {
  for (const preferences of [{}, Object.fromEntries(preferenceKeys.map(key => [key, 'true']))]) {
    const result = runManager([settingsStash], { preferences });
    await result.getElement('settingsBtn').onclick();
    for (const key of preferenceKeys) {
      assert.equal(result.getElement(key).checked, false);
      assert.equal(result.getElement(key).disabled, false);
    }
    assert.deepEqual(result.storage.writes, []);
    assert.deepEqual(result.getItems(), [settingsStash]);
  }
});

test('each switch saves only its preference and survives reopening', async () => {
  const result = runManager([settingsStash]);
  await result.getElement('settingsBtn').onclick();
  for (const key of preferenceKeys) {
    const input = result.getElement(key);
    input.checked = true;
    await input.trigger('change');
    assert.deepEqual(result.storage.writes.at(-1), { [key]: true });
    assert.equal(input.disabled, false);
  }
  const reopened = runManager([], { storage: result.storage });
  await reopened.getElement('settingsBtn').onclick();
  for (const key of preferenceKeys) assert.equal(reopened.getElement(key).checked, true);
  assert.deepEqual(reopened.getItems(), [settingsStash]);
});

test('a failed preference save reverts the switch and exposes an inline error', async () => {
  for (const key of preferenceKeys) {
    const result = runManager([], { preferences: { [key]: true }, failStorageSetAt: 1 });
    await result.getElement('settingsBtn').onclick();
    const input = result.getElement(key);
    input.checked = false;
    await input.trigger('change');
    assert.equal(input.checked, true);
    assert.equal(input.disabled, false);
    assert.equal(result.storage.snapshot()[key], true);
    assert.equal(result.getElement('settings-error').hidden, false);
    assert.match(result.getElement('settings-error').textContent, /previous value was restored/);
    input.checked = false;
    await input.trigger('change');
    assert.equal(result.storage.snapshot()[key], false);
    assert.equal(result.getElement('settings-error').hidden, true);
  }
});

test('settings read failure leaves controls disabled and prevents restoration', async () => {
  for (const failure of [{ failPreferenceGet: true }, { failStorageGetKey: 'skipDuplicates' }]) {
    const result = runManager([settingsStash], failure);
    await result.getElement('settingsBtn').onclick();
    for (const key of preferenceKeys) assert.equal(result.getElement(key).disabled, true);
    assert.equal(result.getElement('settings-error').hidden, false);
    await vm.runInContext(`restoreGroup(${JSON.stringify(settingsStash)})`, result.context);
    assert.deepEqual(result.createdTabs, []);
    assert.deepEqual(result.getItems(), [settingsStash]);
  }
});

test('open settings dialogs synchronize independent preferences, including invalid values and removals', async () => {
  const storage = createStorage({ stashedItems: [settingsStash] });
  const first = runManager([], { storage });
  const second = runManager([], { storage });
  await Promise.all([first.getElement('settingsBtn').onclick(), second.getElement('settingsBtn').onclick()]);
  first.getElement('keepAfterRestore').checked = true;
  await first.getElement('keepAfterRestore').trigger('change');
  assert.equal(second.getElement('keepAfterRestore').checked, true);
  first.getElement('skipDuplicates').checked = true;
  await first.getElement('skipDuplicates').trigger('change');
  assert.equal(second.getElement('skipDuplicates').checked, true);
  assert.equal(second.getElement('keepAfterRestore').checked, true);
  await storage.local.set({ keepAfterRestore: 'true', openOnStartup: true, skipDuplicates: 'true' });
  for (const result of [first, second]) {
    assert.equal(result.getElement('keepAfterRestore').checked, false);
    assert.equal(result.getElement('openOnStartup').checked, true);
    assert.equal(result.getElement('skipDuplicates').checked, false);
  }
  await storage.local.set({ skipDuplicates: true });
  await storage.local.remove('skipDuplicates');
  assert.equal(second.getElement('skipDuplicates').checked, false);
  await storage.local.remove('openOnStartup');
  assert.equal(second.getElement('openOnStartup').checked, false);
  assert.deepEqual(storage.snapshot().stashedItems, [settingsStash]);
});

test('closing settings restores focus to More actions', async () => {
  const result = runManager([]);
  await result.getElement('settings-modal').trigger('close');
  assert.equal(result.getElement('moreBtn').focused, true);
});

test('settings reread after a preference changes while loading', async () => {
  const result = runManager([]);
  const get = result.storage.local.get;
  let release;
  let preferenceReads = 0;
  result.storage.local.get = async query => {
    const snapshot = await get(query);
    if ('openOnStartup' in query && ++preferenceReads === 1) {
      return new Promise(resolve => { release = () => resolve(snapshot); });
    }
    return snapshot;
  };
  const loading = result.getElement('settingsBtn').onclick();
  await Promise.resolve();
  await result.storage.local.set({ openOnStartup: true });
  release();
  await loading;
  assert.equal(preferenceReads, 2);
  assert.equal(result.getElement('openOnStartup').checked, true);
});

test('a pending save remains disabled after reopening and a late failure safely reverts it', async () => {
  const result = runManager([]);
  await result.getElement('settingsBtn').onclick();
  let rejectSave;
  result.storage.local.set = () => new Promise((_resolve, reject) => { rejectSave = reject; });
  const input = result.getElement('keepAfterRestore');
  input.checked = true;
  const saving = input.trigger('change');
  assert.equal(input.disabled, true);
  await result.getElement('settingsBtn').onclick();
  assert.equal(input.disabled, true);
  rejectSave(new Error('Late failure'));
  await saving;
  assert.equal(input.disabled, false);
  assert.equal(input.checked, false);
  assert.equal(result.getElement('settings-error').hidden, false);
});

test('title double-click reads the current preference and focuses the existing editor', async () => {
  const result = runManager([settingsStash]);
  const header = createElement();
  result.context.header = header;
  result.context.stash = settingsStash;
  vm.runInContext('renderViewMode(header, stash)', result.context);
  await result.storage.local.set({ editOnDoubleClick: true });
  await header.children.find(child => child.className.includes('group-badge')).trigger('dblclick');
  const input = header.children[0].children[0];
  assert.equal(input.className, 'edit-input');
  assert.equal(input.value, settingsStash.title);
  assert.equal(input.focused, true);
  assert.deepEqual(result.createdTabs, []);
  assert.deepEqual(result.getItems(), [settingsStash]);
  await result.storage.local.set({ editOnDoubleClick: false });
  vm.runInContext('renderViewMode(header, stash)', result.context);
  await header.children.find(child => child.className.includes('group-badge')).trigger('dblclick');
  assert.equal(result.createdTabs.length, 2);
  assert.deepEqual(result.getItems(), []);
});

test('restashing restored tabs respects duplicate skipping with Keep tabs after restoration on or off', async () => {
  for (const keepAfterRestore of [true, false]) {
    const storage = createStorage({ stashedItems: [settingsStash], keepAfterRestore, skipDuplicates: true });
    const manager = runManager([], { storage });
    await vm.runInContext(`restoreGroup(${JSON.stringify(settingsStash)})`, manager.context);
    assert.deepEqual(manager.getItems(), keepAfterRestore ? [settingsStash] : []);
    const writesAfterRestore = storage.writes.length;
    const background = runBackground({ storage,
      group: { title: 'Renamed browser group', color: 'red' },
      groupedTabs: manager.createdTabs.map(tab => ({ ...manager.getTab(tab.id), windowId: 4 }))
    });
    await background.listeners.actionClicked({ windowId: 4, groupId: 8 });
    assert.equal(background.getItems().length, 1);
    if (keepAfterRestore) {
      assert.deepEqual(background.getItems(), [settingsStash]);
      assert.equal(storage.writes.length, writesAfterRestore);
    } else {
      assert.deepEqual(background.getItems()[0].tabs.map(tab => tab.url), settingsStash.tabs.map(tab => tab.url));
      assert.equal(background.getItems()[0].title, 'Renamed browser group');
      assert.equal(storage.writes.length, writesAfterRestore + 1);
    }
    assert.deepEqual(background.removedTabs, manager.createdTabs.map(tab => tab.id));
  }
});

for (const keepAfterRestore of [false, true]) {
  test(`whole-stash restore loads tabs normally and honors keep=${keepAfterRestore}`, async () => {
    const result = runManager([settingsStash], {
      pendingNavigation: true,
      preferences: { keepAfterRestore, unloadAfterRestore: true }
    });
    await vm.runInContext(`restoreGroup(${JSON.stringify(settingsStash)})`, result.context);
    assert.deepEqual(result.createdTabs.map(({ id, ...tab }) => tab), settingsStash.tabs.map(tab => ({
      url: tab.url, active: false
    })));
    assert.deepEqual(result.getItems(), keepAfterRestore ? [settingsStash] : []);
    assert.deepEqual(result.groupedTabs, [{ tabIds: [20, 21] }]);
    assert.deepEqual(result.updatedGroups, [[8, { title: settingsStash.title, color: 'blue', collapsed: false }]]);
    assert.equal(result.getTab(20).pendingUrl, settingsStash.tabs[0].url);
    assert.equal(result.getTab(20).discarded, false);
    assert.equal(result.getElement('notification-message').textContent, 'Restored your tabs.');
  });
}

test('startup stays off for absent, false and invalid preferences', async () => {
  for (const preferences of [{}, { openOnStartup: false }, { openOnStartup: 'true' }]) {
    const result = runBackground({ preferences, items: [settingsStash] });
    await result.listeners.startup();
    assert.deepEqual(result.createdTabs, []);
    assert.deepEqual(result.updatedTabs, []);
    assert.equal(result.listeners.windowCreated, undefined);
    assert.deepEqual(result.getItems(), [settingsStash]);
  }
});

test('startup opens one pinned background manager in a normal window without stashing', async () => {
  const result = runBackground({ preferences: { openOnStartup: true }, items: [settingsStash], windows: [
    { id: 9, type: 'popup', focused: true }, { id: 4, type: 'normal', focused: true }
  ] });
  await result.listeners.startup();
  assert.deepEqual(result.createdTabs, [{ id: 100, url: 'chrome-extension://stasher/src/manager/manager.html', windowId: 4, index: 0, pinned: true, active: false }]);
  assert.deepEqual(result.removedTabs, []);
  assert.deepEqual(result.permissionRequests, []);
  assert.deepEqual(result.getItems(), [settingsStash]);
  assert.equal(result.listeners.windowCreated, undefined);
});

test('startup reuses existing or restoring manager tabs across normal windows without selecting them', async () => {
  for (const urlKey of ['url', 'pendingUrl']) {
    const result = runBackground({ preferences: { openOnStartup: true }, windows: [
      { id: 4, type: 'normal', focused: true }, { id: 8, type: 'normal' }
    ], windowTabs: [{ id: 55, windowId: 8, [urlKey]: 'chrome-extension://stasher/src/manager/manager.html' }] });
    await result.listeners.startup();
    assert.deepEqual(result.createdTabs, []);
    assert.deepEqual(result.updatedTabs, [{ id: 55, pinned: true }]);
  }
});

test('startup waits once for a normal window and ignores popup and incognito windows', async () => {
  const result = runBackground({ preferences: { openOnStartup: true }, windows: [] });
  await result.listeners.startup();
  assert.deepEqual(result.createdTabs, []);
  const onCreated = result.listeners.windowCreated;
  await onCreated({ id: 9, type: 'popup' });
  await onCreated({ id: 10, type: 'normal', incognito: true });
  assert.deepEqual(result.createdTabs, []);
  result.windows.push({ id: 11, type: 'normal' });
  await Promise.all([onCreated({ id: 11, type: 'normal' }), onCreated({ id: 12, type: 'normal' })]);
  assert.equal(result.createdTabs.length, 1);
  assert.equal(result.createdTabs[0].windowId, 11);
  assert.equal(result.createdTabs[0].active, false);
  assert.equal(result.listeners.windowCreated, undefined);
});

test('startup ignores managers in popup and incognito windows', async () => {
  for (const excludedWindow of [{ id: 9, type: 'popup' }, { id: 9, type: 'normal', incognito: true }]) {
    const result = runBackground({ preferences: { openOnStartup: true }, windows: [
      { id: 4, type: 'normal', focused: true }, excludedWindow
    ], windowTabs: [{ id: 55, windowId: 9, incognito: excludedWindow.incognito === true,
      url: 'chrome-extension://stasher/src/manager/manager.html' }] });
    await result.listeners.startup();
    assert.equal(result.createdTabs.length, 1);
    assert.equal(result.createdTabs[0].windowId, 4);
    assert.deepEqual(result.updatedTabs, []);
  }
});

test('startup does not open with an unreadable preference', async () => {
  const result = runBackground({ preferences: { openOnStartup: true }, failPreferenceGet: true });
  await result.listeners.startup();
  assert.deepEqual(result.createdTabs, []);
  assert.equal(result.errors.length, 1);
});

test('waiting for a startup window survives service-worker suspension and is consumed once', async () => {
  const first = runBackground({ preferences: { openOnStartup: true }, windows: [] });
  await first.listeners.startup();
  assert.equal(first.sessionStorage.snapshot().awaitingStartupWindow, true);
  const restarted = runBackground({ sessionStorage: first.sessionStorage, windows: [] });
  const onCreated = restarted.listeners.windowCreated;
  restarted.windows.push({ id: 4, type: 'normal' });
  await onCreated({ id: 4, type: 'normal' });
  assert.equal(restarted.createdTabs.length, 1);
  assert.equal(restarted.createdTabs[0].active, false);
  assert.equal(restarted.sessionStorage.snapshot().awaitingStartupWindow, undefined);
  assert.equal(restarted.listeners.windowCreated, undefined);
  const later = runBackground({ sessionStorage: restarted.sessionStorage });
  await later.listeners.windowCreated({ id: 4, type: 'normal' });
  assert.deepEqual(later.createdTabs, []);
});

test('search ranks stash titles, tab titles, and URLs while preserving tie order', () => {
  const result = runManager([]);
  const stashes = [
    { id: 'url-first', title: 'Archive', tabs: [{ title: 'One', url: 'https://needle.example' }] },
    { id: 'tab-first', title: 'Archive', tabs: [{ title: 'Needle notes', url: 'https://two.example' }] },
    { id: 'title-first', title: 'Needle research', tabs: [{ title: 'Three', url: 'https://three.example' }] },
    { id: 'title-second', title: 'NEEDLE links', tabs: [{ title: 'Needle too', url: 'https://needle.example/too' }] },
    { id: 'tab-second', title: 'Archive', tabs: [{ title: 'A needle later', url: 'https://five.example' }] },
    { id: 'url-second', title: 'Archive', tabs: [{ title: 'Six', url: 'https://six.example/needle' }] },
    { id: 'missing', title: 'Archive', tabs: [{ title: 'Seven', url: 'https://seven.example' }] }
  ];

  result.context.testStashes = stashes;
  assert.deepEqual(
    clone(vm.runInContext("rankStashesByQuery(testStashes, 'needle')", result.context)).map(item => item.id),
    ['title-first', 'title-second', 'tab-first', 'tab-second', 'url-first', 'url-second']
  );
  assert.deepEqual(
    clone(vm.runInContext("rankStashesByQuery(testStashes, '')", result.context)).map(item => item.id),
    stashes.map(item => item.id)
  );
  assert.deepEqual(
    clone(vm.runInContext("rankStashesByQuery(testStashes, 'absent')", result.context)),
    []
  );
});

test('Cmd+F and Ctrl+F focus the Stasher search input', () => {
  const result = runManager([]);
  const searchInput = result.getElement('searchInput');
  let focusCount = 0;
  let prevented = 0;
  searchInput.focus = () => { focusCount += 1; };

  for (const event of [
    { key: 'f', metaKey: true, ctrlKey: false },
    { key: 'f', metaKey: false, ctrlKey: true }
  ]) {
    result.triggerDocumentEvent('keydown', {
      ...event,
      preventDefault: () => { prevented += 1; }
    });
  }

  assert.equal(focusCount, 2);
  assert.equal(prevented, 2);
});

test('search renders an accessible no-results message without changing storage', async () => {
  const stash = {
    id: 'search-me',
    title: 'Research',
    tabs: [{ title: 'One', url: 'https://one.example' }]
  };
  const result = runManager([stash]);

  result.getElement('searchInput').value = 'missing';
  await vm.runInContext('loadStashes()', result.context);

  assert.deepEqual(result.getItems(), [stash]);
  assert.equal(result.getElement('stash-container').children.length, 1);
  assert.equal(
    result.getElement('stash-container').children[0].textContent,
    'No stashes match your search.'
  );
});

test('imports compatible Stasher JSON while de-duplicating stash IDs', async () => {
  const existing = {
    id: 'same-id',
    title: 'Existing',
    tabs: [{ title: 'Existing', url: 'https://existing.example' }]
  };
  const imported = {
    id: 'same-id',
    title: 'Imported replacement',
    tabs: [{ title: 'Imported', url: 'https://imported.example' }]
  };
  const newItem = {
    id: 'new-id',
    title: 'New',
    tabs: [{ title: 'New', url: 'https://new.example' }]
  };
  const result = runManager([existing]);
  result.context.importEvent = {
    target: {
      files: [{ size: 200, text: async () => JSON.stringify([imported, newItem]) }],
      value: 'stasher.json'
    }
  };

  await vm.runInContext('handleImport(importEvent.target.files[0])', result.context);

  assert.equal(result.getItems().length, 2);
  assert.equal(result.getItems().filter(item => item.id === 'same-id').length, 1);
  assert.equal(result.getItems()[0].title, 'Imported replacement');
  assert.equal(result.getItems()[1].id, 'new-id');
  assert.deepEqual(result.getItems()[1].tabs[0], {
    title: 'New',
    url: 'https://new.example'
  });
});

test('duplicate skipping leaves URLs intact when importing JSON backups or OneTab exports', async () => {
  const saved = { id: 'saved', tabs: [{ title: 'Saved', url: 'https://one.example' }] };
  const tabs = [
    { title: 'First', url: 'https://one.example' },
    { title: 'Second', url: 'https://one.example' }
  ];
  for (const file of [
    new File([JSON.stringify([{ id: 'imported', tabs }])], 'backup.json'),
    new File(['https://one.example | First\nhttps://one.example | Second'], 'onetab.txt')
  ]) {
    const result = runManager([saved], { preferences: { skipDuplicates: true } });
    result.context.file = file;
    await vm.runInContext('handleImport(file)', result.context);
    assert.equal(result.getItems().length, 2);
    assert.deepEqual(result.getItems()[0].tabs, tabs);
    assert.deepEqual(result.getItems()[1], saved);
    assert.equal(result.storage.snapshot().skipDuplicates, true);
  }
});

test('rejects Stasher JSON over the item limit', async () => {
  const result = runManager([]);
  result.context.importEvent = {
    target: {
      files: [{
        size: 200,
        text: async () => JSON.stringify(Array.from({ length: 1001 }, () => ({})))
      }],
      value: 'stasher.json'
    }
  };

  await vm.runInContext('handleImport(importEvent.target.files[0])', result.context);

  assert.match(result.getElement('notification-message').textContent, /too many stash items/i);
});

test('imports OneTab groups from a file, preserving order, titles, duplicate URLs, and existing stashes', async () => {
  const existing = { id: 'existing', tabs: [{ title: 'Saved', url: 'https://saved.example' }] };
  const result = runManager([existing]);
  result.getElement('importFile').files = [new File(['\uFEFF\r\nhttps://one.example | First | with pipe\r\nhttps://one.example | Duplicate URL\r\n \t\r\n\r\nhttps://two.example\r\nchrome-extension://other/page.html | Extension\r\n'], 'onetab.txt')];

  await result.getElement('importFile').onchange();

  const [first, second, saved] = result.getItems();
  assert.deepEqual(saved, existing);
  assert.notEqual(first.id, second.id);
  assert.equal(first.title, 'OneTab group 1');
  assert.equal(second.title, 'OneTab group 2');
  assert.equal(first.type, 'group');
  assert.equal(first.color, 'grey');
  assert.ok(Number.isFinite(Date.parse(first.timestamp)));
  assert.deepEqual(first.tabs, [
    { title: 'First | with pipe', url: 'https://one.example' },
    { title: 'Duplicate URL', url: 'https://one.example' }
  ]);
  assert.deepEqual(second.tabs, [
    { title: 'https://two.example', url: 'https://two.example' },
    { title: 'Extension', url: 'chrome-extension://other/page.html' }
  ]);
  assert.equal(result.getElement('importFile').value, '');
  assert.equal(result.getElement('importBtn').disabled, false);
  assert.match(result.getElement('notification-message').textContent, /Imported 2 new stashes/);

  // Imported groups remain compatible with Stasher's backup and restore paths.
  result.context.importedGroup = first;
  assert.equal(vm.runInContext('isValidStashItem(importedGroup)', result.context), true);
  await vm.runInContext('restoreGroup(importedGroup)', result.context);
  assert.deepEqual(result.groupedTabs, [{ tabIds: [20, 21] }]);
  assert.equal(result.updatedGroups[0][1].title, 'OneTab group 1');
  assert.equal(result.getItems().length, 2);
});

test('imports pasted OneTab exports through the shared import handler', async () => {
  const existing = { id: 'kept', tabs: [{ title: 'Saved', url: 'https://saved.example' }] };
  const result = runManager([existing]);
  const text = 'https://one.example | One\nhttps://two.example | Two\n\nhttps://three.example | Three';
  result.getElement('onetab-text').value = text;
  vm.runInContext("showModal = async () => 'cancel'", result.context);
  await result.getElement('importBtn').onclick();
  assert.equal(result.getElement('onetab-text').value, text);
  assert.deepEqual(result.getItems(), [existing]);

  vm.runInContext("showModal = async () => 'confirm'", result.context);
  await result.getElement('importBtn').onclick();

  const [first, second, kept] = result.getItems();
  assert.deepEqual(first.tabs.map(tab => tab.url), ['https://one.example', 'https://two.example']);
  assert.deepEqual(second.tabs.map(tab => tab.url), ['https://three.example']);
  assert.deepEqual(kept, existing);
  assert.equal(result.getElement('onetab-text').value, '');
  assert.match(result.getElement('notification-message').textContent, /Imported 2 new stashes/);
});

test('imports OneTab text files through the file picker and resets it', async () => {
  const result = runManager([]);
  let picked = false;
  result.getElement('importFile').click = () => { picked = true; };
  vm.runInContext("showModal = async () => 'cancel'", result.context);
  await result.getElement('importBtn').onclick();
  assert.equal(picked, false);
  vm.runInContext("showModal = async () => 'file'", result.context);
  await result.getElement('importBtn').onclick();
  assert.equal(picked, true);
  Object.assign(result.getElement('importFile'), {
    files: [{ name: 'OneTab.TXT', size: 200, text: async () => 'http://one.example | One\n\nhttps://two.example | ' }],
    value: 'OneTab.TXT'
  });

  await result.getElement('importFile').onchange();

  assert.equal(result.getItems().length, 2);
  assert.equal(result.getItems()[1].tabs[0].title, 'https://two.example');
  assert.equal(result.getElement('importFile').value, '');
});

test('rejects malformed or unsupported OneTab lines before saving any groups', async () => {
  const existing = { id: 'kept', tabs: [{ title: 'Saved', url: 'https://saved.example' }] };
  for (const invalid of ['javascript:alert(1) | Unsafe', 'file:///tmp/private | Local', 'chrome://settings | Settings', 'Not an exported URL', 'https://valid.example trailing text']) {
    const result = runManager([existing]);
    const text = `https://one.example | Valid\n\n${invalid}`;
    result.getElement('onetab-text').value = text;
    vm.runInContext("showModal = async () => 'confirm'", result.context);

    await result.getElement('importBtn').onclick();

    assert.deepEqual(result.getItems(), [existing]);
    assert.equal(result.getElement('onetab-text').value, text);
    assert.match(result.getElement('notification-message').textContent, /Nothing was imported/);
    assert.equal(result.getElement('importBtn').disabled, false);
  }
});

test('enforces OneTab import size and group limits without saving partial data', async () => {
  const cases = [
    ['\n \t\r\n', /No tabs found/],
    ['https://one.example | ' + '\u00e9'.repeat(524288), /too large/],
    [Array(1001).fill('https://one.example').join('\n\n'), /too many stash items/],
    [Array(501).fill('https://one.example').join('\n'), /exceeds 500 tabs/]
  ];
  for (const [text, message] of cases) {
    const result = runManager([]);
    result.context.oneTabFile = new File([text], 'onetab.txt');

    await vm.runInContext('handleImport(oneTabFile)', result.context);

    assert.match(result.getElement('notification-message').textContent, message);
    assert.deepEqual(result.getItems(), []);
  }
  const result = runManager([]);
  result.context.oneTabFile = new File([Array(500).fill('https://one.example | ' + 'T'.repeat(201)).join('\n')], 'onetab.txt');
  await vm.runInContext('handleImport(oneTabFile)', result.context);
  assert.equal(result.getItems()[0].tabs.length, 500);
  assert.equal(result.getItems()[0].tabs[0].title.length, 200);
});

test('failed OneTab paste import preserves existing stashes and text for retry', async () => {
  const existing = { id: 'kept', tabs: [] };
  const result = runManager([existing], { failStorageSetAt: 1 });
  const text = 'https://one.example | One';
  result.getElement('onetab-text').value = text;
  vm.runInContext("showModal = async () => 'confirm'", result.context);

  await result.getElement('importBtn').onclick();

  assert.deepEqual(result.getItems(), [existing]);
  assert.equal(result.getElement('onetab-text').value, text);
  assert.equal(result.getElement('importBtn').disabled, false);
  assert.match(result.getElement('notification-message').textContent, /Import failed: Storage update failed/);

  await result.getElement('importBtn').onclick();
  assert.equal(result.getItems().length, 2);
  assert.equal(result.getElement('onetab-text').value, '');
});

test('repeated OneTab import submissions only save once while a write is pending', async () => {
  const result = runManager([]);
  result.context.oneTabFile = new File(['https://one.example | One'], 'onetab.txt');

  await Promise.all([
    vm.runInContext('handleImport(oneTabFile)', result.context),
    vm.runInContext('handleImport(oneTabFile)', result.context)
  ]);

  assert.equal(result.getItems().length, 1);
});

test('exports only a Stasher JSON backup after importing OneTab tabs', async () => {
  const result = runManager([]);
  result.context.oneTabFile = new File(['https://one.example | One'], 'onetab.txt');
  await vm.runInContext('handleImport(oneTabFile)', result.context);
  let download;
  result.context.document.createElement = () => {
    const anchor = createElement();
    anchor.click = () => { download = anchor; };
    return anchor;
  };

  await vm.runInContext('handleExport()', result.context);

  assert.match(download.download, /^stasher-export-\d{4}-\d{2}-\d{2}\.json$/);
  const backup = await fetch(download.href);
  assert.equal(backup.headers.get('content-type').split(';')[0], 'application/json');
  assert.deepEqual(await backup.json(), result.getItems());
  URL.revokeObjectURL(download.href);
});

test('cancelling Delete All keeps storage and pending Undo', async () => {
  const first = { id: 'first', tabs: [] };
  const second = { id: 'second', tabs: [] };
  const result = runManager([first, second]);
  await vm.runInContext("deleteStash('first')", result.context);
  const deletion = vm.runInContext('handleDeleteAll()', result.context);
  const dialog = result.getElement('confirm-modal');

  assert.equal(dialog.returnValue, 'cancel');
  await dialog.trigger('close');
  await deletion;

  assert.deepEqual(result.getItems(), [second]);
  await vm.runInContext('handleUndo()', result.context);
  assert.deepEqual(result.getItems(), [first, second]);
});

test('Delete All clears storage and pending Undo', async () => {
  const deleted = {
    id: 'deleted-first',
    title: 'Deleted first',
    tabs: [{ title: 'One', url: 'https://one.example' }]
  };
  const remaining = {
    id: 'remaining',
    title: 'Remaining',
    tabs: [{ title: 'Two', url: 'https://two.example' }]
  };
  const result = runManager([deleted, remaining]);

  await vm.runInContext("deleteStash('deleted-first')", result.context);
  vm.runInContext("showModal = async () => 'confirm'", result.context);
  await vm.runInContext('handleDeleteAll()', result.context);

  assert.deepEqual(result.getItems(), []);
  assert.equal(result.getElement('notification').popoverOpen, true);
  assert.equal(result.getElement('notification-undo').hidden, true);
  assert.match(result.getElement('notification-message').textContent, /Deleted all stashes/);

  await vm.runInContext('handleUndo()', result.context);

  assert.deepEqual(result.getItems(), []);
});

test('failed Delete All preserves storage and pending Undo', async () => {
  const deleted = {
    id: 'deleted-first',
    title: 'Deleted first',
    tabs: [{ title: 'One', url: 'https://one.example' }]
  };
  const remaining = {
    id: 'remaining',
    title: 'Remaining',
    tabs: [{ title: 'Two', url: 'https://two.example' }]
  };
  const result = runManager([deleted, remaining], { failStorageSetAt: 2 });

  await vm.runInContext("deleteStash('deleted-first')", result.context);
  vm.runInContext("showModal = async () => 'confirm'", result.context);
  await vm.runInContext('handleDeleteAll()', result.context);

  assert.deepEqual(result.getItems(), [remaining]);
  assert.equal(result.getElement('notification').popoverOpen, true);
  assert.equal(result.getElement('notification-undo').hidden, false);
  assert.match(result.getElement('notification-message').textContent, /Could not delete all stashes/);

  await vm.runInContext('handleUndo()', result.context);

  assert.deepEqual(result.getItems(), [deleted, remaining]);
});

test('selecting a header action closes its popover without dismissing pending Undo', async () => {
  const stash = { id: 'deleted', tabs: [] };
  const result = runManager([stash]);
  await vm.runInContext("deleteStash('deleted')", result.context);
  const menu = result.getElement('actions-menu');
  menu.showPopover();

  await menu.trigger('click');
  assert.equal(menu.popoverOpen, true);
  await menu.trigger('click', {
    target: { closest: () => result.getElement('exportBtn') }
  });

  assert.equal(menu.popoverOpen, false);
  assert.equal(result.getElement('notification').popoverOpen, true);
  assert.equal(result.getElement('notification-undo').hidden, false);
  await result.getElement('notification-undo').onclick();
  assert.deepEqual(result.getItems(), [stash]);
});

test('manager notifications use one native popover and no legacy popup path', () => {
  const html = readFileSync(join(root, 'src/manager/manager.html'), 'utf8');
  const css = readFileSync(join(root, 'src/manager/manager.css'), 'utf8');
  assert.equal((html.match(/popover="manual"/g) ?? []).length, 1);
  assert.match(html, /id="notification"[^>]+role="status"/);
  assert.match(html, /id="notification-undo"[^>]+hidden/);
  assert.equal((managerSource.match(/elements\.notification\.showPopover\(/g) ?? []).length, 1);
  assert.equal((managerSource.match(/elements\.notification\.hidePopover\(/g) ?? []).length, 1);
  assert.doesNotMatch(html + css + managerSource, /undo-toast|info-toast|(?:show|hide)(?:Undo|Info)Toast|\balert\s*\(/);
});

test('delete, import, export and restore share a notification without losing pending Undo', async () => {
  const deleted = { id: 'deleted', title: 'Deleted', tabs: [] };
  const restored = { id: 'restored', tabs: [{ title: 'Saved', url: 'https://saved.example' }] };
  const result = runManager([deleted, restored]);
  const notification = result.getElement('notification');
  const message = result.getElement('notification-message');
  const undo = result.getElement('notification-undo');
  await vm.runInContext("deleteStash('deleted')", result.context);
  assert.equal(notification.popoverOpen, true);
  assert.equal(undo.hidden, false);
  assert.match(message.textContent, /Deleted/);

  await vm.runInContext("handleImport(new File(['https://imported.example | Imported'], 'onetab.txt'))", result.context);
  assert.match(message.textContent, /Imported 1 new stash/);
  assert.equal(undo.hidden, false);

  const create = result.context.document.createElement;
  result.context.document.createElement = () => Object.assign(create(), { click() {} });
  await vm.runInContext('handleExport()', result.context);
  await result.advanceTime(0);
  assert.match(message.textContent, /Exported/);
  assert.equal(undo.hidden, false);

  await vm.runInContext(`restoreGroup(${JSON.stringify(restored)})`, result.context);
  assert.match(message.textContent, /Restored/);
  assert.equal(undo.hidden, false);
  await undo.onclick();
  assert.deepEqual(result.getItems().map(item => item.id), ['deleted', 'import-id-1']);
  assert.equal(notification.popoverOpen, false);
});

test('a new notification resets dismissal and normal messages expire after three seconds', async () => {
  const result = runManager([]);
  await vm.runInContext("showNotification('First')", result.context);
  await result.advanceTime(2999);
  assert.equal(result.getElement('notification').popoverOpen, true);
  await vm.runInContext("showNotification('Second')", result.context);
  await result.advanceTime(2999);
  assert.equal(result.getElement('notification').popoverOpen, true);
  assert.equal(result.getElement('notification-message').textContent, 'Second');
  assert.equal(result.getElement('notification-undo').hidden, true);
  await result.advanceTime(1);
  assert.equal(result.getElement('notification').popoverOpen, false);
});

test('deletion notifications allow successive Undo actions and expire after five seconds', async () => {
  const first = { id: 'first', title: 'First', tabs: [] };
  const second = { id: 'second', title: 'Second', tabs: [] };
  const result = runManager([first, second]);
  await vm.runInContext("deleteStash('first')", result.context);
  await vm.runInContext("deleteStash('second')", result.context);
  assert.equal(result.getElement('notification-message').textContent, '2 items deleted');
  await result.getElement('notification-undo').onclick();
  assert.deepEqual(result.getItems(), [second]);
  assert.equal(result.getElement('notification-undo').hidden, false);
  await result.advanceTime(4999);
  assert.equal(result.getElement('notification').popoverOpen, true);
  await result.advanceTime(1);
  assert.equal(result.getElement('notification').popoverOpen, false);
  await vm.runInContext('handleUndo()', result.context);
  assert.deepEqual(result.getItems(), [second]);
});

test('dismissing a notification clears pending Undo instead of reviving it later', async () => {
  const result = runManager([{ id: 'deleted', tabs: [] }]);
  await vm.runInContext("deleteStash('deleted')", result.context);
  result.getElement('notification-dismiss').onclick();
  assert.equal(result.getElement('notification').popoverOpen, false);
  await vm.runInContext("showNotification('Another message'); handleUndo()", result.context);
  assert.equal(result.getElement('notification-undo').hidden, true);
  assert.deepEqual(result.getItems(), []);
});

test('failed stash and tab deletions report an error without offering a false Undo', async () => {
  const stash = { id: 'kept', tabs: [{ title: 'Saved', url: 'https://saved.example' }] };
  for (const action of ["deleteStash('kept')", "removeTabFromStash('kept', 0)"]) {
    const result = runManager([stash], { failStorageSetAt: 1 });
    await vm.runInContext(action, result.context);
    assert.deepEqual(result.getItems(), [stash]);
    assert.equal(result.getElement('notification').popoverOpen, true);
    assert.equal(result.getElement('notification-undo').hidden, true);
    assert.match(result.getElement('notification-message').textContent, /saved tabs were kept/);
    await vm.runInContext('handleUndo()', result.context);
    assert.deepEqual(result.getItems(), [stash]);
  }
});

test('a failed Undo stays available for retry in the same notification', async () => {
  const stash = { id: 'retry', tabs: [] };
  const result = runManager([stash], { failStorageSetAt: 2 });
  await vm.runInContext("deleteStash('retry')", result.context);
  const undo = result.getElement('notification-undo');
  await undo.onclick();
  assert.deepEqual(result.getItems(), []);
  assert.equal(undo.hidden, false);
  assert.equal(undo.disabled, false);
  assert.match(result.getElement('notification-message').textContent, /Try Undo again/);
  await undo.onclick();
  assert.deepEqual(result.getItems(), [stash]);
  assert.equal(result.getElement('notification').popoverOpen, false);
});

test('an Undo in progress blocks duplicate clicks and cannot expire during a slow save', async () => {
  const stash = { id: 'slow', tabs: [] };
  const earlier = { id: 'earlier', tabs: [] };
  const result = runManager([earlier, stash]);
  await vm.runInContext("deleteStash('earlier')", result.context);
  await vm.runInContext("deleteStash('slow')", result.context);
  const set = result.context.chrome.storage.local.set;
  let finish;
  result.context.chrome.storage.local.set = async value => {
    await new Promise(resolve => { finish = resolve; });
    await set(value);
  };
  const pending = result.getElement('notification-undo').onclick();
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  await result.getElement('notification-undo').onclick();
  await vm.runInContext("showNotification('Another message')", result.context);
  await result.advanceTime(6000);
  assert.equal(result.getElement('notification').popoverOpen, true);
  assert.equal(result.getElement('notification-undo').disabled, true);
  finish();
  await pending;
  assert.deepEqual(result.getItems(), [stash]);
  assert.equal(result.getElement('notification-undo').hidden, false);
  await result.advanceTime(5000);
  assert.equal(result.getElement('notification').popoverOpen, false);
  await result.getElement('notification-undo').onclick();
  assert.deepEqual(result.getItems(), [stash]);
});

function runCats(reducedMotion = false) {
  const result = runManager([]);
  const cats = [];
  Object.assign(result.context, {
    innerWidth: 800,
    innerHeight: 600,
    matchMedia: () => ({ matches: reducedMotion })
  });
  result.context.document.body = {
    append(cat) {
      cat.getBoundingClientRect = () => ({ left: 384, right: 416, top: 284, bottom: 316 });
      cat.remove = () => { cat.removed = true; };
      cat.animations = [];
      cat.animate = (frames, options) => {
        const animation = { frames: clone(frames), options: clone(options) };
        cat.animations.push(animation);
        return animation;
      };
      cats.push(cat);
    }
  };
  result.context.document.querySelector = selector => cats.find(cat =>
    !cat.removed && (selector === '.pet-cat' || !cat.classList.contains('leaving')));
  return { ...result, cats, spawn: () => result.getElement('catBtn').onclick() };
}

test('cats stay briefly, then run straight off one of the four screen edges before removal', async () => {
  const destinations = [[0, -316], [-416, 0], [0, 316], [416, 0]];
  for (const [direction, destination] of destinations.entries()) {
    const result = runCats();
    result.spawn();
    vm.runInContext(`Math.random = () => ${(direction + 0.5) / 4}`, result.context);
    const [cat] = result.cats;
    await result.advanceTime(2999);
    assert.equal(cat.removed, undefined);
    assert.equal(cat.animations.length, 0);
    await result.advanceTime(1);
    assert.equal(cat.removed, undefined);
    const [animation] = cat.animations;
    assert.deepEqual(animation.frames.translate[1].split(' ').map(parseFloat), destination);
    assert.equal(animation.options.easing, 'linear');
    assert.equal(animation.options.duration, 600);
    animation.onfinish();
    assert.equal(cat.removed, true);
  }
});

test('leaving cats do not block later cats and new clicks reset only the pending departures', async () => {
  const result = runCats();
  result.spawn();
  result.spawn();
  result.spawn();
  await result.advanceTime(3000);
  assert.equal(result.cats[0].animations.length, 1);
  assert.equal(result.cats[1].animations.length, 0);
  await result.advanceTime(100);
  assert.equal(result.cats[0].animations.length, 1);
  assert.equal(result.cats[1].animations.length, 1);
  result.spawn();
  await result.advanceTime(2999);
  assert.equal(result.cats[2].animations.length, 0);
  assert.equal(result.cats[3].animations.length, 0);
  await result.advanceTime(1);
  assert.equal(result.cats[2].animations.length, 1);
  assert.equal(result.cats[3].animations.length, 0);
  await result.advanceTime(100);
  assert.equal(result.cats[3].animations.length, 1);
  for (const cat of result.cats) cat.animations[0].onfinish();
  await result.advanceTime(100);
  assert(result.cats.every(cat => cat.removed && cat.animations.length === 1));
});

test('cats honor reduced motion and are cleaned up if an animation is cancelled', async () => {
  const result = runCats(true);
  result.spawn();
  await result.advanceTime(3000);
  const [cat] = result.cats;
  assert.equal(cat.animations[0].options.duration, 0);
  cat.animations[0].oncancel();
  assert.equal(cat.removed, true);
});

test('manifest defines a Chromium MV3 service worker', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const managerHtml = readFileSync(join(root, 'src/manager/manager.html'), 'utf8');

  assert.equal(manifest.manifest_version, 3);
  assert.equal(
    manifest.background.service_worker,
    'src/background/service-worker.js'
  );
  assert.equal(manifest.permissions.includes('favicon'), true);
  assert.equal(manifest.permissions.includes('contextMenus'), true);
  assert.equal(manifest.permissions.includes('tabGroups'), false);
  assert.deepEqual(manifest.optional_permissions, ['tabGroups']);
  assert.match(managerHtml, /<main id="stash-container" tabindex="-1" aria-live="polite">/);
});

test('manifest defines one browser-managed action shortcut and no options page', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

  assert.equal(manifest.options_ui, undefined);
  assert.deepEqual(Object.keys(manifest.commands), ['_execute_action']);
  assert.equal(manifest.commands._execute_action.suggested_key, 'Alt+S');
});


test('restores into one new window without a spare blank tab and retains failures', async () => {
  const stash = { id: 'window', type: 'group', title: 'Work', color: 'blue', tabs: [
    { title: 'One', url: 'https://one.example' }, { title: 'Two', url: 'https://two.example' }
  ] };
  const result = runManager([stash], { preferences: { restoreInNewWindow: true } });
  await vm.runInContext(`restoreGroup(${JSON.stringify(stash)})`, result.context);
  assert.equal(result.createdWindows.length, 1);
  assert.deepEqual(result.createdWindows[0].url, stash.tabs.map(tab => tab.url));
  assert.deepEqual(result.createdTabs, []);
  assert.deepEqual(result.groupedTabs, [{ tabIds: [20, 21], createProperties: { windowId: 7 } }]);
  assert.deepEqual([20, 21].map(id => result.getTab(id).windowId), [7, 7]);
  assert.deepEqual(result.getItems(), []);
  for (const options of [{ failWindowCreation: true }, { missingWindowTabs: true }]) {
    const failed = runManager([stash], { ...options, preferences: { restoreInNewWindow: true } });
    await vm.runInContext(`restoreGroup(${JSON.stringify(stash)})`, failed.context);
    assert.deepEqual(failed.getItems(), [stash]);
  }
});



test('restore button and title double-click both honor the new-window setting', async () => {
  const stash = { id: 'window-controls', type: 'loose', tabs: [{ title: 'One', url: 'https://one.example' }] };
  for (const control of ['button', 'title']) {
    const result = runManager([stash], { preferences: { restoreInNewWindow: true } });
    const header = createElement();
    result.context.header = header;
    await vm.runInContext('renderViewMode(header, ' + JSON.stringify(stash) + ')', result.context);
    if (control === 'button') await header.children[4].children[0].onclick();
    else await header.children[1].trigger('dblclick');
    assert.equal(result.createdWindows.length, 1);
    assert.equal(result.createdTabs.length, 0);
  }
});


test('highlights literal queries without turning saved titles into markup', () => {
  const result = runManager([]);
  result.context.document.createElement = tag => Object.assign(createElement(), { tagName: tag });
  result.getElement('searchInput').value = '[a]';
  result.context.label = createElement();
  vm.runInContext("highlightText(label, '<img src=x> [A] and [a]')", result.context);
  assert.deepEqual(result.context.label.children.filter(part => part.tagName === 'mark').map(part => part.textContent), ['[A]', '[a]']);
  assert.equal(result.context.label.children.map(part => part.textContent).join(''), '<img src=x> [A] and [a]');
});


test('search uses the loaded archive without mutating or rereading storage', async () => {
  const stash = { id: 'found', title: 'Needle', tabs: [
    { title: 'One', url: 'https://one.example' }, { title: 'Two', url: 'https://two.example' }
  ] };
  const result = runManager([stash, { id: 'other', title: 'Other', tabs: [] }]);
  await vm.runInContext('loadStashes()', result.context);
  let reads = 0;
  const get = result.storage.local.get;
  result.storage.local.get = query => { reads++; return get(query); };
  result.getElement('searchInput').value = 'needle';
  await result.getElement('searchInput').oninput();
  assert.equal(reads, 0);
  assert.equal(result.getElement('stash-container').children.length, 1);
  assert.equal(result.storage.writes.length, 0);
});


test('a late archive read cannot overwrite a newer storage change', async () => {
  const result = runManager([]);
  await vm.runInContext('loadStashes()', result.context);
  const pending = [];
  result.storage.local.get = () => new Promise(resolve => pending.push(resolve));
  const older = vm.runInContext('loadStashes()', result.context);
  const newer = vm.runInContext('loadStashes()', result.context);
  pending[1]({ stashedItems: [{ id: 'new', title: 'New', tabs: [] }] });
  await newer;
  pending[0]({ stashedItems: [{ id: 'old', title: 'Old', tabs: [] }] });
  await older;
  assert.equal(vm.runInContext('state.items[0].id', result.context), 'new');
});

test('cached typing does not cancel a pending storage refresh', async () => {
  const result = runManager([{ id: 'old', title: 'Old', tabs: [] }]);
  await vm.runInContext('loadStashes()', result.context);
  let resolveRead;
  result.storage.local.get = () => new Promise(resolve => { resolveRead = resolve; });
  const refreshing = vm.runInContext('loadStashes()', result.context);
  result.getElement('searchInput').value = 'new';
  await result.getElement('searchInput').oninput();
  resolveRead({ stashedItems: [{ id: 'new', title: 'New', tabs: [] }] });
  await refreshing;
  assert.equal(vm.runInContext('state.items[0].id', result.context), 'new');
  assert.equal(result.getElement('stash-container').children[0].children[0].children[1].children.map(part => part.textContent).join(''), 'New');
});

test('collapse choices survive reopening and collapsed rows stay lazy', async () => {
  const stash = { id: 'lazy', tabs: [{ title: 'One', url: 'https://one.example' }] };
  const first = runManager([stash]);
  await vm.runInContext('loadStashes()', first.context);
  await first.getElement('collapseAllBtn').onclick();
  const reopened = runManager([], { storage: first.storage });
  await vm.runInContext('loadStashes()', reopened.context);
  const card = () => reopened.getElement('stash-container').children[0];
  assert.equal(card().children[1].children.length, 0);
  await card().children[0].children[0].onclick();
  assert.equal(card().children[1].children.length, 1);
  assert.deepEqual(first.getItems(), [stash]);
});

test('collapse synchronizes automatically and a failed save leaves tabs visible', async () => {
  const stash = { id: 'collapse', tabs: [{ title: 'One', url: 'https://one.example' }] };
  const storage = createStorage({ stashedItems: [stash] });
  const first = runManager([], { storage }), second = runManager([], { storage });
  await Promise.all([vm.runInContext('loadStashes()', first.context), vm.runInContext('loadStashes()', second.context)]);
  await first.getElement('collapseAllBtn').onclick();
  assert.equal(second.getElement('stash-container').children[0].children[1].children.length, 0);
  await second.getElement('collapseAllBtn').onclick();
  assert.equal(first.getElement('stash-container').children[0].children[1].children.length, 1);
  const failed = runManager([stash], { failStorageSetAt: 1 });
  await vm.runInContext('loadStashes()', failed.context);
  await failed.getElement('collapseAllBtn').onclick();
  assert.equal(failed.getElement('stash-container').children[0].children[1].children.length, 1);
  assert.match(failed.getElement('notification-message').textContent, /Could not save collapsed/);
});
