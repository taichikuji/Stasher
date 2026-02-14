// Constants and Configuration
const CONFIG = {
  MANAGER_PATH: 'src/manager/manager.html',
  STORAGE_KEY: 'stashedItems',
  IGNORED_URLS: [
    'chrome://newtab/',
    'about:blank'
  ]
};

/**
 * Opens or focuses the Stasher manager tab.
 * @param {number} windowId - The ID of the window to open the manager in.
 * @returns {Promise<chrome.tabs.Tab>} The manager tab.
 */
const openManager = async (windowId) => {
  const managerUrl = chrome.runtime.getURL(CONFIG.MANAGER_PATH);
  
  // Check if manager is already open in this window
  const tabs = await chrome.tabs.query({ windowId });
  const managerTab = tabs.find(t => t.url === managerUrl);

  if (managerTab) {
    // If found, highlight it and ensure it's pinned
    await chrome.tabs.update(managerTab.id, { active: true, pinned: true });
    return managerTab;
  } else {
    // If not found, create it pinned at index 0 (far left)
    return await chrome.tabs.create({ 
      url: managerUrl, 
      index: 0, 
      pinned: true, 
      active: true 
    });
  }
};

/**
 * Saves a stash item to local storage.
 * @param {Object} dataItem - The stash item to save.
 */
const saveToStorage = async (dataItem) => {
  try {
    const result = await chrome.storage.local.get({ [CONFIG.STORAGE_KEY]: [] });
    // Add new item to the beginning of the list
    const newItems = [dataItem, ...result[CONFIG.STORAGE_KEY]];
    await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: newItems });
  } catch (error) {
    console.error("Error saving to storage:", error);
    throw error; // Re-throw to be handled by caller
  }
};

/**
 * Processes the stashing operation: saves data, opens manager, and removes tabs.
 * @param {Object} stashData - The data to stash.
 * @param {chrome.tabs.Tab[]} tabsToRemove - The tabs to close after stashing.
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
    // If saving failed, we might still want to open the manager so the user sees something happened
    // but we generally shouldn't delete the tabs if save failed.
    if (!stashData) {
        await openManager(windowId);
    }
  }
};

/**
 * Helper to filter valid tabs for stashing.
 * @param {chrome.tabs.Tab[]} tabs - The list of tabs to filter.
 * @returns {chrome.tabs.Tab[]} Filtered list of tabs.
 */
const filterStashableTabs = (tabs) => {
  const managerUrl = chrome.runtime.getURL(CONFIG.MANAGER_PATH);
  return tabs.filter(t => 
    !t.pinned && 
    t.url !== managerUrl &&
    !CONFIG.IGNORED_URLS.includes(t.url)
  );
};

// Main Action Listener
chrome.action.onClicked.addListener(async (tab) => {
  const currentWindowId = tab.windowId;
  const currentGroupId = tab.groupId;

  try {
    let stashData = null;
    let tabsToStash = [];
    let groupTitle = "Untitled Group";
    let groupColor = "grey";
    let stashType = 'loose';

    // Scenario 1: Stash a specific Tab Group
    if (currentGroupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
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
      
      stashType = 'loose';
      groupTitle = "Ungrouped Tabs";
      groupColor = "grey";
    }

    // Construct stash data if we have tabs
    if (tabsToStash.length > 0) {
      stashData = {
        id: Date.now(),
        timestamp: new Date().toLocaleString(),
        type: stashType,
        title: groupTitle,
        color: groupColor,
        tabs: tabsToStash.map(t => ({ 
          title: t.title, 
          url: t.url, 
          favIconUrl: t.favIconUrl 
        }))
      };
    }

    // Execute the stash operation
    // If stashData is null (no tabs found), processStash will just open the manager
    await processStash(stashData, tabsToStash, currentWindowId);

  } catch (error) {
    console.error("Critical error in action listener:", error);
    // Attempt to open manager as fallback
    try { await openManager(currentWindowId); } catch (e) { /* ignore */ }
  }
});