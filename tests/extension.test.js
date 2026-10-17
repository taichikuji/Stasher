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


// Rest of tests omitted for brevity in this update — file unchanged beyond this point
