// background.js

chrome.action.onClicked.addListener(async (tab) => {
  const currentWindowId = tab.windowId;
  const currentGroupId = tab.groupId;

  // --- Helper: Open or Focus the Manager ---
  // We return the tab object so we can wait for it if needed
  const openManager = async () => {
    const managerUrl = chrome.runtime.getURL('src/manager/manager.html');
    
    // Check if manager is already open in this window
    const existingTabs = await chrome.tabs.query({ windowId: currentWindowId });
    const managerTab = existingTabs.find(t => t.url === managerUrl);

    if (managerTab) {
      // If found, highlight it and ensure it's pinned
      await chrome.tabs.update(managerTab.id, { active: true, pinned: true });
      return managerTab;
    } else {
      // If not found, create it pinned at index 0 (far left)
      return await chrome.tabs.create({ url: managerUrl, index: 0, pinned: true, active: true });
    }
  };

  // --- Helper: Save Data ---
  const saveToStorage = async (dataItem) => {
    const result = await chrome.storage.local.get({ stashedItems: [] });
    const newItems = [dataItem, ...result.stashedItems];
    await chrome.storage.local.set({ stashedItems: newItems });
  };

  // --- LOGIC START ---

  // CASE 1: Stashing a specific Group
  if (currentGroupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
    try {
      const group = await chrome.tabGroups.get(currentGroupId);
      const tabsInGroup = await chrome.tabs.query({ groupId: currentGroupId });
      
      // FILTER: Ignore pinned tabs
      const unpinnedTabs = tabsInGroup.filter(t => !t.pinned);

      if (unpinnedTabs.length === 0) return; // Nothing to save

      const stashData = {
        id: Date.now(),
        timestamp: new Date().toLocaleString(),
        type: 'group',
        title: group.title || "Untitled Group",
        color: group.color,
        tabs: unpinnedTabs.map(t => ({ title: t.title, url: t.url, favIconUrl: t.favIconUrl }))
      };

      await saveToStorage(stashData);
      
      // FIX 1: Open Manager FIRST to anchor the window
      await openManager();

      // FIX 2: Now it is safe to remove the tabs
      await chrome.tabs.remove(unpinnedTabs.map(t => t.id));

    } catch (error) {
      console.error("Error stashing group:", error);
    }
  } 
  
  // CASE 2: Stashing Loose Tabs (Non-Grouped)
  else {
    try {
      const looseTabs = await chrome.tabs.query({ windowId: currentWindowId, groupId: chrome.tabGroups.TAB_GROUP_ID_NONE });
      
      const managerUrl = chrome.runtime.getURL('src/manager/manager.html');

      // FILTER:  
      // 1. Ignore pinned tabs
      // 2. Ignore the manager itself
      // 3. Ignore "New Tab" pages (This prevents stashing the default empty tab)
      const tabsToStash = looseTabs.filter(t => 
        !t.pinned && 
        t.url !== managerUrl &&
        t.url !== 'chrome://newtab/' &&
        t.url !== 'about:blank' 
      );

      // SCENARIO CHECK: If there is nothing useful to stash...
      if (tabsToStash.length === 0) {
        // ...just open the manager so the user can see their list!
        // This handles the "Next Day" scenario perfectly.
        await openManager();
        return;
      }

      // If we DO have tabs to stash:
      const stashData = {
        id: Date.now(),
        timestamp: new Date().toLocaleString(),
        type: 'loose',
        title: "Ungrouped Tabs",
        color: "grey",
        tabs: tabsToStash.map(t => ({ title: t.title, url: t.url, favIconUrl: t.favIconUrl }))
      };

      await saveToStorage(stashData);
      
      // FIX 1: Open Manager FIRST to anchor the window
      await openManager();
      
      // FIX 2: Now safe to remove the tabs
      await chrome.tabs.remove(tabsToStash.map(t => t.id));

    } catch (error) {
      console.error("Error stashing loose tabs:", error);
    }
  }
});