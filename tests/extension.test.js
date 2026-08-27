const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
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
    }
  };
}

function runBackground(options = {}) {
  const listeners = {};
  const createdTabs = [];
  const updatedTabs = [];
  const removedTabs = [];
  const badges = [];
  const contextMenus = [];
  let items = clone(options.items ?? []);

  const api = {
    runtime: {
      getURL: path => `chrome-extension://stasher/${path}`,
      onInstalled: eventSlot(listeners, 'installed'),
      onStartup: eventSlot(listeners, 'startup')
    },
    storage: {
      local: {
        get: async () => ({ stashedItems: clone(items) }),
        set: async value => {
          items = clone(value.stashedItems);
        }
      },
      onChanged: eventSlot(listeners, 'storageChanged')
    },
    action: {
      setBadgeText: async details => badges.push(['text', clone(details)]),
      setBadgeBackgroundColor: async details => badges.push(['color', clone(details)]),
      onClicked: eventSlot(listeners, 'actionClicked')
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
        if (query.groupId === 7) return clone(options.groupedTabs ?? []);
        if (query.groupId === -1) return clone(options.looseTabs ?? []);
        if (query.active) return clone(options.activeTabs ?? []);
        if (query.windowId !== undefined) return clone(options.windowTabs ?? []);
        return [];
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
    console,
    crypto: { randomUUID: () => 'stash-id' },
    navigator: {
      locks: {
        request: (_name, callback) => callback()
      }
    },
    URL
  });
  vm.runInContext(backgroundSource, context);

  return {
    listeners,
    createdTabs,
    updatedTabs,
    removedTabs,
    badges,
    contextMenus,
    getItems: () => clone(items)
  };
}

function createElement(initialClasses = []) {
  const classes = new Set(initialClasses);
  const element = {
    children: [],
    append(...children) {
      this.children.push(...children);
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    focus() {},
    select() {},
    showModal() {},
    querySelectorAll: () => [],
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
  const listeners = {};
  const createdTabs = [];
  const errors = [];
  const groupedTabs = [];
  const updatedGroups = [];
  let items = clone(initialItems);
  let nextTabId = 20;
  let storageSetCalls = 0;
  const elements = new Map();

  const api = {
    storage: {
      local: {
        get: async () => ({ stashedItems: clone(items) }),
        set: async value => {
          storageSetCalls += 1;
          if (storageSetCalls === options.failStorageSetAt) {
            throw new Error('Storage update failed');
          }
          items = clone(value.stashedItems);
        }
      },
      onChanged: eventSlot(listeners, 'storageChanged')
    },
    tabs: {
      create: async details => {
        if (options.failTabCreation) throw new Error('Tab creation failed');
        const tab = { id: nextTabId++, ...clone(details) };
        createdTabs.push(tab);
        return tab;
      },
      group: async details => {
        if (options.failTabGrouping) throw new Error('Tab grouping failed');
        groupedTabs.push(clone(details));
        return 8;
      }
    },
    tabGroups: {
      update: async (id, details) => {
        updatedGroups.push([id, clone(details)]);
      }
    }
  };

  const document = {
    activeElement: null,
    getElementById(id) {
      if (!elements.has(id)) {
        const initialClasses = id === 'undo-toast' || id === 'info-toast' ? ['hidden'] : [];
        elements.set(id, createElement(initialClasses));
      }
      return elements.get(id);
    },
    createElement,
    createDocumentFragment: createElement,
    querySelector: () => null
  };

  const sessionValues = new Map();
  const context = vm.createContext({
    chrome: api,
    Blob,
    URL,
    clearTimeout() {},
    console: { error: (...args) => errors.push(args) },
    crypto: {
      randomUUID: (() => {
        let id = 0;
        return () => `imported-${++id}`;
      })()
    },
    document,
    navigator: {
      locks: {
        request: (_name, callback) => callback()
      }
    },
    sessionStorage: {
      getItem: key => sessionValues.get(key) ?? null,
      setItem: (key, value) => sessionValues.set(key, value),
      removeItem: key => sessionValues.delete(key)
    },
    setTimeout: () => 0,
    structuredClone
  });
  vm.runInContext(managerSource, context);

  return {
    context,
    createdTabs,
    errors,
    groupedTabs,
    updatedGroups,
    getElement: id => elements.get(id),
    getItems: () => clone(items)
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
  assert.deepEqual(result.removedTabs, [11, 12]);
  assert.deepEqual(result.createdTabs, [{
    id: 100,
    url: 'chrome-extension://stasher/src/manager/manager.html',
    index: 0,
    pinned: true,
    active: true
  }]);
});

test('updates the badge when stash storage changes', async () => {
  const result = runBackground({ items: [{ id: 'saved-stash' }] });

  result.listeners.storageChanged({ stashedItems: {} }, 'local');
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(result.badges.at(-2), ['text', { text: '1' }]);
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
  assert.equal(result.getItems()[0].title, 'Pinned page');
  assert.deepEqual(result.getItems()[0].tabs, [{
    title: 'Pinned page',
    url: 'https://pinned.example'
  }]);
  assert.deepEqual(result.removedTabs, [51]);
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

test('stashes an eligible mixed selection without closing excluded tabs', async () => {
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
  assert.equal(result.getItems()[0].title, 'Selected Tabs');
  assert.deepEqual(result.getItems()[0].tabs, [
    { title: 'Grouped', url: 'https://grouped.example' },
    { title: 'Loose', url: 'https://loose.example' }
  ]);
  assert.deepEqual(result.removedTabs, [41, 42]);
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
  assert.equal(result.getElement('undo-toast').classList.contains('hidden'), false);

  await vm.runInContext('handleUndo()', result.context);

  assert.deepEqual(result.getItems(), [stash]);
  assert.equal(result.getElement('undo-toast').classList.contains('hidden'), true);
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
  assert.equal(result.getElement('undo-toast').classList.contains('hidden'), false);

  await vm.runInContext('handleUndo()', result.context);

  assert.deepEqual(result.getItems(), [stash]);
  assert.equal(result.getElement('undo-toast').classList.contains('hidden'), true);
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
  assert.equal(result.getElement('undo-toast').classList.contains('hidden'), true);

  await vm.runInContext('handleUndo()', result.context);

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

  for (const failure of ['failTabCreation', 'failTabGrouping']) {
    const result = runManager([stash], { [failure]: true });

    await vm.runInContext(`restoreGroup(${JSON.stringify(stash)})`, result.context);

    assert.deepEqual(result.getItems(), [stash]);
    assert.equal(result.errors.length, 1);
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
  assert.equal(result.getElement('info-toast').classList.contains('hidden'), false);
  assert.match(result.getElement('info-msg').textContent, /kept to avoid data loss/i);
});

test('search matches stash titles, tab titles, and URLs', () => {
  const result = runManager([]);
  const stash = {
    title: 'Research',
    tabs: [{ title: 'Chromium docs', url: 'https://developer.chrome.com' }]
  };

  result.context.testStash = stash;
  assert.equal(vm.runInContext("stashMatchesQuery(testStash, 'research')", result.context), true);
  assert.equal(vm.runInContext("stashMatchesQuery(testStash, 'CHROMIUM')", result.context), true);
  assert.equal(vm.runInContext("stashMatchesQuery(testStash, 'developer.chrome')", result.context), true);
  assert.equal(vm.runInContext("stashMatchesQuery(testStash, 'missing')", result.context), false);
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

test('parses URL-list text into blank-line-separated stashes and skips invalid rows', () => {
  const result = runManager([]);
  result.context.importText = [
    'https://one.example | One',
    'not a URL | Invalid',
    '',
    'https://two.example/path | Two | With separator'
  ].join('\n');

  const parsed = clone(vm.runInContext('parseImportedContent(importText)', result.context));

  assert.equal(parsed.skipped, 1);
  assert.equal(parsed.items.length, 2);
  assert.deepEqual(parsed.items.map(item => item.tabs), [
    [{ url: 'https://one.example', title: 'One' }],
    [{ url: 'https://two.example/path', title: 'Two | With separator' }]
  ]);
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

  await vm.runInContext('handleImport(importEvent)', result.context);

  assert.equal(result.getItems().length, 2);
  assert.equal(result.getItems().filter(item => item.id === 'same-id').length, 1);
  assert.equal(result.getItems()[0].title, 'Imported replacement');
  assert.equal(result.getItems()[1].id, 'new-id');
});

test('rejects Stasher JSON over the item limit', () => {
  const result = runManager([]);
  result.context.tooManyItems = JSON.stringify(Array.from({ length: 1001 }, () => ({})));

  const parsed = clone(vm.runInContext('parseImportedContent(tooManyItems)', result.context));

  assert.match(parsed.error, /too many stash items/i);
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
  vm.runInContext('showConfirmModal = async () => true', result.context);
  await vm.runInContext('handleDeleteAll()', result.context);

  assert.deepEqual(result.getItems(), []);
  assert.equal(result.getElement('undo-toast').classList.contains('hidden'), true);

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
  vm.runInContext('showConfirmModal = async () => true', result.context);
  await assert.rejects(vm.runInContext('handleDeleteAll()', result.context));

  assert.deepEqual(result.getItems(), [remaining]);
  assert.equal(result.getElement('undo-toast').classList.contains('hidden'), false);

  await vm.runInContext('handleUndo()', result.context);

  assert.deepEqual(result.getItems(), [deleted, remaining]);
});

test('manifest defines a Chromium MV3 service worker', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(
    manifest.background.service_worker,
    'src/background/service-worker.js'
  );
  assert.equal(manifest.permissions.includes('contextMenus'), true);
});

test('manifest defines one browser-managed action shortcut and no options page', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

  assert.equal(manifest.options_ui, undefined);
  assert.deepEqual(Object.keys(manifest.commands), ['_execute_action']);
  assert.equal(manifest.commands._execute_action.suggested_key, 'Alt+Shift+S');
});
