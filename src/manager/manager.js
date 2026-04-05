// Constants and Configuration
const CONFIG = {
  STORAGE_KEY: 'stashedItems',
  THEME_KEY: 'themePreference',
  CHROME_COLORS: ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'],
  UNDO_TIMEOUT_MS: 5000,
  TOAST_DURATION_MS: 3000,
  MAX_TITLE_LENGTH: 200
};

// State Management
const state = {
  undoStack: [],
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
  themeToggleBtn: document.getElementById('themeToggleBtn'),
  exportBtn: document.getElementById('exportBtn'),
  importBtn: document.getElementById('importBtn'),
  importFile: document.getElementById('importFile'),
  confirmModal: document.getElementById('confirm-modal'),
  confirmTitle: document.getElementById('confirm-title'),
  confirmOk: document.getElementById('confirm-ok'),
  confirmCancel: document.getElementById('confirm-cancel')
};

// Initial Load
document.addEventListener('DOMContentLoaded', () => {
  loadStashes();
  initTheme();
});

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
      const p = document.createElement('p');
      p.className = 'empty-state';
      p.textContent = 'No tabs stashed yet.';
      elements.container.appendChild(p);
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
    const p = document.createElement('p');
    p.className = 'error-state';
    p.textContent = 'Error loading content.';
    elements.container.appendChild(p);
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
  img.alt = '';

  const a = document.createElement('a');
  a.href = tab.url;
  a.textContent = tab.title || tab.url;
  a.target = '_blank';
  a.rel = 'noopener';

  const openBtn = document.createElement('button');
  openBtn.className = 'open-one-btn';
  openBtn.textContent = 'Open';
  openBtn.setAttribute('aria-label', `Open ${tab.title || tab.url}`);
  openBtn.onclick = () => chrome.tabs.create({ url: tab.url, active: false });

  li.appendChild(img);
  li.appendChild(a);
  li.appendChild(openBtn);

  return li;
}

/**
 * Formats an ISO timestamp for display.
 */
function formatTimestamp(timestamp) {
  try {
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return timestamp;
    return date.toLocaleString();
  } catch {
    return timestamp;
  }
}

/**
 * Renders the header in "View Mode".
 */
function renderViewMode(container, item) {
  container.innerHTML = '';

  // 1. Badge
  const badge = document.createElement('span');
  badge.className = `group-badge color-${item.color || 'grey'}`;
  badge.textContent = item.title || (item.type === 'group' ? 'Untitled Group' : 'Ungrouped Tabs');
  badge.style.cursor = 'pointer';
  badge.addEventListener('dblclick', () => renderEditMode(container, item));

  // 2. Edit Pencil Button
  const editBtn = document.createElement('button');
  editBtn.className = 'icon-btn';
  editBtn.innerHTML = '&#9998;';
  editBtn.title = 'Edit Title & Color';
  editBtn.setAttribute('aria-label', 'Edit title and color');
  editBtn.onclick = () => renderEditMode(container, item);

  // 3. Metadata
  const meta = document.createElement('span');
  meta.className = 'meta-info';
  meta.textContent = `${item.tabs.length} tabs \u2022 ${formatTimestamp(item.timestamp)}`;
  meta.style.marginLeft = "auto";

  // 4. Action Buttons
  const actions = document.createElement('div');
  actions.className = 'card-actions';

  const btnRestore = document.createElement('button');
  btnRestore.textContent = 'Restore All';
  btnRestore.setAttribute('aria-label', `Restore all tabs from ${item.title || 'stash'}`);
  btnRestore.onclick = () => restoreGroup(item);

  const btnDelete = document.createElement('button');
  btnDelete.textContent = 'Delete';
  btnDelete.className = 'danger';
  btnDelete.setAttribute('aria-label', `Delete ${item.title || 'stash'}`);
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
  container.innerHTML = '';

  const wrapper = document.createElement('div');
  wrapper.className = 'edit-container';

  // 1. Text Input
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'edit-input';
  input.value = item.title;
  input.placeholder = "Group Name";
  input.maxLength = CONFIG.MAX_TITLE_LENGTH;
  input.setAttribute('aria-label', 'Stash title');

  // 2. Color Picker (Row of dots)
  const colorPicker = document.createElement('div');
  colorPicker.className = 'color-picker';
  colorPicker.setAttribute('role', 'radiogroup');
  colorPicker.setAttribute('aria-label', 'Group color');
  let selectedColor = item.color;

  CONFIG.CHROME_COLORS.forEach(color => {
    const dot = document.createElement('button');
    dot.className = `color-dot color-${color} ${color === item.color ? 'selected' : ''}`;
    dot.setAttribute('role', 'radio');
    dot.setAttribute('aria-checked', color === item.color ? 'true' : 'false');
    dot.setAttribute('aria-label', color);
    dot.onclick = () => {
      // Handle selection visual
      colorPicker.querySelectorAll('.color-dot').forEach(d => {
        d.classList.remove('selected');
        d.setAttribute('aria-checked', 'false');
      });
      dot.classList.add('selected');
      dot.setAttribute('aria-checked', 'true');
      selectedColor = color;
    };
    colorPicker.appendChild(dot);
  });

  // Shared handlers (used by both buttons and keyboard shortcuts)
  const handleSave = async () => {
    await updateStashData(item.id, input.value, selectedColor);
    renderViewMode(container, { ...item, title: input.value, color: selectedColor });
  };

  const handleCancel = async () => {
    const freshData = await chrome.storage.local.get({ [CONFIG.STORAGE_KEY]: [] });
    const originalItem = freshData[CONFIG.STORAGE_KEY].find(i => i.id === item.id);
    if (originalItem) {
      renderViewMode(container, originalItem);
    } else {
      loadStashes();
    }
  };

  // Keyboard shortcuts: Enter to save, Escape to cancel
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleSave();
    if (e.key === 'Escape') handleCancel();
  });

  // 3. Save Button
  const saveBtn = document.createElement('button');
  saveBtn.className = 'icon-btn save-btn';
  saveBtn.innerHTML = '&#10004;';
  saveBtn.setAttribute('aria-label', 'Save changes');
  saveBtn.onclick = handleSave;

  // 4. Cancel Button
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'icon-btn cancel-btn';
  cancelBtn.innerHTML = '&#10006;';
  cancelBtn.setAttribute('aria-label', 'Cancel editing');
  // Re-fetch clean data to revert changes
  cancelBtn.onclick = handleCancel;

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
      items[index].title = newTitle;
      items[index].color = newColor;
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

    // 2. Create Tabs (in batches of 5 to avoid overwhelming the browser)
    const tabIds = [];
    for (let i = 0; i < item.tabs.length; i += 5) {
      const batch = item.tabs.slice(i, i + 5);
      const created = await Promise.all(
        batch.map(t => chrome.tabs.create({ url: t.url, active: false }))
      );
      tabIds.push(...created.map(t => t.id));
    }

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
    // We do not fully await this because we want to delete it in the background while the user sees their tabs
    deleteStash(item.id).catch(err => console.error("Error deleting after restore:", err));

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

    if (itemIndex === -1) return;

    // 2. Save it to memory (The Safety Net)
    state.undoStack.push(items[itemIndex]);

    // 3. Remove it from storage immediately
    const newItems = items.filter(i => i.id !== id);
    await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: newItems });

    // 4. Show the Undo Toast
    showUndoToast();
  } catch (error) {
    console.error("Error deleting stash:", error);
  }
}

// Undo Toast
function showUndoToast() {
  const lastItem = state.undoStack[state.undoStack.length - 1];
  if (!lastItem) return;

  // Update text based on what we deleted
  const name = lastItem.title || "Group";
  elements.undoMsg.textContent = `Deleted "${name.substring(0, 20)}${name.length > 20 ? '...' : ''}"`;

  // Clear previous timer if one exists
  if (state.undoTimeout) clearTimeout(state.undoTimeout);

  // Show the toast
  elements.undoToast.classList.remove('hidden');

  // Auto-hide after timeout
  state.undoTimeout = setTimeout(() => {
    hideUndoToast();
    state.undoStack = []; // Clear memory, it's gone forever now
  }, CONFIG.UNDO_TIMEOUT_MS);
}

function hideUndoToast() {
  elements.undoToast.classList.add('hidden');
  if (state.undoTimeout) clearTimeout(state.undoTimeout);
}

async function handleUndo() {
  const itemToRestore = state.undoStack.pop();
  if (!itemToRestore) return;

  try {
    // 1. Get current list
    const result = await chrome.storage.local.get({ [CONFIG.STORAGE_KEY]: [] });

    // 2. Add the item back to the TOP of the list
    const newItems = [itemToRestore, ...result[CONFIG.STORAGE_KEY]];

    // 3. Save
    await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: newItems });

    // 4. Cleanup
    hideUndoToast();
  } catch (error) {
    console.error("Error undoing delete:", error);
  }
}

// Info Toast (replaces alert)
function showInfoToast(message) {
  elements.undoMsg.textContent = message;
  elements.undoBtn.style.display = 'none';
  elements.undoToast.classList.remove('hidden');

  if (state.undoTimeout) clearTimeout(state.undoTimeout);
  state.undoTimeout = setTimeout(() => {
    elements.undoToast.classList.add('hidden');
    elements.undoBtn.style.display = '';
  }, CONFIG.TOAST_DURATION_MS);
}

// Confirm Modal (replaces native confirm)
function showConfirmModal(message) {
  return new Promise((resolve) => {
    // Remember what element was focused before the modal opened
    const previousFocus = document.activeElement;

    elements.confirmTitle.textContent = message;
    elements.confirmModal.classList.remove('hidden');

    // Set initial focus
    elements.confirmOk.focus();

    const cleanup = (result) => {
      elements.confirmModal.classList.add('hidden');
      elements.confirmOk.onclick = null;
      elements.confirmCancel.onclick = null;
      document.removeEventListener('keydown', onKey);

      // Return focus back to the triggering element
      if (previousFocus) previousFocus.focus();

      resolve(result);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') cleanup(false);

      // Trap the focus inside the modal
      if (e.key === 'Tab') {
        // If holding Shift + Tab while on the OK button, loop back to Cancel
        if (e.shiftKey && document.activeElement === elements.confirmOk) {
          e.preventDefault();
          elements.confirmCancel.focus();
        }
        // If pressing Tab while on the Cancel button, loop back to OK
        else if (!e.shiftKey && document.activeElement === elements.confirmCancel) {
          e.preventDefault();
          elements.confirmOk.focus();
        }
      }
    };

    // Use 'keydown' so we catch the Tab key before the browser moves focus
    document.addEventListener('keydown', onKey);

    elements.confirmOk.onclick = () => cleanup(true);
    elements.confirmCancel.onclick = () => cleanup(false);
  });
}

async function handleExport() {
  try {
    const result = await chrome.storage.local.get({ [CONFIG.STORAGE_KEY]: [] });
    const blob = new Blob([JSON.stringify(result[CONFIG.STORAGE_KEY], null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `stasher-export-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url); // Cleanup
  } catch (error) {
    console.error("Error exporting:", error);
  }
}

/**
 * Validates that an imported stash item has the required shape.
 */
function isValidStashItem(item) {
  if (!item || typeof item !== 'object') return false;
  if (typeof item.id !== 'string' && typeof item.id !== 'number') return false;
  if (!Array.isArray(item.tabs)) return false;
  return item.tabs.every(tab =>
    tab && typeof tab === 'object' &&
    typeof tab.url === 'string' &&
    typeof tab.title === 'string'
  );
}

function handleImport(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const importedData = JSON.parse(e.target.result);
      if (!Array.isArray(importedData)) {
        showInfoToast('Invalid format: expected an array.');
        return;
      }

      const valid = importedData.filter(isValidStashItem);
      if (valid.length === 0) {
        showInfoToast('No valid stash items found in file.');
        return;
      }

      const current = await chrome.storage.local.get({ [CONFIG.STORAGE_KEY]: [] });
      const merged = [...valid, ...current[CONFIG.STORAGE_KEY]];

      // Remove duplicates based on ID
      const unique = merged.filter((v, i, a) => a.findIndex(t => (t.id === v.id)) === i);

      await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: unique });

      const added = unique.length - current[CONFIG.STORAGE_KEY].length;
      showInfoToast(`Imported ${added} new stash${added !== 1 ? 'es' : ''}.`);
    } catch (err) {
      console.error("Import error:", err);
      showInfoToast('Error parsing JSON file.');
    }
    // Reset so the same file can be re-imported
    event.target.value = '';
  };
  reader.readAsText(file);
}

async function handleDeleteAll() {
  const confirmed = await showConfirmModal(
    "WARNING: This will delete ALL saved tabs and groups.\n\nAre you sure you want to proceed?"
  );
  if (confirmed) {
    await chrome.storage.local.remove(CONFIG.STORAGE_KEY);
  }
}

function setupEventListeners() {
  // Undo Toast Listeners
  elements.undoBtn.onclick = handleUndo;
  elements.closeToastBtn.onclick = hideUndoToast;

  // Global Actions
  elements.deleteAllBtn.onclick = handleDeleteAll;
  elements.themeToggleBtn.onclick = toggleTheme;
  elements.exportBtn.onclick = handleExport;
  elements.importBtn.onclick = () => elements.importFile.click();
  elements.importFile.onchange = handleImport;
}

// Theme Management
function initTheme() {
  const savedTheme = localStorage.getItem(CONFIG.THEME_KEY);

  if (savedTheme) {
    // Explicit preference saved, use it
    applyTheme(savedTheme);
  } else {
    // Default to OS preference
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(prefersDark ? 'dark' : 'light');
  }
}

function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(newTheme);
  localStorage.setItem(CONFIG.THEME_KEY, newTheme);
}

function applyTheme(theme) {
  if (theme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    elements.themeToggleBtn.textContent = '🐈';
  } else {
    document.documentElement.removeAttribute('data-theme');
    elements.themeToggleBtn.textContent = '🐈‍⬛';
  }
  // Enable smooth transitions only after the initial theme is applied
  requestAnimationFrame(() => {
    document.body.style.transition = 'background-color 0.3s, color 0.3s';
  });
}
