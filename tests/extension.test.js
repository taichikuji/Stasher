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

function runBackground(apiNamespace, options = {}) {
  const listeners = {};
  const createdTabs = [];
  const updatedTabs = [];
  const removedTabs = [];
  const badges = [];
  let items = clone(options.items ?? []);

  const api = {
    runtime: {
      getURL: path => `moz-extension://stasher/${path}`,
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
    commands: {
      onCommand: eventSlot(listeners, 'command')
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
    [apiNamespace]: api,
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
    getItems: () => clone(items)
  };
}

function createElement(initialClasses = []) {
  const classes = new Set(initialClasses);
  return {
    append() {},
    appendChild() {},
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
}

function runManager(apiNamespace, initialItems, options = {}) {
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
    [apiNamespace]: api,
    Blob,
    URL,
    clearTimeout() {},
    console: { error: (...args) => errors.push(args) },
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

for (const apiNamespace of ['browser', 'chrome']) {
  test(`stashes a tab group through the ${apiNamespace} API`, async () => {
    const result = runBackground(apiNamespace, {
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
      url: 'moz-extension://stasher/src/manager/manager.html',
      index: 0,
      pinned: true,
      active: true
    }]);
    assert.deepEqual(result.badges.at(-2), ['text', { text: '1' }]);
  });

  test(`stashes eligible loose tabs through the ${apiNamespace} API`, async () => {
    const managerUrl = 'moz-extension://stasher/src/manager/manager.html';
    const result = runBackground(apiNamespace, {
      activeTabs: [{ id: 21, windowId: 4, groupId: -1, url: 'https://one.example' }],
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

    await result.listeners.command('stash-tabs');

    assert.deepEqual(result.getItems()[0].tabs, [
      { title: 'One', url: 'https://one.example' },
      { title: 'Two', url: 'http://two.example' }
    ]);
    assert.deepEqual(result.removedTabs, [21, 22]);
    assert.deepEqual(result.createdTabs, []);
    assert.deepEqual(result.updatedTabs, [{ id: 90, active: true, pinned: true }]);
  });

  test(`undoes explicit stash deletion through the ${apiNamespace} API`, async () => {
    const stash = {
      id: 'delete-me',
      title: 'Delete me',
      tabs: [{ title: 'One', url: 'https://one.example' }]
    };
    const result = runManager(apiNamespace, [stash]);

    await vm.runInContext("deleteStash('delete-me')", result.context);

    assert.deepEqual(result.getItems(), []);
    assert.equal(result.getElement('undo-toast').classList.contains('hidden'), false);

    await vm.runInContext('handleUndo()', result.context);

    assert.deepEqual(result.getItems(), [stash]);
    assert.equal(result.getElement('undo-toast').classList.contains('hidden'), true);
  });

  test(`undoes individual-tab deletion through the ${apiNamespace} API`, async () => {
    const stash = {
      id: 'trim-me',
      title: 'Trim me',
      tabs: [
        { title: 'One', url: 'https://one.example' },
        { title: 'Two', url: 'https://two.example' }
      ]
    };
    const result = runManager(apiNamespace, [stash]);

    await vm.runInContext("removeTabFromStash('trim-me', 0)", result.context);

    assert.deepEqual(result.getItems()[0].tabs, [stash.tabs[1]]);
    assert.equal(result.getElement('undo-toast').classList.contains('hidden'), false);

    await vm.runInContext('handleUndo()', result.context);

    assert.deepEqual(result.getItems(), [stash]);
    assert.equal(result.getElement('undo-toast').classList.contains('hidden'), true);
  });

  test(`restores a tab group through the ${apiNamespace} API`, async () => {
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
    const result = runManager(apiNamespace, [stash]);

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
}

test('keeps a stash when restoration fails before cleanup', async () => {
  const stash = {
    id: 'keep-me',
    type: 'group',
    title: 'Keep me',
    color: 'blue',
    tabs: [{ title: 'One', url: 'https://one.example' }]
  };

  for (const failure of ['failTabCreation', 'failTabGrouping']) {
    const result = runManager('browser', [stash], { [failure]: true });

    await vm.runInContext(`restoreGroup(${JSON.stringify(stash)})`, result.context);

    assert.deepEqual(result.getItems(), [stash]);
    assert.equal(result.errors.length, 1);
  }
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
  const result = runManager('browser', [deleted, remaining]);

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
  const result = runManager('browser', [deleted, remaining], { failStorageSetAt: 2 });

  await vm.runInContext("deleteStash('deleted-first')", result.context);
  vm.runInContext('showConfirmModal = async () => true', result.context);
  await assert.rejects(vm.runInContext('handleDeleteAll()', result.context));

  assert.deepEqual(result.getItems(), [remaining]);
  assert.equal(result.getElement('undo-toast').classList.contains('hidden'), false);

  await vm.runInContext('handleUndo()', result.context);

  assert.deepEqual(result.getItems(), [deleted, remaining]);
});

test('base manifest is Chromium-first', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(
    manifest.background.service_worker,
    'src/background/service-worker.js'
  );
  assert.equal(manifest.browser_specific_settings, undefined);
  assert.equal(manifest.permissions.includes('contextMenus'), false);
});
