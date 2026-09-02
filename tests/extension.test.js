// Small regression suite for the extension's core data-moving paths.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = join(__dirname, '..');
const backgroundSource = readFileSync(join(root, 'src/background/service-worker.js'), 'utf8');
const managerSource = readFileSync(join(root, 'src/manager/manager.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));

function eventSlot(listeners, name) {
  return { addListener(listener) { listeners[name] = listener; } };
}

function runBackground() {
  const listeners = {};
  const menus = [];
  const removedTabs = [];
  let items = [];

  vm.runInNewContext(backgroundSource, {
    chrome: {
      runtime: {
        getURL: path => `chrome-extension://stasher/${path}`,
        onInstalled: eventSlot(listeners, 'installed'),
        onStartup: eventSlot(listeners, 'startup')
      },
      storage: {
        local: {
          get: async () => ({ stashedItems: clone(items) }),
          set: async value => { items = clone(value.stashedItems); }
        },
        onChanged: eventSlot(listeners, 'storageChanged')
      },
      action: {
        setBadgeText: async () => {},
        setBadgeBackgroundColor: async () => {},
        onClicked: eventSlot(listeners, 'actionClicked')
      },
      contextMenus: {
        create: details => menus.push(clone(details)),
        onClicked: eventSlot(listeners, 'contextMenuClicked')
      },
      tabGroups: { TAB_GROUP_ID_NONE: -1 },
      tabs: {
        query: async () => [],
        create: async details => ({ id: 100, ...details }),
        remove: async ids => { removedTabs.push(...ids); }
      }
    },
    console: { error() {} },
    crypto: { randomUUID: () => 'stash-id' },
    navigator: { locks: { request: (_name, callback) => callback() } },
    URL
  });

  return { listeners, menus, removedTabs, getItems: () => clone(items) };
}

function createElement() {
  const classes = new Set();
  const element = {
    children: [],
    style: {},
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); return child; },
    addEventListener() {},
    click() {},
    closest: () => null,
    focus() {},
    querySelectorAll: () => [],
    setAttribute() {},
    classList: {
      add: (...names) => names.forEach(name => classes.add(name)),
      contains: name => classes.has(name),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      toggle(name) { classes.has(name) ? classes.delete(name) : classes.add(name); }
    }
  };
  Object.defineProperty(element, 'innerHTML', {
    get: () => '',
    set: () => { element.children = []; }
  });
  return element;
}

function runManager(initialItems) {
  const elements = new Map();
  const createdTabs = [];
  const groupedTabs = [];
  const updatedGroups = [];
  let items = clone(initialItems);
  let nextTabId = 20;
  const document = {
    body: createElement(),
    addEventListener() {},
    createDocumentFragment: createElement,
    createElement,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createElement());
      return elements.get(id);
    },
    querySelector: () => null
  };

  const context = vm.createContext({
    chrome: {
      storage: {
        local: {
          get: async () => ({ stashedItems: clone(items) }),
          set: async value => { items = clone(value.stashedItems); }
        },
        onChanged: eventSlot({}, 'storageChanged')
      },
      tabs: {
        create: async details => {
          const tab = { id: nextTabId++, ...clone(details) };
          createdTabs.push(tab);
          return tab;
        },
        group: async details => { groupedTabs.push(clone(details)); return 8; }
      },
      tabGroups: { update: async (id, details) => updatedGroups.push([id, clone(details)]) }
    },
    Blob,
    URL,
    clearTimeout() {},
    console: { error() {} },
    document,
    navigator: { locks: { request: (_name, callback) => callback() } },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
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

test('registers the tab-strip menu and stashes exactly the chosen tab', async () => {
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

  assert.deepEqual(result.menus, [{
    id: 'stash-tab',
    title: 'Stash this tab',
    contexts: ['tab'],
    documentUrlPatterns: ['http://*/*', 'https://*/*']
  }]);
  assert.deepEqual(result.getItems()[0].tabs, [{ title: 'Pinned page', url: 'https://pinned.example' }]);
  assert.deepEqual(result.removedTabs, [51]);
});

test('restores a grouped stash before removing its saved copy', async () => {
  const stash = {
    id: 'restore-me',
    type: 'group',
    title: 'Restored',
    color: 'purple',
    tabs: [
      { title: 'One', url: 'https://one.example' },
      { title: 'Two', url: 'https://two.example' }
    ]
  };
  const result = runManager([stash]);

  result.context.stash = stash;
  await vm.runInContext('restoreGroup(stash)', result.context);

  assert.deepEqual(result.createdTabs.map(({ id, ...tab }) => tab), [
    { url: 'https://one.example', active: false },
    { url: 'https://two.example', active: false }
  ]);
  assert.deepEqual(result.groupedTabs, [{ tabIds: [20, 21] }]);
  assert.deepEqual(result.updatedGroups, [[8, { title: 'Restored', color: 'purple', collapsed: false }]]);
  assert.deepEqual(result.getItems(), []);
});

test('declares the extension contract and accessible manager controls', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const managerHtml = readFileSync(join(root, 'src/manager/manager.html'), 'utf8');

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, 'src/background/service-worker.js');
  assert.equal(manifest.permissions.includes('contextMenus'), true);
  for (const [size, path] of Object.entries(manifest.icons)) {
    const image = readFileSync(join(root, path));
    assert.equal(image.readUInt32BE(16), Number(size));
    assert.equal(image.readUInt32BE(20), Number(size));
  }
  assert.match(managerHtml, /<main id="stash-container" tabindex="-1">/);
  assert.match(managerHtml, /role="status" aria-atomic="true"/);
  assert.match(managerSource, /dot\.type = 'radio'/);
  assert.doesNotMatch(managerSource, /dblclick/);
});
