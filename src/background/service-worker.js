chrome.action.onClicked.addListener(async (tab) => {
  const currentWindowId = tab.windowId;
  const currentGroupId = tab.groupId;

  // Return the tab object so we can wait for it if needed
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

  const saveToStorage = async (dataItem) => {
    const result = await chrome.storage.local.get({ stashedItems: [] });
    const newItems = [dataItem, ...result.stashedItems];
    await chrome.storage.local.set({ stashedItems: newItems });
  };

  // Stash a tab group
  if (currentGroupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
    try {
      const group = await chrome.tabGroups.get(currentGroupId);
      const tabsInGroup = await chrome.tabs.query({ groupId: currentGroupId });
      
      // Ignore pinned tabs
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
      
      // Open Manager, then remove the tabs
      await openManager();
      await chrome.tabs.remove(unpinnedTabs.map(t => t.id));

    } catch (error) {
      console.error("Error stashing group:", error);
    }
  } 
  
  // Stash non-grouped tabs
  else {
    try {
      const looseTabs = await chrome.tabs.query({ windowId: currentWindowId, groupId: chrome.tabGroups.TAB_GROUP_ID_NONE });
      
      const managerUrl = chrome.runtime.getURL('src/manager/manager.html');

      // Ignore pinned, manager tab and new tab pages
      const tabsToStash = looseTabs.filter(t => 
        !t.pinned && 
        t.url !== managerUrl &&
        t.url !== 'chrome://newtab/' &&
        t.url !== 'about:blank' 
      );

      // If nothing can be stashed, open manager
      if (tabsToStash.length === 0) {
        await openManager();
        return;
      }

      // If there's something to stash, proceed
      const stashData = {
        id: Date.now(),
        timestamp: new Date().toLocaleString(),
        type: 'loose',
        title: "Ungrouped Tabs",
        color: "grey",
        tabs: tabsToStash.map(t => ({ title: t.title, url: t.url, favIconUrl: t.favIconUrl }))
      };
      
      // Save to storage
      await saveToStorage(stashData);
      
      // Open Manager, then remove the tabs
      await openManager();
      await chrome.tabs.remove(tabsToStash.map(t => t.id));

    } catch (error) {
      console.error("Error stashing loose tabs:", error);
    }
  }
});