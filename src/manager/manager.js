// Constants and Configuration
const CONFIG = {
  STORAGE_KEY: 'stashedItems',
  THEME_KEY: 'themePreference',
  CHROME_COLORS: ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'],
  UNDO_TIMEOUT_MS: 5000,
  TOAST_DURATION_MS: 3000,
  MAX_TITLE_LENGTH: 200,
  MAX_IMPORT_BYTES: 1024 * 1024,
  MAX_IMPORT_ITEMS: 1000,
  MAX_TABS_PER_STASH: 500,
  ALLOWED_SCHEMES: ['http:', 'https:', 'chrome-extension:']
};

// State Management
const state = {
  undoStack: [],
  undoTimeout: null,
  infoTimeout: null
};

// Storage Helpers
let storageWriteQueue = Promise.resolve();

const getStashItems = async () => {
  const result = await chrome.storage.local.get({ [CONFIG.STORAGE_KEY]: [] });
  return Array.isArray(result[CONFIG.STORAGE_KEY]) ? result[CONFIG.STORAGE_KEY] : [];
};

const updateStashItems = (updater) => {
  const run = () => {
    const next = storageWriteQueue.then(async () => {
      const items = await getStashItems();
      const updated = await updater(items);
      if (Array.isArray(updated)) {
        await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: updated });
      }
      return updated;
    });
    storageWriteQueue = next.catch(() => {});
    return next;
  };
  // Web Locks serializes extension contexts; the promise queue is the fallback.
  return globalThis.navigator?.locks
    ? navigator.locks.request('stasher-storage', run)
    : run();
};

function isAllowedTabUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    return CONFIG.ALLOWED_SCHEMES.includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function safeColor(color) {
  return CONFIG.CHROME_COLORS.includes(color) ? color : 'grey';
}

// DOM Elements
const elements = {
  container: document.getElementById('stash-container'),
  undoToast: document.getElementById('undo-toast'),
  undoMsg: document.getElementById('undo-msg'),
  undoBtn: document.getElementById('undo-btn'),
  closeToastBtn: document.getElementById('close-toast'),
  infoToast: document.getElementById('info-toast'),
  infoMsg: document.getElementById('info-msg'),
  closeInfoToastBtn: document.getElementById('close-info-toast'),
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

function createIcon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  svg.classList.add('button-icon');
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', `#icon-${name}`);
  svg.appendChild(use);
  return svg;
}

function setButtonIcon(button, name) {
  button.replaceChildren(createIcon(name));
}

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
    const items = await getStashItems();
    elements.container.innerHTML = '';

    if (items.length === 0) {
      const p = document.createElement('p');
      p.className = 'empty-state';
      p.textContent = 'No tabs stashed yet.';
      elements.container.appendChild(p);
      return;
    }

    // Render each stash item
    const fragment = document.createDocumentFragment();
    items.forEach(item => {
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
  if (isCollapsed(item.id)) card.classList.add('collapsed');

  const header = document.createElement('div');
  header.className = 'card-header';
  header.id = `header-${item.id}`; // Give ID for easier swapping

  // Start in View Mode
  renderViewMode(header, item);

  card.appendChild(header);

  const ul = document.createElement('ul');
  ul.className = 'link-list';

  const tabs = Array.isArray(item.tabs) ? item.tabs : [];
  tabs.forEach((tab, idx) => {
    if (!isAllowedTabUrl(tab.url)) return;
    const li = createTabListItem(tab, item.id, idx);
    ul.appendChild(li);
  });

  card.appendChild(ul);
  return card;
}

const COLLAPSED_KEY_PREFIX = 'stash-collapsed:';

function isCollapsed(stashId) {
  return sessionStorage.getItem(COLLAPSED_KEY_PREFIX + stashId) === '1';
}

function setCollapsed(stashId, collapsed) {
  if (collapsed) sessionStorage.setItem(COLLAPSED_KEY_PREFIX + stashId, '1');
  else sessionStorage.removeItem(COLLAPSED_KEY_PREFIX + stashId);
}

/**
 * Creates a list item for a single tab.
 */
function createTabListItem(tab, stashId, tabIndex) {
  const li = document.createElement('li');
  li.className = 'link-item';
  const url = tab.url;

  const img = document.createElement('img');
  const faviconUrl = chrome.runtime.getURL(`_favicon/?pageUrl=${encodeURIComponent(url)}&size=16`);
  img.src = faviconUrl;
  img.alt = '';

  const a = document.createElement('a');
  a.href = url;
  a.textContent = tab.title || url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';

  const openBtn = document.createElement('button');
  openBtn.className = 'open-one-btn';
  openBtn.textContent = 'Open';
  openBtn.title = 'Open in background';
  openBtn.setAttribute('aria-label', `Open ${tab.title || url} in background`);
  openBtn.onclick = () => chrome.tabs.create({ url, active: false });

  const removeBtn = document.createElement('button');
  removeBtn.className = 'icon-btn remove-tab-btn';
  setButtonIcon(removeBtn, 'trash');
  removeBtn.setAttribute('aria-label', `Remove ${tab.title || url} from stash`);
  removeBtn.onclick = () => removeTabFromStash(stashId, tabIndex);

  li.appendChild(img);
  li.appendChild(a);
  li.appendChild(openBtn);
  li.appendChild(removeBtn);

  return li;
}

/**
 * Removes a single tab from a stash by its position in the tabs array.
 * Index-based (not URL-based) so duplicate URLs in the same stash can be
 * removed individually. If the stash has no tabs left, the entry is deleted.
 */
async function removeTabFromStash(stashId, tabIndex) {
  try {
    let removed = false;
    await updateStashItems(items => {
      const index = items.findIndex(i => i.id === stashId);
      if (index === -1 || !Array.isArray(items[index].tabs)) return null;
      if (tabIndex < 0 || tabIndex >= items[index].tabs.length) return null;

      const removedTab = items[index].tabs[tabIndex];
      state.undoStack.push({
        kind: 'tab',
        stashSnapshot: structuredClone(items[index]),
        label: removedTab.title || removedTab.url || 'Tab'
      });

      items[index].tabs.splice(tabIndex, 1);

      if (items[index].tabs.length === 0) {
        items.splice(index, 1);
      }

      removed = true;
      return items;
    });
    if (removed) showUndoToast();
  } catch (error) {
    console.error("Error removing tab from stash:", error);
  }
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
  const tabs = Array.isArray(item.tabs) ? item.tabs : [];

  // Collapse / Expand toggle
  const collapseBtn = document.createElement('button');
  collapseBtn.className = 'icon-btn collapse-btn';
  const initiallyCollapsed = isCollapsed(item.id);
  setButtonIcon(collapseBtn, initiallyCollapsed ? 'chevron-right' : 'chevron-down');
  collapseBtn.setAttribute('aria-expanded', String(!initiallyCollapsed));
  collapseBtn.setAttribute('aria-label', initiallyCollapsed ? 'Expand stash' : 'Collapse stash');
  collapseBtn.onclick = () => {
    const card = container.closest('.stash-card');
    if (!card) return;
    const nowCollapsed = card.classList.toggle('collapsed');
    setCollapsed(item.id, nowCollapsed);
    setButtonIcon(collapseBtn, nowCollapsed ? 'chevron-right' : 'chevron-down');
    collapseBtn.setAttribute('aria-expanded', String(!nowCollapsed));
    collapseBtn.setAttribute('aria-label', nowCollapsed ? 'Expand stash' : 'Collapse stash');
  };

  // 1. Badge
  const badge = document.createElement('span');
  badge.className = `group-badge color-${safeColor(item.color)}`;
  badge.textContent = item.title || (item.type === 'group' ? 'Untitled Group' : 'Ungrouped Tabs');
  badge.style.cursor = 'pointer';
  badge.addEventListener('dblclick', () => renderEditMode(container, item));

  // 2. Edit Pencil Button
  const editBtn = document.createElement('button');
  editBtn.className = 'icon-btn';
  setButtonIcon(editBtn, 'pencil');
  editBtn.title = 'Edit Title & Color';
  editBtn.setAttribute('aria-label', 'Edit title and color');
  editBtn.onclick = () => renderEditMode(container, item);

  // 3. Metadata
  const meta = document.createElement('span');
  meta.className = 'meta-info';
  meta.textContent = `${tabs.length} tabs \u2022 ${formatTimestamp(item.timestamp)}`;
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
  container.appendChild(collapseBtn);
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
  const itemColor = safeColor(item.color);

  const wrapper = document.createElement('div');
  wrapper.className = 'edit-container';

  // 1. Text Input
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'edit-input';
  input.value = typeof item.title === 'string' ? item.title : '';
  input.placeholder = "Group Name";
  input.maxLength = CONFIG.MAX_TITLE_LENGTH;
  input.setAttribute('aria-label', 'Stash title');

  // 2. Color Picker (Row of dots)
  const colorPicker = document.createElement('div');
  colorPicker.className = 'color-picker';
  colorPicker.setAttribute('role', 'radiogroup');
  colorPicker.setAttribute('aria-label', 'Group color');
  let selectedColor = itemColor;

  CONFIG.CHROME_COLORS.forEach(color => {
    const dot = document.createElement('button');
    dot.className = `color-dot color-${color} ${color === itemColor ? 'selected' : ''}`;
    dot.setAttribute('role', 'radio');
    dot.setAttribute('aria-checked', color === itemColor ? 'true' : 'false');
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
    const items = await getStashItems();
    const originalItem = items.find(i => i.id === item.id);
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
  setButtonIcon(saveBtn, 'check');
  saveBtn.setAttribute('aria-label', 'Save changes');
  saveBtn.onclick = handleSave;

  // 4. Cancel Button
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'icon-btn cancel-btn';
  setButtonIcon(cancelBtn, 'x');
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
    await updateStashItems(items => {
      const index = items.findIndex(i => i.id === id);
      if (index === -1) return null;
      items[index].title = newTitle;
      items[index].color = safeColor(newColor);
      return items;
    });
  } catch (error) {
    console.error("Error updating stash data:", error);
  }
}

async function restoreGroup(item) {
  let tempWindow = null; // We declare this outside to ensure we can close it later

  try {
    const tabs = Array.isArray(item.tabs) ? item.tabs.filter(t => isAllowedTabUrl(t.url)) : [];
    if (tabs.length === 0) return;

    // 1. Get reference to current window
    const originalWindow = await chrome.windows.getCurrent();

    // 2. Create Tabs (in batches of 5 to avoid overwhelming the browser)
    const tabIds = [];
    for (let i = 0; i < tabs.length; i += 5) {
      const batch = tabs.slice(i, i + 5);
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
        title: typeof item.title === 'string' ? item.title : '',
        color: safeColor(item.color),
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
    let deleted = false;
    await updateStashItems(items => {
      // 1. Get current list to find the item we are about to delete
      const itemIndex = items.findIndex(i => i.id === id);
      if (itemIndex === -1) return null;

      // 2. Save it to memory (The Safety Net)
      state.undoStack.push({ kind: 'stash', item: items[itemIndex] });

      // 3. Remove it from storage immediately
      deleted = true;
      return items.filter(i => i.id !== id);
    });

    // 4. Show the Undo Toast
    if (deleted) showUndoToast();
  } catch (error) {
    console.error("Error deleting stash:", error);
  }
}

// Undo Toast
function undoEntryLabel(entry) {
  if (entry.kind === 'stash') return entry.item.title || 'Group';
  return entry.label || 'Tab';
}

function showUndoToast() {
  const count = state.undoStack.length;
  if (count === 0) return;

  if (count === 1) {
    const name = undoEntryLabel(state.undoStack[0]);
    elements.undoMsg.textContent = `Deleted "${name.substring(0, 20)}${name.length > 20 ? '...' : ''}"`;
  } else {
    elements.undoMsg.textContent = `${count} items deleted`;
  }

  if (state.undoTimeout) clearTimeout(state.undoTimeout);

  elements.undoToast.classList.remove('hidden');

  state.undoTimeout = setTimeout(hideUndoToast, CONFIG.UNDO_TIMEOUT_MS);
}

function hideUndoToast() {
  elements.undoToast.classList.add('hidden');
  if (state.undoTimeout) clearTimeout(state.undoTimeout);
  // Hiding the toast forfeits any pending undo items; otherwise dismissed
  // entries would resurface in the count on the next deletion.
  state.undoStack = [];
}

async function handleUndo() {
  const entry = state.undoStack.pop();
  if (!entry) return;

  try {
    await updateStashItems(items => {
      if (entry.kind === 'stash') {
        return [entry.item, ...items];
      } else {
        // Tab removal: replace the existing stash with the pre-removal snapshot,
        // or re-insert it at the top if it was cascade-deleted (last tab gone).
        const existing = items.findIndex(i => i.id === entry.stashSnapshot.id);
        if (existing !== -1) {
          items[existing] = entry.stashSnapshot;
          return items;
        }
        return [entry.stashSnapshot, ...items];
      }
    });

    // If more deletions remain in the stack, refresh the toast for the next undo;
    // otherwise hide it.
    if (state.undoStack.length > 0) {
      showUndoToast();
    } else {
      hideUndoToast();
    }
  } catch (error) {
    console.error("Error undoing delete:", error);
    state.undoStack.push(entry);
  }
}

// Info Toast (replaces alert) — uses its own element so it never collides
// with an in-flight undo toast.
function showInfoToast(message) {
  elements.infoMsg.textContent = message;
  elements.infoToast.classList.remove('hidden');

  if (state.infoTimeout) clearTimeout(state.infoTimeout);
  state.infoTimeout = setTimeout(hideInfoToast, CONFIG.TOAST_DURATION_MS);
}

function hideInfoToast() {
  elements.infoToast.classList.add('hidden');
  if (state.infoTimeout) clearTimeout(state.infoTimeout);
}

// Confirm Modal (replaces native confirm)
function showConfirmModal(message, confirmLabel = 'Confirm') {
  return new Promise((resolve) => {
    // Remember what element was focused before the modal opened
    const previousFocus = document.activeElement;

    elements.confirmTitle.textContent = message;
    elements.confirmOk.textContent = confirmLabel;
    elements.confirmModal.classList.remove('hidden');

    // Default to the safe action for destructive confirmations
    elements.confirmCancel.focus();

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
    const items = await getStashItems();
    const blob = new Blob([JSON.stringify(items, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const dateStr = new Date().toISOString().slice(0, 10);
    a.download = `stasher-export-${dateStr}.json`;
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
  // Accept numeric IDs from legacy exports; handleImport coerces them to
  // strings so internal logic can keep treating ids uniformly.
  if (typeof item.id !== 'string' && typeof item.id !== 'number') return false;
  if (!Array.isArray(item.tabs) || item.tabs.length > CONFIG.MAX_TABS_PER_STASH) return false;
  return item.tabs.every(tab =>
    tab && typeof tab === 'object' &&
    typeof tab.url === 'string' &&
    typeof tab.title === 'string' &&
    isAllowedTabUrl(tab.url)
  );
}

function normalizeImportedItem(item) {
  return {
    ...item,
    id: String(item.id),
    title: typeof item.title === 'string' ? item.title.slice(0, CONFIG.MAX_TITLE_LENGTH) : '',
    color: safeColor(item.color),
    type: item.type === 'group' ? 'group' : 'loose',
    tabs: item.tabs.map(tab => ({
      ...tab,
      title: tab.title.slice(0, CONFIG.MAX_TITLE_LENGTH)
    }))
  };
}

function handleImport(event) {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > CONFIG.MAX_IMPORT_BYTES) {
    showInfoToast('Import file is too large.');
    event.target.value = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const importedData = JSON.parse(e.target.result);
      if (!Array.isArray(importedData)) {
        showInfoToast('Invalid format: expected an array.');
        return;
      }
      if (importedData.length > CONFIG.MAX_IMPORT_ITEMS) {
        showInfoToast('Import contains too many stash items.');
        return;
      }

      const valid = importedData
        .filter(isValidStashItem)
        .map(normalizeImportedItem);
      if (valid.length === 0) {
        showInfoToast('No valid stash items found in file.');
        return;
      }

      let added = 0;
      await updateStashItems(currentItems => {
        const merged = [...valid, ...currentItems];

        // Remove duplicates based on ID
        const unique = merged.filter((v, i, a) => a.findIndex(t => (t.id === v.id)) === i);

        added = unique.length - currentItems.length;
        return unique;
      });

      showInfoToast(`Imported ${added} new stash${added !== 1 ? 'es' : ''}.`);
    } catch (err) {
      console.error("Import error:", err);
      showInfoToast('Error parsing JSON file.');
    } finally {
      // Reset so the same file can be re-imported
      event.target.value = '';
    }
  };
  reader.readAsText(file);
}

async function handleDeleteAll() {
  const confirmed = await showConfirmModal(
    "WARNING: This will delete ALL saved tabs and groups.\n\nAre you sure you want to proceed?",
    'Delete All Stashes'
  );
  if (confirmed) {
    await updateStashItems(() => []);
  }
}

function setupEventListeners() {
  // Toast Listeners
  elements.undoBtn.onclick = handleUndo;
  elements.closeToastBtn.onclick = hideUndoToast;
  elements.closeInfoToastBtn.onclick = hideInfoToast;

  // Global Actions
  elements.deleteAllBtn.onclick = handleDeleteAll;
  elements.themeToggleBtn.onclick = toggleTheme;
  elements.exportBtn.onclick = handleExport;
  elements.importBtn.onclick = () => elements.importFile.click();
  elements.importFile.onchange = handleImport;
}

// Theme Management
const systemDarkTheme = window.matchMedia('(prefers-color-scheme: dark)');

function getSavedTheme() {
  const theme = localStorage.getItem(CONFIG.THEME_KEY);
  return theme === 'light' || theme === 'dark' ? theme : null;
}

function initTheme() {
  const initialTheme = document.documentElement.getAttribute('data-theme');
  applyTheme(initialTheme === 'dark' ? 'dark' : 'light');

  systemDarkTheme.addEventListener('change', (event) => {
    if (!getSavedTheme()) {
      applyTheme(event.matches ? 'dark' : 'light');
    }
  });
}

function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme');
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(newTheme);
  localStorage.setItem(CONFIG.THEME_KEY, newTheme);
}

function applyTheme(theme) {
  const isDark = theme === 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.colorScheme = theme;
  elements.themeToggleBtn.textContent = isDark ? '🐈' : '🐈‍⬛';
  elements.themeToggleBtn.setAttribute('aria-label', `Switch to ${isDark ? 'light' : 'dark'} theme`);
}
