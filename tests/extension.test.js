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
    }
  };
}

function runBackground(options = {}) {
  const listeners = {};
  const createdTabs = [];
  const updatedTabs = [];
  const removedTabs = [];
  const contextMenus = [];
  let items = clone(options.items ?? []);
  const permissionRequests = [];
  let groupPermissionGranted = options.groupPermissionGranted !== false;

  const api = {
    runtime: {
      getURL: path => `chrome-extension://stasher/${path}`,
      onInstalled: eventSlot(listeners, 'installed')
    },
    storage: {
      local: {
        get: async () => ({ stashedItems: clone(items) }),
        set: async value => {
          items = clone(value.stashedItems);
        }
      }
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
        if (query.groupId === 7) return clone(options.groupedTabs ?? []);
        if (query.groupId === -1) return clone(options.looseTabs ?? []);
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
    contextMenus,
    permissionRequests,
    getItems: () => clone(items)
  };
}

function createElement(initialClasses = []) {
  const classes = new Set(initialClasses);
  const listeners = new Map();
  const element = {
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
    async trigger(type) {
      await Promise.all((listeners.get(type) ?? []).map(listener => listener({ type, target: this })));
    },
    setAttribute() {},
    focus() {},
    showModal() {},
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
  const documentListeners = {};
  const createdTabs = [];
  const errors = [];
  const groupedTabs = [];
  const updatedGroups = [];
  let items = clone(initialItems);
  let nextTabId = 20;
  let nextImportId = 1;
  let storageSetCalls = 0;
  const elements = new Map();

  const api = {
    runtime: {
      getURL: path => `chrome-extension://stasher/${path}`
    },
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
    permissions: {
      contains: async () => options.groupPermissionGranted !== false
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
    addEventListener(name, listener) {
      documentListeners[name] = listener;
    },
    getElementById(id) {
      if (!elements.has(id)) {
        const initialClasses = id === 'undo-toast' || id === 'info-toast' ? ['hidden'] : [];
        elements.set(id, createElement(initialClasses));
      }
      return elements.get(id);
    },
    createElement,
    querySelector: () => null
  };

  const sessionValues = new Map();
  const context = vm.createContext({
    chrome: api,
    Blob,
    File,
    URL,
    clearTimeout() {},
    console: { error: (...args) => errors.push(args) },
    crypto: { randomUUID: () => `import-id-${nextImportId++}` },
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
    triggerDocumentEvent: (name, event) => documentListeners[name](event),
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
  assert.equal(Object.hasOwn(result.getItems()[0].tabs[0], 'favIconUrl'), false);
  assert.deepEqual(result.removedTabs, [11, 12]);
  assert.deepEqual(result.createdTabs, [{
    id: 100,
    url: 'chrome-extension://stasher/src/manager/manager.html',
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

  assert.match(result.getElement('info-msg').textContent, /too many stash items/i);
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
  assert.match(result.getElement('info-msg').textContent, /Imported 2 new stashes/);

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
  assert.match(result.getElement('info-msg').textContent, /Imported 2 new stashes/);
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
    assert.match(result.getElement('info-msg').textContent, /Nothing was imported/);
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

    assert.match(result.getElement('info-msg').textContent, message);
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
  assert.match(result.getElement('info-msg').textContent, /Import failed: Storage update failed/);

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
  vm.runInContext("showModal = async () => 'confirm'", result.context);
  await assert.rejects(vm.runInContext('handleDeleteAll()', result.context));

  assert.deepEqual(result.getItems(), [remaining]);
  assert.equal(result.getElement('undo-toast').classList.contains('hidden'), false);

  await vm.runInContext('handleUndo()', result.context);

  assert.deepEqual(result.getItems(), [deleted, remaining]);
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
