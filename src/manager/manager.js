// Constants and Configuration
const CONFIG = {
  STORAGE_KEY: 'stashedItems',
  CHROME_COLORS: ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']
};

// State Management
const state = {
  lastDeletedItem: null,
  undoTimeout: null
};

// DOM Elements
const elements = {
  container: document.getElementById('stash-container'),
  undoToast: document.getElementById('undo-toast'),
  undoMsg: document.getElementById('undo-msg'),
  undoBtn: document.getElementById('undo-btn'),
  closeToastBtn: document.getElementById('close-toast'),
  deleteAllBtn: document.getElementById('deleteAllBtn'),
  exportBtn: document.getElementById('exportBtn'),
  importBtn: document.getElementById('importBtn'),
  importFile: document.getElementById('importFile')
};

// Initial Load
document.addEventListener('DOMContentLoaded', loadStashes);

// Listen for changes in chrome.storage.local to update UI
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes[CONFIG.STORAGE_KEY]) {
    loadStashes();
  }
});

// Setup Event Listeners
setupEventListeners();

async function loadStashes() {
  try {
    const result = await chrome.storage.local.get({ [CONFIG.STORAGE_KEY]: [] });
    elements.container.innerHTML = '';

    if (result[CONFIG.STORAGE_KEY].length === 0) {
      elements.container.innerHTML = '<p style="text-align:center; padding:20px;">No tabs stashed yet.</p>';
      return;
    }

    // Render each stash item
    const fragment = document.createDocumentFragment();
    result[CONFIG.STORAGE_KEY].forEach(item => {
      const card = createStashCard(item);
      fragment.appendChild(card);
    });
    elements.container.appendChild(fragment);

  } catch (error) {
    console.error("Error loading stashes:", error);
    elements.container.innerHTML = '<p style="text-align:center; color:red;">Error loading content.</p>';
  }
}

/**
 * Creates the DOM element for a stash card.
 */
function createStashCard(item) {
  const card = document.createElement('div');
  card.className = 'stash-card';
  
  const header = document.createElement('div');
  header.className = 'card-header';
  header.id = `header-${item.id}`; // Give ID for easier swapping

  // Start in View Mode
  renderViewMode(header, item);

  card.appendChild(header);

  const ul = document.createElement('ul');
  ul.className = 'link-list';

  item.tabs.forEach(tab => {
    const li = createTabListItem(tab);
    ul.appendChild(li);
  });

  card.appendChild(ul);
  return card;
}

/**
 * Creates a list item for a single tab.
 */
function createTabListItem(tab) {
  const li = document.createElement('li');
  li.className = 'link-item';
  
  const img = document.createElement('img');
  const faviconUrl = chrome.runtime.getURL(`_favicon/?pageUrl=${encodeURIComponent(tab.url)}&size=16`);
  img.src = faviconUrl;
  
  const a = document.createElement('a');
  a.href = tab.url;
  a.textContent = tab.title || tab.url;
  a.target = '_blank';

  const openBtn = document.createElement('button');
  openBtn.className = 'open-one-btn';
  openBtn.textContent = 'Open';
  openBtn.onclick = () => chrome.tabs.create({ url: tab.url, active: false });

  li.appendChild(img);
  li.appendChild(a);
  li.appendChild(openBtn);
  
  return li;
}

/**
 * Renders the header in "View Mode".
 */
function renderViewMode(container, item) {
  container.innerHTML = ''; // Clear current content

  // 1. Badge
  const badge = document.createElement('span');
  badge.className = `group-badge color-${item.color || 'grey'}`;
  badge.textContent = item.title || (item.type === 'group' ? 'Untitled Group' : 'Ungrouped Tabs');
  
  // 2. Edit Pencil Button
  const editBtn = document.createElement('button');
  editBtn.className = 'icon-btn';
  editBtn.innerHTML = '&#9998;';
  editBtn.title = 'Edit Title & Color';
  editBtn.onclick = () => renderEditMode(container, item);

  // 3. Metadata
  const meta = document.createElement('span');
  meta.className = 'meta-info';
  meta.innerText = `${item.tabs.length} tabs • ${item.timestamp}`;
  meta.style.marginLeft = "auto"; // Push buttons to the right

  // 4. Action Buttons
  const actions = document.createElement('div');
  actions.className = 'card-actions';

  const btnRestore = document.createElement('button');
  btnRestore.textContent = 'Restore All';
  btnRestore.onclick = () => restoreGroup(item);

  const btnDelete = document.createElement('button');
  btnDelete.textContent = 'Delete';
  btnDelete.className = 'danger';
  btnDelete.onclick = () => deleteStash(item.id);

  // Construct
  container.appendChild(badge);
  container.appendChild(editBtn);
  container.appendChild(meta);
  actions.appendChild(btnRestore);
  actions.appendChild(btnDelete);
  container.appendChild(actions);
}

/**
 * Renders the header in "Edit Mode".
 */
function renderEditMode(container, item) {
  container.innerHTML = ''; // Clear view mode

  const wrapper = document.createElement('div');
  wrapper.className = 'edit-container';

  // 1. Text Input
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'edit-input';
  input.value = item.title;
  input.placeholder = "Group Name";

  // 2. Color Picker (Row of dots)
  const colorPicker = document.createElement('div');
  colorPicker.className = 'color-picker';
  let selectedColor = item.color;

  CONFIG.CHROME_COLORS.forEach(color => {
    const dot = document.createElement('div');
    dot.className = `color-dot color-${color} ${color === item.color ? 'selected' : ''}`;
    dot.onclick = () => {
      // Handle selection visual
      colorPicker.querySelectorAll('.color-dot').forEach(d => d.classList.remove('selected'));
      dot.classList.add('selected');
      selectedColor = color;
    };
    colorPicker.appendChild(dot);
  });

  // 3. Save Button
  const saveBtn = document.createElement('button');
  saveBtn.className = 'icon-btn save-btn';
  saveBtn.innerHTML = '&#10004;';
  saveBtn.onclick = async () => {
    await updateStashData(item.id, input.value, selectedColor);
    renderViewMode(container, { ...item, title: input.value, color: selectedColor });
  };

  // 4. Cancel Button
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'icon-btn cancel-btn';
  cancelBtn.innerHTML = '&#10006;';
  // Re-fetch clean data to revert changes
  cancelBtn.onclick = async () => {
    const freshData = await chrome.storage.local.get({ [CONFIG.STORAGE_KEY]: [] });
    const originalItem = freshData[CONFIG.STORAGE_KEY].find(i => i.id === item.id);
    // If originalItem is undefined (maybe deleted in another window), fallback safely
    if (originalItem) {
      renderViewMode(container, originalItem);
    } else {
      loadStashes(); // Reload full list if item is gone
    }
  };

  wrapper.appendChild(input);
  wrapper.appendChild(colorPicker);
  wrapper.appendChild(saveBtn);
  wrapper.appendChild(cancelBtn);
  container.appendChild(wrapper);
}

async function updateStashData(id, newTitle, newColor) {
  try {
    const result = await chrome.storage.local.get({ [CONFIG.STORAGE_KEY]: [] });
    const items = result[CONFIG.STORAGE_KEY];
    const index = items.findIndex(i => i.id === id);
    
    if (index !== -1) {
      // Update the specific fields
      items[index].title = newTitle;
      items[index].color = newColor;
      
      // Save back to storage (This triggers the onChanged listener to reload UI)
      await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: items });
    }
  } catch (error) {
    console.error("Error updating stash data:", error);
  }
}

async function restoreGroup(item) {
  let tempWindow = null; // We declare this outside to ensure we can close it later
  
  try {
    // 1. Get reference to current window
    const originalWindow = await chrome.windows.getCurrent();

    // 2. Create Tabs (Hidden initially)
    const tabPromises = item.tabs.map(t => chrome.tabs.create({ url: t.url, active: false }));
    const createdTabs = await Promise.all(tabPromises);
    const tabIds = createdTabs.map(t => t.id);

    if (item.type === 'group') {
      // 3. Create Group
      const groupId = await chrome.tabs.group({ tabIds });

      // 4. Apply Properties
      await chrome.tabGroups.update(groupId, {
        title: item.title,
        color: item.color,
        collapsed: false
      });

      // The whole reason for the creation of this extension is due to Chromium browsers recently
      // Unable to properly render tab groups, titles and colors until clicked while using other
      // Tab managers, such as OneTab. As such, we had to come up with a workaround.

      // It's dirty. But works.
      
      // A. Create a minimized helper window in the background
      tempWindow = await chrome.windows.create({ 
        type: 'normal',
        focused: false,      // Don't steal focus from the user
        state: 'minimized'   // Keep it in the taskbar
      });

      // B. Move the group to the hidden window
      // This forces the "Rebuild" of the UI widget
      await chrome.tabGroups.move(groupId, { windowId: tempWindow.id, index: -1 });

      // C. Tiny delay to let the OS register the move
      await new Promise(r => setTimeout(r, 100));

      // D. Move it BACK to your main window
      await chrome.tabGroups.move(groupId, { windowId: originalWindow.id, index: -1 });
      
      // E. Re-focus the original window (just in case)
      await chrome.windows.update(originalWindow.id, { focused: true });
    }

    // 5. Cleanup Storage
    // We do not await this because we want to delete it in the background while the user sees their tabs
    deleteStash(item.id);

  } catch (error) {
    console.error("Error restoring group:", error);
  } finally {
    // 6. Always close the temp window, even if errors occurred
    if (tempWindow) {
      await chrome.windows.remove(tempWindow.id);
    }
  }
}

async function deleteStash(id) {
  try {
    // 1. Get current list to find the item we are about to delete
    const result = await chrome.storage.local.get({ [CONFIG.STORAGE_KEY]: [] });
    const items = result[CONFIG.STORAGE_KEY];
    const itemIndex = items.findIndex(i => i.id === id);
    
    if (itemIndex === -1) return; // Item not found

    // 2. Save it to memory (The Safety Net)
    state.lastDeletedItem = items[itemIndex];

    // 3. Remove it from storage immediately
    const newItems = items.filter(i => i.id !== id);
    await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: newItems });

    // 4. Show the Undo Toast
    showUndoToast();
  } catch (error) {
    console.error("Error deleting stash:", error);
  }
}

function showUndoToast() {
  if (!state.lastDeletedItem) return;

  // Update text based on what we deleted
  const name = state.lastDeletedItem.title || "Group";
  elements.undoMsg.textContent = `Deleted "${name.substring(0, 20)}${name.length>20?'...':''}"`;

  // Clear previous timer if one exists
  if (state.undoTimeout) clearTimeout(state.undoTimeout);

  // Show the toast
  elements.undoToast.classList.remove('hidden');

  // Auto-hide after 5 seconds
  state.undoTimeout = setTimeout(() => {
    hideUndoToast();
    state.lastDeletedItem = null; // Clear memory, it's gone forever now
  }, 5000);
}

function hideUndoToast() {
  elements.undoToast.classList.add('hidden');
  if (state.undoTimeout) clearTimeout(state.undoTimeout);
}

async function handleUndo() {
  if (!state.lastDeletedItem) return;

  try {
    // 1. Get current list
    const result = await chrome.storage.local.get({ [CONFIG.STORAGE_KEY]: [] });
    
    // 2. Add the item back to the TOP of the list
    const newItems = [state.lastDeletedItem, ...result[CONFIG.STORAGE_KEY]];
    
    // 3. Save
    await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: newItems });

    // 4. Cleanup
    hideUndoToast();
    state.lastDeletedItem = null;
  } catch (error) {
    console.error("Error undoing delete:", error);
  }
}

async function handleExport() {
  try {
    const result = await chrome.storage.local.get({ [CONFIG.STORAGE_KEY]: [] });
    const blob = new Blob([JSON.stringify(result[CONFIG.STORAGE_KEY], null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `grouptab-stash-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url); // Cleanup
  } catch (error) {
    console.error("Error exporting:", error);
  }
}

function handleImport(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const importedData = JSON.parse(e.target.result);
      if (Array.isArray(importedData)) {
        const current = await chrome.storage.local.get({ [CONFIG.STORAGE_KEY]: [] });
        const merged = [...importedData, ...current[CONFIG.STORAGE_KEY]];
        
        // Remove duplicates based on ID
        const unique = merged.filter((v,i,a) => a.findIndex(t => (t.id === v.id)) === i);
        
        await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: unique });
        alert('Import successful!');
      } else {
        alert('Invalid format: Expected an array.');
      }
    } catch (err) {
      console.error("Import error:", err);
      alert('Error parsing JSON');
    }
  };
  reader.readAsText(file);
}

async function handleDeleteAll() {
  if (confirm("WARNING: This will delete ALL saved tabs and groups.\n\nAre you sure you want to proceed?")) {
    await chrome.storage.local.clear();
  }
}

function setupEventListeners() {
  // Undo Toast Listeners
  elements.undoBtn.onclick = handleUndo;
  elements.closeToastBtn.onclick = hideUndoToast;

  // Global Actions
  elements.deleteAllBtn.onclick = handleDeleteAll;
  elements.exportBtn.onclick = handleExport;
  elements.importBtn.onclick = () => elements.importFile.click();
  elements.importFile.onchange = handleImport;
}