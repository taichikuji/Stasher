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
  const contextMenus = [];
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
    contextMenus: {
      create: details => contextMenus.push(clone(details)),
      onClicked: eventSlot(listeners, 'contextMenuClicked')
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
    contextMenus,
    getItems: () => clone(items)
  };
}

function createElement() {
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
      add() {},
      remove() {},
      toggle: () => false
    }
  };
}

function runManager(apiNamespace, initialItems) {
  const listeners = {};
  const createdTabs = [];
  const groupedTabs = [];
  const updatedGroups = [];
  let items = clone(initialItems);
  let nextTabId = 20;
  const elements = new Map();

  const api = {
    storage: {
      local: {
        get: async () => ({ stashedItems: clone(items) }),
        set: async value => {
          items = clone(value.stashedItems);
        }
      },
      onChanged: eventSlot(listeners, 'storageChanged')
    },
    tabs: {
      create: async details => {
        const tab = { id: nextTabId++, ...clone(details) };
        createdTabs.push(tab);
        return tab;
      },
      group: async details => {
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
      if (!elements.has(id)) elements.set(id, createElement());
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
    console,
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
    groupedTabs,
    updatedGroups,
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

  test(`stashes only valid loose tabs through the ${apiNamespace} API`, async () => {
    const result = runBackground(apiNamespace, {
      looseTabs: [
        { id: 21, title: 'Kept', url: 'https://kept.example', windowId: 4, groupId: -1 },
        { id: 22, title: 'Pinned', url: 'https://pinned.example', pinned: true, windowId: 4, groupId: -1 },
        { id: 23, title: 'New tab', url: 'about:newtab', windowId: 4, groupId: -1 }
      ]
    });

    await result.listeners.contextMenuClicked(
      { menuItemId: 'stash-all-loose' },
      { id: 21, url: 'https://kept.example', windowId: 4, groupId: 99 }
    );

    assert.deepEqual(result.getItems()[0].tabs, [
      { title: 'Kept', url: 'https://kept.example' }
    ]);
    assert.deepEqual(result.removedTabs, [21]);
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
  });
}

test('manifest declares supported browser settings', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(
    manifest.background.service_worker,
    'src/background/service-worker.js'
  );
  assert.deepEqual(
    manifest.background.scripts,
    ['src/background/service-worker.js']
  );
  assert.deepEqual(manifest.browser_specific_settings.gecko, {
    id: 'stasher@taichikuji.github.io',
    strict_min_version: '140.0',
    data_collection_permissions: {
      required: ['none']
    }
  });
});
