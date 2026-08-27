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

/**
 * Updates the toolbar badge to show the current stash count.
 */
const updateBadge = async () => {
  try {
    const result = await chrome.storage.local.get({ [CONFIG.STORAGE_KEY]: [] });
    const items = Array.isArray(result[CONFIG.STORAGE_KEY]) ? result[CONFIG.STORAGE_KEY] : [];
    const count = items.length;
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#1e66f5' });
  } catch (error) {
    console.error("Error updating badge:", error);
  }
};

/**
 * Opens or focuses the Stasher manager tab.
 * @param {number} windowId - The ID of the window to open the manager in.
 * @returns {Promise<object>} The manager tab.
 */
const openManager = async (windowId) => {
  // Check if manager is already open in this window
  const tabs = await chrome.tabs.query({ windowId });
  const managerTab = tabs.find(t => t.url === MANAGER_URL);

  if (managerTab) {
    // If found, highlight it and ensure it's pinned
    await chrome.tabs.update(managerTab.id, { active: true, pinned: true });
    return managerTab;
  }

  // If not found, create it pinned at index 0 (far left)
  return chrome.tabs.create({
    url: MANAGER_URL,
    index: 0,
    pinned: true,
    active: true
  });
};

/**
 * Saves a stash item to local storage.
 * @param {Object} dataItem - The stash item to save.
 */
const saveToStorage = (dataItem) => navigator.locks.request('stasher-storage', async () => {
  const result = await chrome.storage.local.get({ [CONFIG.STORAGE_KEY]: [] });
  const items = Array.isArray(result[CONFIG.STORAGE_KEY]) ? result[CONFIG.STORAGE_KEY] : [];
  await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: [dataItem, ...items] });
});

/**
 * Processes the stashing operation: saves data, opens manager, and removes tabs.
 * @param {Object} stashData - The data to stash.
 * @param {object[]} tabsToRemove - The tabs to close after stashing.
 * @param {number} windowId - The ID of the window to open the manager in.
 */
const processStash = async (stashData, tabsToRemove, windowId) => {
  try {
    if (stashData) {
      await saveToStorage(stashData);
    }
    
    // Always open manager at the end
    await openManager(windowId);
    
    // Only remove tabs if we successfully saved (if there was data)
    if (tabsToRemove.length > 0 && stashData) {
      await chrome.tabs.remove(tabsToRemove.map(t => t.id));
    }
  } catch (error) {
    console.error("Error processing stash:", error);
  }
};

// Keep the badge in sync when the manager changes storage (delete, undo, import, etc.)
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes[CONFIG.STORAGE_KEY]) {
    updateBadge();
  }
});
chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
  chrome.contextMenus.create({
    id: CONFIG.TAB_MENU_ID,
    title: 'Stash this tab',
    contexts: ['tab'],
    documentUrlPatterns: ['http://*/*', 'https://*/*']
  });
});
chrome.runtime.onStartup.addListener(updateBadge);

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
      t.url === MANAGER_URL ||
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

const handleSingleTabStash = async (tab) => {
  const [tabToStash] = filterStashableTabs([tab], true);
  if (!tabToStash) return;

  const title = tabToStash.title || tabToStash.url;
  await processStash({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type: 'loose',
    title,
    color: 'grey',
    tabs: [{ title, url: tabToStash.url }]
  }, [tabToStash], tabToStash.windowId);
};

/**
 * Stashes tabs from the toolbar action or its browser-managed shortcut.
 * @param {object} tab - The tab whose context (window/group) drives the stash.
 */
const handleStash = async (tab) => {
  const currentWindowId = tab.windowId;
  const currentGroupId = tab.groupId;

  try {
    let stashData = null;
    let tabsToStash = [];
    let groupTitle = "Ungrouped Tabs";
    let groupColor = "grey";
    let stashType = 'loose';

    // Chromium allows users to highlight multiple tabs in the tab strip. When
    // they do, that explicit selection takes precedence over the usual
    // group-or-loose-tabs behavior.
    const highlightedTabs = await chrome.tabs.query({
      windowId: currentWindowId,
      highlighted: true
    });

    if (highlightedTabs.length > 1) {
      tabsToStash = filterStashableTabs(highlightedTabs);
      groupTitle = "Selected Tabs";

      const selectedGroupIds = new Set(tabsToStash.map(t => t.groupId));
      if (
        selectedGroupIds.size === 1 &&
        !selectedGroupIds.has(chrome.tabGroups.TAB_GROUP_ID_NONE)
      ) {
        const [selectedGroupId] = selectedGroupIds;
        const group = await chrome.tabGroups.get(selectedGroupId);
        stashType = 'group';
        groupTitle = group.title || "Untitled Group";
        groupColor = group.color;
      }
    }

    // Scenario 1: Stash a specific Tab Group
    else if (currentGroupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
      const group = await chrome.tabGroups.get(currentGroupId);
      const tabsInGroup = await chrome.tabs.query({ groupId: currentGroupId });

      tabsToStash = filterStashableTabs(tabsInGroup);

      stashType = 'group';
      groupTitle = group.title || "Untitled Group";
      groupColor = group.color;
    }

    // Scenario 2: Stash all "loose" (non-grouped) tabs in the window
    else {
      const looseTabs = await chrome.tabs.query({
        windowId: currentWindowId,
        groupId: chrome.tabGroups.TAB_GROUP_ID_NONE
      });

      tabsToStash = filterStashableTabs(looseTabs);
    }

    if (tabsToStash.length > 0) {
      stashData = {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        type: stashType,
        title: groupTitle,
        color: groupColor,
        tabs: tabsToStash.map(t => ({
          title: t.title,
          url: t.url
        }))
      };
    }

    // If stashData is null (no tabs found), processStash will just open the manager
    await processStash(stashData, tabsToStash, currentWindowId);

  } catch (error) {
    console.error("Critical error in handleStash:", error);
    try { await openManager(currentWindowId); } catch (e) { /* ignore */ }
  }
};

chrome.action.onClicked.addListener(handleStash);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === CONFIG.TAB_MENU_ID && tab) {
    await handleSingleTabStash(tab);
  }
});
