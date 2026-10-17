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
    request(name, options, callback) {
      if (typeof options === 'function') { callback = options; options = {}; }
      if (options.ifAvailable && queues.has(name)) return Promise.resolve(callback(null));
      const pending = (queues.get(name) ?? Promise.resolve()).then(() => callback({ name }));
      const settled = pending.catch(() => {});
      queues.set(name, settled);
      return pending.finally(() => {
        if (queues.get(name) === settled) queues.delete(name);
      });
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
  const openedPanels = [];
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
    commands: { onCommand: eventSlot(listeners, 'command') },
    sidePanel: { open: async details => openedPanels.push(clone(details)) },
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
    openedPanels,
    errors,
    permissionRequests,
    windows,
    sessionStorage,
    getItems: () => storage.snapshot().stashedItems
  };
}

function createElement() {
  const classes = new Set();
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

const backupStash = {
  id: 'backup', title: 'Saved pages', type: 'group', color: 'blue',
  tabs: [{ title: 'Page', url: 'https://example.com' }]
};
const importJson = (manager, items) => manager.context.handleImport(new File([JSON.stringify(items)], 'backup.json'));

test('JSON import reports invalid stashes and preserves valid ones', async () => {
  const manager = runManager([]);
  await importJson(manager, [backupStash, null, { ...backupStash, id: 'unsafe', tabs: [
    ...backupStash.tabs, { title: 'Unsafe', url: 'javascript:alert(1)' }
  ] }]);

  assert.deepEqual(manager.getItems(), [backupStash]);
  assert.equal(manager.getElement('notification-message').textContent, 'Imported 1 new stash. Skipped 2 invalid entries.');
  assert.equal(manager.storage.writes.length, 1);
});

test('import keeps current stashes and the first valid occurrence of each normalized ID', async () => {
  const existing = { ...backupStash, id: '7', title: 'Newer local data', tabs: [{ title: 'New', url: 'https://new.example' }] };
  const manager = runManager([existing]);
  const imported = [
    { ...backupStash, id: 7 }, backupStash, { ...backupStash, title: 'Repeated old backup' }
  ];

  await importJson(manager, imported);
  assert.deepEqual(manager.getItems(), [backupStash, existing]);
  assert.equal(manager.getElement('notification-message').textContent, 'Imported 1 new stash. Skipped 2 existing or duplicate IDs.');
  await importJson(manager, imported);
  assert.deepEqual(manager.getItems(), [backupStash, existing]);
  assert.equal(manager.getElement('notification-message').textContent, 'Imported 0 new stashes. Skipped 3 existing or duplicate IDs.');
  assert.equal(manager.storage.writes.length, 1);
});

test('empty and invalid JSON imports leave storage untouched and report skipped entries', async () => {
  const manager = runManager([backupStash]);
  for (const [items, message] of [
    [[], 'Imported 0 new stashes.'],
    [[null, {}], 'Imported 0 new stashes. Skipped 2 invalid entries.'],
    [[backupStash, null], 'Imported 0 new stashes. Skipped 1 invalid entry and 1 existing or duplicate ID.']
  ]) {
    await importJson(manager, items);
    assert.equal(manager.getElement('notification-message').textContent, message);
    assert.deepEqual(manager.getItems(), [backupStash]);
    assert.equal(manager.storage.writes.length, 0);
  }
});

test('failed import storage reads and writes preserve saved data and reset the import controls', async () => {
  for (const [options, message] of [
    [{ failStorageSetAt: 1 }, 'Import failed: Storage update failed'],
    [{ failStorageGetKey: 'stashedItems' }, 'Import failed: Storage read failed']
  ]) {
    const manager = runManager([backupStash], options);
    manager.getElement('importFile').value = 'backup.json';
    assert.equal(await importJson(manager, [{ ...backupStash, id: 'new' }]), false);
    assert.deepEqual(manager.getItems(), [backupStash]);
    assert.equal(manager.getElement('notification-message').textContent, message);
    assert.equal(manager.getElement('importBtn').disabled, false);
    assert.equal(manager.getElement('importFile').value, '');
  }
});

test('malformed and oversized imports retain validation limits without writing storage', async () => {
  for (const [text, name, message] of [
    ['{', 'backup.json', 'Invalid JSON backup.'],
    ['{}', 'backup.json', 'Invalid format: expected an array.'],
    [' '.repeat(1024 * 1024 + 1), 'backup.json', 'Import file is too large.'],
    [JSON.stringify(Array(1001).fill(backupStash)), 'backup.json', 'Import contains too many stash items.'],
    [JSON.stringify([{ ...backupStash, tabs: Array(501).fill(backupStash.tabs[0]) }]), 'backup.json',
      'Imported 0 new stashes. Skipped 1 invalid entry.'],
    [Array(501).fill('https://example.com | Page').join('\n'), 'onetab.txt',
      'Import failed: OneTab export has unsupported URLs or a group exceeds 500 tabs. Nothing was imported.']
  ]) {
    const manager = runManager([backupStash]);
    await manager.context.handleImport(new File([text], name));
    assert.equal(manager.getElement('notification-message').textContent, message);
    assert.deepEqual(manager.getItems(), [backupStash]);
    assert.equal(manager.storage.writes.length, 0);
    assert.notEqual(manager.getElement('importBtn').disabled, true);
  }
});

test('valid OneTab import keeps groups and reports the added stash count', async () => {
  const manager = runManager([backupStash]);
  assert.equal(await manager.context.handleImport(new File([
    'https://one.example | One\r\nhttps://two.example | Two\r\n\r\nhttps://three.example | Three'
  ], 'onetab.txt')), true);
  assert.deepEqual(manager.getItems().map(item => item.tabs.map(tab => tab.url)), [
    ['https://one.example', 'https://two.example'], ['https://three.example'], ['https://example.com']
  ]);
  assert.equal(manager.getElement('notification-message').textContent, 'Imported 2 new stashes.');
  assert.equal(manager.storage.writes.length, 1);
});

test('OneTab import remains all-or-nothing for unsupported URLs', async () => {
  const manager = runManager([backupStash]);
  const file = new File(['https://good.example | Good\n\njavascript:alert(1) | Unsafe'], 'onetab.txt');
  assert.equal(await manager.context.handleImport(file), false);
  assert.deepEqual(manager.getItems(), [backupStash]);
  assert.equal(manager.storage.writes.length, 0);
  assert.match(manager.getElement('notification-message').textContent, /Nothing was imported/);
});

const savedStash = { ...backupStash, id: 'saved', tabs: [
  { title: 'One', url: 'https://one.example' }, { title: 'Two', url: 'https://two.example' }
] };
const preferenceKeys = ['openOnStartup', 'keepAfterRestore', 'restoreInNewWindow', 'skipDuplicates', 'editOnDoubleClick'];
const restore = manager => manager.context.restoreGroup(savedStash);

// Hold one browser call so assertions observe the operation before it finishes.
function pauseNextCall(target, method) {
  const original = target[method];
  const started = Promise.withResolvers();
  const gate = Promise.withResolvers();
  target[method] = async (...args) => {
    target[method] = original;
    started.resolve();
    await gate.promise;
    return original(...args);
  };
  return { started: started.promise, release: gate.resolve };
}

test('failed stash reads and writes keep every selected tab open and preserve saved data', async () => {
  for (const failure of [{ failStorageGetKey: 'skipDuplicates' }, { failStorageGetKey: 'stashedItems' }, { failStorageSetAt: 1 }]) {
    const background = runBackground({ ...failure, items: [savedStash], preferences: { skipDuplicates: true }, looseTabs: [
      { id: 11, ...savedStash.tabs[0] }, { id: 12, title: 'New', url: 'https://new.example' }
    ] });
    await background.listeners.actionClicked({ windowId: 4, groupId: -1 });
    assert.deepEqual(background.getItems(), [savedStash]);
    assert.deepEqual(background.removedTabs, []);
    assert.equal(background.createdTabs.length, 1);
    assert.equal(background.errors.length, 1);
  }
});

test('concurrent stashing contexts serialize updates and never close tabs before saving', async () => {
  for (const skipDuplicates of [false, true]) {
    const storage = createStorage({ stashedItems: [], skipDuplicates });
    const first = runBackground({ storage });
    const second = runBackground({ storage });
    second.context.crypto.randomUUID = () => 'second-id';
    const gate = pauseNextCall(storage.local, 'set');
    const tab = { id: 11, ...savedStash.tabs[0], windowId: 4, groupId: -1 };
    const pending = first.listeners.contextMenuClicked({ menuItemId: 'stash-tab' }, tab);
    await gate.started;
    const concurrent = second.listeners.contextMenuClicked({ menuItemId: 'stash-tab' }, { ...tab, id: 12 });
    await new Promise(setImmediate);
    assert.deepEqual(storage.snapshot().stashedItems, []);
    assert.deepEqual(first.removedTabs, []);
    assert.deepEqual(second.removedTabs, []);
    gate.release();
    await Promise.all([pending, concurrent]);
    assert.equal(storage.writes.length, skipDuplicates ? 1 : 2);
    assert.equal(first.getItems().length, skipDuplicates ? 1 : 2);
    assert.deepEqual(first.removedTabs, [11]);
    assert.deepEqual(second.removedTabs, [12]);
  }
});

test('a failed stash write releases the lock for a concurrent successful save', async () => {
  const storage = createStorage({ stashedItems: [], skipDuplicates: true }, { failStorageSetAt: 1 });
  const first = runBackground({ storage });
  const second = runBackground({ storage });
  const tab = { id: 11, ...savedStash.tabs[0], windowId: 4, groupId: -1 };
  await Promise.all([
    first.listeners.contextMenuClicked({ menuItemId: 'stash-tab' }, tab),
    second.listeners.contextMenuClicked({ menuItemId: 'stash-tab' }, { ...tab, id: 12 })
  ]);
  assert.equal(storage.writes.length, 2);
  assert.deepEqual(first.removedTabs, []);
  assert.deepEqual(second.removedTabs, [12]);
  assert.deepEqual(second.getItems()[0].tabs, [savedStash.tabs[0]]);
});

test('restoration preserves tab order, grouping, destination, and the keep-after-restore setting', async () => {
  for (const keepAfterRestore of [false, true]) for (const restoreInNewWindow of [false, true]) {
    for (const groupPermissionGranted of [false, true]) {
      const manager = runManager([savedStash, backupStash], {
        preferences: { keepAfterRestore, restoreInNewWindow }, groupPermissionGranted
      });
      await restore(manager);
      if (restoreInNewWindow) {
        assert.deepEqual(manager.createdWindows.map(window => ({ url: window.url, focused: window.focused })), [
          { url: savedStash.tabs.map(tab => tab.url), focused: true }
        ]);
        assert.deepEqual(manager.createdTabs, []);
      } else {
        assert.deepEqual(manager.createdTabs.map(({ id, ...tab }) => tab), savedStash.tabs.map(tab => ({ url: tab.url, active: false })));
        assert.deepEqual(manager.createdWindows, []);
      }
      assert.deepEqual(manager.groupedTabs, groupPermissionGranted ? [{
        tabIds: [20, 21], ...(restoreInNewWindow ? { createProperties: { windowId: 7 } } : {})
      }] : []);
      assert.deepEqual(manager.updatedGroups, groupPermissionGranted ? [[8, {
        title: savedStash.title, color: savedStash.color, collapsed: false
      }]] : []);
      assert.deepEqual(manager.getItems(), keepAfterRestore ? [savedStash, backupStash] : [backupStash]);
      assert.equal(manager.storage.writes.length, keepAfterRestore ? 0 : 1);
      assert.equal(manager.getElement('notification-message').textContent, 'Restored your tabs.');
      assert.equal(manager.getElement('notification-undo').hidden, true);
      assert.deepEqual(manager.errors, []);
    }
  }
});

test('failed restore reads, browser operations, and cleanup retain the saved stash', async () => {
  for (const options of [
    { failPreferenceGet: true }, { failStorageGetKey: 'stashedItems' }, { failTabCreation: true },
    { failTabGrouping: true }, { failGroupUpdate: true }, { failStorageSetAt: 1 },
    { failWindowCreation: true, preferences: { restoreInNewWindow: true } },
    { missingWindowTabs: true, preferences: { restoreInNewWindow: true } }
  ]) {
    const manager = runManager([savedStash], options);
    await restore(manager);
    assert.deepEqual(manager.getItems(), [savedStash]);
    assert.match(manager.getElement('notification-message').textContent, /kept/);
    assert.equal(manager.getElement('notification-undo').hidden, true);
    assert.ok(manager.errors.length > 0);
    if (options.failPreferenceGet || options.failStorageGetKey || options.failTabCreation) {
      assert.deepEqual(manager.createdTabs, []);
    }
  }
});

test('restore reads current saved tabs, filters unsafe URLs, and ignores missing stashes', async () => {
  const current = { ...savedStash, tabs: [{ title: 'Current', url: 'https://current.example' },
    { title: 'Unsafe', url: 'javascript:alert(1)' }] };
  const manager = runManager([current]);
  await restore(manager);
  assert.deepEqual(manager.createdTabs.map(tab => tab.url), ['https://current.example']);
  assert.deepEqual(manager.getItems(), []);
  await restore(manager);
  assert.equal(manager.createdTabs.length, 1);
});

test('the restore guard spans contexts, pending creation, and partial failure, then permits retry', async () => {
  const storage = createStorage({ stashedItems: [savedStash] });
  const first = runManager([], { storage });
  const second = runManager([], { storage });
  const gate = pauseNextCall(first.context.chrome.tabs, 'create');
  const pending = restore(first);
  await gate.started;
  await restore(second);
  assert.deepEqual(second.createdTabs, []);
  first.context.chrome.tabs.create = async () => { throw new Error('Second tab failed'); };
  gate.release();
  await pending;
  assert.equal(first.createdTabs.length, 1);
  assert.deepEqual(first.getItems(), [savedStash]);
  assert.match(first.getElement('notification-message').textContent, /Tabs were opened.*kept/);
  await restore(second);
  assert.equal(second.createdTabs.length, 2);
  assert.deepEqual(second.getItems(), []);
});

test('restore cleanup preserves edits made while tabs are opening', async () => {
  const manager = runManager([savedStash]);
  const gate = pauseNextCall(manager.context.chrome.tabs, 'create');
  const pending = restore(manager);
  await gate.started;
  await manager.context.updateStashData(savedStash.id, 'Newer title', 'red');
  gate.release();
  await pending;
  assert.deepEqual(manager.getItems(), [{ ...savedStash, title: 'Newer title', color: 'red' }]);
  assert.match(manager.getElement('notification-message').textContent, /kept to avoid data loss/);
});

test('stash, individual-tab, and last-tab deletion can each be undone', async () => {
  for (const [stash, action, remaining] of [
    [savedStash, "deleteStash('saved')", []],
    [savedStash, "removeTabFromStash('saved', 0)", [{ ...savedStash, tabs: [savedStash.tabs[1]] }]],
    [{ ...savedStash, tabs: [savedStash.tabs[0]] }, "removeTabFromStash('saved', 0)", []]
  ]) {
    const manager = runManager([stash]);
    await vm.runInContext(action, manager.context);
    assert.deepEqual(manager.getItems(), remaining);
    assert.equal(manager.getElement('notification-undo').hidden, false);
    await manager.getElement('notification-undo').onclick();
    assert.deepEqual(manager.getItems(), [stash]);
    assert.equal(manager.getElement('notification').popoverOpen, false);
  }
});

test('Undo preserves newer stash edits and tabs, and avoids replacing a reused stash ID', async () => {
  const manager = runManager([savedStash]);
  await manager.context.removeTabFromStash('saved', 0);
  const newer = { ...savedStash, title: 'Newer title', color: 'red', tabs: [savedStash.tabs[1], backupStash.tabs[0]] };
  await manager.storage.local.set({ stashedItems: [newer] });
  await manager.context.handleUndo();
  const combined = { ...newer, tabs: [savedStash.tabs[0], ...newer.tabs] };
  assert.deepEqual(manager.getItems(), [combined]);
  await manager.context.deleteStash('saved');
  await manager.storage.local.set({ stashedItems: [newer] });
  await manager.context.handleUndo();
  assert.deepEqual(manager.getItems(), [{ ...combined, id: 'import-id-1' }, newer]);
});

test('failed stash and tab deletions preserve storage without offering a false Undo', async () => {
  for (const action of ["deleteStash('saved')", "removeTabFromStash('saved', 0)"]) {
    const manager = runManager([savedStash], { failStorageSetAt: 1 });
    await vm.runInContext(action, manager.context);
    assert.deepEqual(manager.getItems(), [savedStash]);
    assert.equal(manager.getElement('notification-undo').hidden, true);
    assert.match(manager.getElement('notification-message').textContent, /saved tabs were kept/);
    await manager.context.handleUndo();
    assert.deepEqual(manager.getItems(), [savedStash]);
  }
});

test('failed Undo remains available for retry', async () => {
  const manager = runManager([savedStash], { failStorageSetAt: 2 });
  await manager.context.deleteStash('saved');
  const undo = manager.getElement('notification-undo');
  await undo.onclick();
  assert.deepEqual(manager.getItems(), []);
  assert.equal(undo.hidden, false);
  assert.equal(undo.disabled, false);
  assert.match(manager.getElement('notification-message').textContent, /Try Undo again/);
  await undo.onclick();
  assert.deepEqual(manager.getItems(), [savedStash]);
});

test('pending Undo blocks duplicate clicks and cannot expire during a slow save', async () => {
  const manager = runManager([savedStash]);
  await manager.context.deleteStash('saved');
  const gate = pauseNextCall(manager.storage.local, 'set');
  const undo = manager.getElement('notification-undo');
  const pending = undo.onclick();
  await gate.started;
  await undo.onclick();
  await manager.advanceTime(6000);
  assert.equal(undo.disabled, true);
  assert.equal(manager.getElement('notification').popoverOpen, true);
  gate.release();
  await pending;
  assert.deepEqual(manager.getItems(), [savedStash]);
  assert.equal(manager.storage.writes.length, 2);
});

test('Delete All only clears pending Undo after confirmed, successful deletion', async () => {
  for (const [confirmation, failStorageSetAt] of [['cancel', undefined], ['confirm', undefined], ['confirm', 2]]) {
    const manager = runManager([savedStash, backupStash], { failStorageSetAt });
    await manager.context.deleteStash('saved');
    const pending = manager.context.handleDeleteAll();
    const dialog = manager.getElement('confirm-modal');
    dialog.returnValue = confirmation;
    await dialog.trigger('close');
    await pending;
    const deleted = confirmation === 'confirm' && !failStorageSetAt;
    assert.deepEqual(manager.getItems(), deleted ? [] : [backupStash]);
    assert.equal(manager.getElement('notification-undo').hidden, deleted);
    await manager.context.handleUndo();
    assert.deepEqual(manager.getItems(), deleted ? [] : [savedStash, backupStash]);
  }
});

test('settings default off, save only the changed preference, and persist across managers', async () => {
  for (const preferences of [{}, Object.fromEntries(preferenceKeys.map(key => [key, 'true']))]) {
    const manager = runManager([savedStash], { preferences });
    await manager.getElement('settingsBtn').onclick();
    assert.deepEqual(manager.storage.writes, []);
    for (const key of preferenceKeys) {
      const input = manager.getElement(key);
      assert.equal(input.checked, false);
      assert.equal(input.disabled, false);
      input.checked = true;
      await input.trigger('change');
      assert.deepEqual(manager.storage.writes.at(-1), { [key]: true });
    }
    const reopened = runManager([], { storage: manager.storage });
    await reopened.getElement('settingsBtn').onclick();
    for (const key of preferenceKeys) assert.equal(reopened.getElement(key).checked, true);
    assert.deepEqual(reopened.getItems(), [savedStash]);
  }
});

test('failed preference saves revert every switch and allow retry', async () => {
  for (const key of preferenceKeys) {
    const manager = runManager([savedStash], { preferences: { [key]: true }, failStorageSetAt: 1 });
    await manager.getElement('settingsBtn').onclick();
    const input = manager.getElement(key);
    input.checked = false;
    await input.trigger('change');
    assert.equal(input.checked, true);
    assert.equal(input.disabled, false);
    assert.equal(manager.storage.snapshot()[key], true);
    assert.equal(manager.getElement('settings-error').hidden, false);
    input.checked = false;
    await input.trigger('change');
    assert.equal(manager.storage.snapshot()[key], false);
    assert.equal(manager.getElement('settings-error').hidden, true);
    assert.deepEqual(manager.getItems(), [savedStash]);
  }
});

test('unreadable preferences disable all settings and block unsafe restoration', async () => {
  for (const options of [{ failPreferenceGet: true }, { failStorageGetKey: 'restoreInNewWindow' }]) {
    const manager = runManager([savedStash], options);
    await manager.getElement('settingsBtn').onclick();
    for (const key of preferenceKeys) {
      const input = manager.getElement(key);
      assert.equal(input.disabled, true);
      input.checked = true;
      await input.trigger('change');
    }
    await restore(manager);
    assert.equal(manager.getElement('settings-error').hidden, false);
    assert.deepEqual(manager.createdTabs, []);
    assert.deepEqual(manager.createdWindows, []);
    assert.deepEqual(manager.storage.writes, []);
    assert.deepEqual(manager.getItems(), [savedStash]);
  }
});

test('settings synchronize changes and removals between open managers', async () => {
  const storage = createStorage({ stashedItems: [savedStash] });
  const first = runManager([], { storage });
  const second = runManager([], { storage });
  await Promise.all([first.context.showSettings(), second.context.showSettings()]);
  for (const key of preferenceKeys) {
    first.getElement(key).checked = true;
    await first.getElement(key).trigger('change');
    assert.equal(second.getElement(key).checked, true);
    await storage.local.remove(key);
    assert.equal(second.getElement(key).checked, false);
  }
  assert.deepEqual(second.getItems(), [savedStash]);
});

test('settings discard stale reads after concurrent preference changes', async () => {
  const manager = runManager([]);
  const get = manager.storage.local.get;
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  let reads = 0;
  manager.storage.local.get = async query => {
    const snapshot = await get(query);
    if (++reads === 1) {
      started.resolve();
      await gate.promise;
    }
    return snapshot;
  };
  const loading = manager.context.showSettings();
  await started.promise;
  await manager.storage.local.set({ keepAfterRestore: true });
  gate.resolve();
  await loading;
  assert.equal(reads, 2);
  assert.equal(manager.getElement('keepAfterRestore').checked, true);
});

test('reopening settings preserves pending-save protection through success and failure', async () => {
  for (const failStorageSetAt of [undefined, 1]) {
    const manager = runManager([], { failStorageSetAt });
    await manager.context.showSettings();
    const gate = pauseNextCall(manager.storage.local, 'set');
    const input = manager.getElement('keepAfterRestore');
    input.checked = true;
    const saving = input.trigger('change');
    await gate.started;
    await manager.context.showSettings();
    assert.equal(input.disabled, true);
    await input.trigger('change');
    gate.release();
    await saving;
    assert.equal(input.checked, !failStorageSetAt);
    assert.equal(input.disabled, false);
    assert.equal(manager.storage.writes.length, 1);
    assert.equal(manager.getElement('settings-error').hidden, !failStorageSetAt);
  }
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

test('manifest defines native stash and side-panel shortcuts and no options page', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

  assert.equal(manifest.options_ui, undefined);
  assert.deepEqual(Object.keys(manifest.commands), ['_execute_action', 'open-side-panel']);

  // Allow either a platform-specific object ({ default, mac }) or the legacy string form.
  const openSidePanelKey = manifest.commands['open-side-panel'].suggested_key;
  if (typeof openSidePanelKey === 'string') {
    assert.equal(openSidePanelKey, 'Alt+A');
  } else {
    assert.deepEqual(openSidePanelKey, { default: 'Alt+A', mac: 'Option+A' });
  }

  assert.equal(manifest.permissions.includes('sidePanel'), true);
  assert.equal(manifest.side_panel.default_path, 'src/manager/manager.html');
  assert.equal(manifest.commands._execute_action.suggested_key, 'Alt+S');
});
