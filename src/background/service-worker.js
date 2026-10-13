importScripts('../shared/search.js');

// Background owner of privileged tab, group, storage, and context-menu work.
// It persists all user data because Manifest V3 service workers can stop at any time.

// Constants and Configuration
const CONFIG = {
  MANAGER_PATH: 'src/manager/manager.html',
  STORAGE_KEY: 'stashedItems',
  TAB_MENU_ID: 'stash-tab',
  IGNORED_URLS: [
    'chrome://newtab/',
    'about:blank'
  ],
  ALLOWED_SCHEMES: ['http:', 'https:', 'chrome-extension:']
};

const MANAGER_URL = chrome.runtime.getURL(CONFIG.MANAGER_PATH);
const UNGROUPED_ID = -1;
const isManagerUrl = url => typeof url === 'string' && url.split(/[?#]/, 1)[0] === MANAGER_URL;

/**
 * Opens or focuses the Stasher manager tab.
 * @param {number} windowId - The ID of the window to open the manager in.
 * @param {boolean} active - Whether to select the manager tab.
 */
const openManager = async (windowId, active = true) => {
  // Check if manager is already open in this window
  const tabs = await chrome.tabs.query({ windowId });
  const managerTab = tabs.find(t => isManagerUrl(t.url) || isManagerUrl(t.pendingUrl));

  if (managerTab) {
    // Pin the existing manager, selecting it for manual actions.
    await chrome.tabs.update(managerTab.id, { ...(active ? { active: true } : {}), pinned: true });
  } else {
    // If not found, create it pinned at index 0 (far left)
    await chrome.tabs.create({
      url: MANAGER_URL,
      windowId,
      index: 0,
      pinned: true,
      active
    });
  }
};

let openedOnStartup = false;
const openStartupManager = async window => {
  if (window.type !== 'normal' || window.incognito) return;
  try {
    const { awaitingStartupWindow } = await chrome.storage.session.get({ awaitingStartupWindow: false });
    if (awaitingStartupWindow !== true || openedOnStartup) return;
    openedOnStartup = true;
    chrome.windows.onCreated.removeListener(openStartupManager);
    await chrome.storage.session.remove('awaitingStartupWindow');
    // Session-restored tabs may expose only pendingUrl while loading.
    const tabs = await chrome.tabs.query({ windowType: 'normal' });
    const existing = tabs.find(tab => !tab.incognito &&
      (isManagerUrl(tab.url) || isManagerUrl(tab.pendingUrl)));
    if (existing) await chrome.tabs.update(existing.id, { pinned: true });
    else await openManager(window.id, false);
  } catch (error) {
    console.error('Error opening Stasher on startup:', error);
  }
};

// Register synchronously; session storage keeps the wait alive across worker suspension.
chrome.windows.onCreated.addListener(openStartupManager);
chrome.runtime.onStartup.addListener(async () => {
  try {
    const { openOnStartup } = await chrome.storage.local.get({ openOnStartup: false });
    if (openOnStartup !== true) {
      chrome.windows.onCreated.removeListener(openStartupManager);
      return;
    }
    await chrome.storage.session.set({ awaitingStartupWindow: true });
    const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    const window = windows.find(w => !w.incognito && w.focused) || windows.find(w => !w.incognito);
    if (window) await openStartupManager(window);
  } catch (error) {
    console.error('Error reading startup preference:', error);
  }
});

/**
 * Saves a stash item to local storage.
 * @param {Object} dataItem - The stash item to save.
 */
// The shared lock serializes stashes that arrive from separate browser events.
const saveToStorage = (dataItem) => navigator.locks.request('stasher-storage', async () => {
  const result = await chrome.storage.local.get({ [CONFIG.STORAGE_KEY]: [], skipDuplicates: false });
  const items = Array.isArray(result[CONFIG.STORAGE_KEY]) ? result[CONFIG.STORAGE_KEY] : [];
  let tabs = dataItem.tabs;
  if (result.skipDuplicates === true) {
    const urls = new Set(items.flatMap(item => Array.isArray(item?.tabs) ? item.tabs.map(tab => tab?.url) : []));
    tabs = tabs.filter(tab => {
      if (urls.has(tab.url)) return false;
      urls.add(tab.url);
      return true;
    });
  }
  if (tabs.length === 0) return;
  await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: [{ ...dataItem, tabs }, ...items] });
});

chrome.runtime.onInstalled.addListener(() => {
  // Context-menu registration belongs to installation/update, not worker startup.
  chrome.contextMenus.create({
    id: CONFIG.TAB_MENU_ID,
    title: 'Stash this tab',
    contexts: ['tab'],
    documentUrlPatterns: ['http://*/*', 'https://*/*']
  });
});

/**
 * Helper to filter valid tabs for stashing.
 * @param {object[]} tabs - The list of tabs to filter.
 * @param {boolean} allowPinned - Whether an explicitly selected pinned tab is allowed.
 * @returns {object[]} Filtered list of tabs.
 */
const filterStashableTabs = (tabs, allowPinned = false) => {
  return tabs.filter(t => {
    if (
      (!allowPinned && t.pinned) ||
      isManagerUrl(t.url) ||
      CONFIG.IGNORED_URLS.includes(t.url)
    ) return false;
    try {
      const scheme = new URL(t.url).protocol;
      return CONFIG.ALLOWED_SCHEMES.includes(scheme);
    } catch {
      return false;
    }
  });
};

/**
 * Stashes tabs using the tab's current browser context.
 * @param {object} tab - The tab whose context (window/group) drives the stash.
 * @param {boolean} singleTab - Whether to stash only this tab.
 */
const handleStash = async (tab, singleTab = false) => {
  const currentWindowId = tab.windowId;
  const currentGroupId = tab.groupId;

  try {
    let stashData = null;
    let tabsToStash = [];
    let tabGroup;
    // Request before other awaits so Chrome sees the toolbar click's user gesture.
    const canReadGroups = !singleTab && await chrome.permissions.request({
      permissions: ['tabGroups']
    }).catch(() => false);

    // Chromium allows users to highlight multiple tabs in the tab strip. When
    // they do, that explicit selection takes precedence over the usual
    // group-or-loose-tabs behavior.
    const highlightedTabs = singleTab ? [] : await chrome.tabs.query({
      windowId: currentWindowId,
      highlighted: true
    });

    if (singleTab) {
      tabsToStash = filterStashableTabs([tab], true);
    } else if (highlightedTabs.length > 1) {
      tabsToStash = filterStashableTabs(highlightedTabs);

      const selectedGroupIds = new Set(tabsToStash.map(t => t.groupId));
      if (
        selectedGroupIds.size === 1 &&
        !selectedGroupIds.has(UNGROUPED_ID) && canReadGroups
      ) {
        const [selectedGroupId] = selectedGroupIds;
        tabGroup = await chrome.tabGroups.get(selectedGroupId);
      }
    }

    // Scenario 1: Stash a specific Tab Group
    else if (currentGroupId !== UNGROUPED_ID) {
      if (canReadGroups) tabGroup = await chrome.tabGroups.get(currentGroupId);
      const tabsInGroup = await chrome.tabs.query({ groupId: currentGroupId });

      tabsToStash = filterStashableTabs(tabsInGroup);
    }

    // Scenario 2: Stash all "loose" (non-grouped) tabs in the window
    else {
      const looseTabs = await chrome.tabs.query({
        windowId: currentWindowId,
        groupId: UNGROUPED_ID
      });

      tabsToStash = filterStashableTabs(looseTabs);
    }

    if (tabsToStash.length > 0) {
      stashData = {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        type: tabGroup ? 'group' : 'loose',
        tabs: tabsToStash.map(t => ({
          title: t.title || t.url,
          url: t.url
        }))
      };
      if (tabGroup) {
        stashData.title = tabGroup.title || "Untitled Group";
        stashData.color = tabGroup.color;
      }
    }

    if (stashData) {
      // Persist before closing any tabs so a storage failure cannot lose them.
      await saveToStorage(stashData);
    }
    await openManager(currentWindowId);
    if (stashData) await chrome.tabs.remove(tabsToStash.map(t => t.id));

  } catch (error) {
    console.error("Critical error in handleStash:", error);
    try { await openManager(currentWindowId); } catch (e) { /* ignore */ }
  }
};

chrome.action.onClicked.addListener(handleStash);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === CONFIG.TAB_MENU_ID && tab) {
    // A tab-strip click stashes exactly the chosen tab, including a pinned tab.
    await handleStash(tab, true);
  }
});


let searchRevision = 0;
const escapeDescription = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
})[character]);
chrome.omnibox.setDefaultSuggestion({ description: 'Search saved tabs in Stasher' });
chrome.omnibox.onInputChanged.addListener(async (query, suggest) => {
  const revision = ++searchRevision;
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) { suggest([]); return; }
  try {
    const { stashedItems } = await chrome.storage.local.get({ stashedItems: [] });
    if (revision !== searchRevision) return;
    const results = [];
    search: for (const stash of rankStashesByQuery(Array.isArray(stashedItems) ? stashedItems : [], query)) {
      const nameMatches = String(stash.title || '').toLocaleLowerCase().includes(normalized);
      for (const tab of filterStashableTabs(Array.isArray(stash.tabs) ? stash.tabs : [], true)) {
        if (!nameMatches && !String(tab.title || '').toLocaleLowerCase().includes(normalized) && !tab.url.toLocaleLowerCase().includes(normalized)) continue;
        if (results.some(result => result.content === tab.url)) continue;
        results.push({ content: tab.url, description: escapeDescription(`${tab.title || tab.url} — ${stash.title || 'Stash'}`) });
        if (results.length === 5) break search;
      }
    }
    suggest(results);
  } catch (error) {
    console.error('Error searching saved tabs:', error);
    if (revision === searchRevision) suggest([]);
  }
});
chrome.omnibox.onInputCancelled.addListener(() => { searchRevision++; });
chrome.omnibox.onInputEntered.addListener(async (content, disposition) => {
  searchRevision++;
  const url = filterStashableTabs([{ url: content }], true).length
    ? content : `${MANAGER_URL}#search=${encodeURIComponent(content)}`;
  try {
    if (disposition === 'currentTab') await chrome.tabs.update({ url });
    else await chrome.tabs.create({ url, active: disposition !== 'newBackgroundTab' });
  } catch (error) {
    console.error('Error opening search result:', error);
  }
});
