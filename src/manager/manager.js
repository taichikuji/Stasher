// Manager-page controller. Storage is the source of truth; this page redraws from
// it after every mutation so other extension contexts stay in sync.

// Constants and Configuration
const CONFIG = {
  STORAGE_KEY: 'stashedItems',
  CHROME_COLORS: ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'],
  UNDO_TIMEOUT_MS: 5000,
  NOTIFICATION_TIMEOUT_MS: 3000,
  MAX_TITLE_LENGTH: 200,
  MAX_IMPORT_BYTES: 1024 * 1024,
  MAX_IMPORT_ITEMS: 1000,
  MAX_TABS_PER_STASH: 500,
  ALLOWED_SCHEMES: ['http:', 'https:', 'chrome-extension:']
};

const PREFERENCE_DEFAULTS = {
  openOnStartup: false,
  keepAfterRestore: false,
  editOnDoubleClick: false,
  unloadAfterRestore: false
};

// State Management
const state = {
  undoStack: [],
  notificationTimeout: null,
  restoringIds: new Set(),
  preferences: null,
  preferencesRevision: 0,
  savingPreferences: new Set()
};

// Storage Helpers
const getStashItems = async () => {
  const result = await chrome.storage.local.get({ [CONFIG.STORAGE_KEY]: [] });
  return Array.isArray(result[CONFIG.STORAGE_KEY]) ? result[CONFIG.STORAGE_KEY] : [];
};

const getPreferences = async () => {
  const values = await chrome.storage.local.get(PREFERENCE_DEFAULTS);
  return Object.fromEntries(Object.keys(PREFERENCE_DEFAULTS).map(key => [key, values[key] === true]));
};

// The same lock used by the service worker prevents concurrent read-modify-write updates.
const updateStashItems = (updater) => navigator.locks.request('stasher-storage', async () => {
  const items = await getStashItems();
  const updated = await updater(items);
  if (Array.isArray(updated)) {
    await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: updated });
  }
  return updated;
});

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
  notification: document.getElementById('notification'),
  notificationMessage: document.getElementById('notification-message'),
  undoBtn: document.getElementById('notification-undo'),
  dismissNotificationBtn: document.getElementById('notification-dismiss'),
  actionsMenu: document.getElementById('actions-menu'),
  deleteAllBtn: document.getElementById('deleteAllBtn'),
  exportBtn: document.getElementById('exportBtn'),
  importBtn: document.getElementById('importBtn'),
  importFile: document.getElementById('importFile'),
  importModal: document.getElementById('import-modal'),
  oneTabText: document.getElementById('onetab-text'),
  searchInput: document.getElementById('searchInput'),
  confirmModal: document.getElementById('confirm-modal'),
  settingsBtn: document.getElementById('settingsBtn'),
  settingsModal: document.getElementById('settings-modal'),
  settingsError: document.getElementById('settings-error'),
  moreBtn: document.getElementById('moreBtn')
};
const preferenceInputs = Object.fromEntries(Object.keys(PREFERENCE_DEFAULTS)
  .map(key => [key, document.getElementById(key)]));

const iconMarkup = (name) =>
  `<svg class="button-icon" aria-hidden="true"><use href="#icon-${name}"></use></svg>`;

// Initial Load
loadStashes();

// Listen for local storage changes to update UI
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace !== 'local') return;
  if (changes[CONFIG.STORAGE_KEY]) loadStashes();
  for (const [key, input] of Object.entries(preferenceInputs)) {
    if (!changes[key]) continue;
    state.preferencesRevision++;
    if (state.preferences) {
      state.preferences[key] = changes[key].newValue === true;
      input.checked = state.preferences[key];
    }
  }
});

// Setup Event Listeners
setupEventListeners();

async function loadStashes() {
  try {
    // Rebuild instead of patching individual cards so storage changes from any
    // extension context produce one consistent view.
    const items = await getStashItems();
    elements.container.innerHTML = '';

    if (items.length === 0) {
      const p = document.createElement('p');
      p.className = 'empty-state';
      p.textContent = 'No tabs stashed yet.';
      elements.container.appendChild(p);
      return;
    }

    const visibleItems = rankStashesByQuery(items, elements.searchInput.value);
    if (visibleItems.length === 0) {
      const p = document.createElement('p');
      p.className = 'empty-state';
      p.textContent = 'No stashes match your search.';
      elements.container.appendChild(p);
      return;
    }

    elements.container.append(...visibleItems.map(createStashCard));

  } catch (error) {
    console.error("Error loading stashes:", error);
    const p = document.createElement('p');
    p.className = 'error-state';
    p.textContent = 'Error loading content.';
    elements.container.appendChild(p);
  }
}

function rankStashesByQuery(items, query) {
  const normalizedQuery = String(query || '').trim().toLocaleLowerCase();
  if (!normalizedQuery) return items;

  const matches = value =>
    typeof value === 'string' && value.toLocaleLowerCase().includes(normalizedQuery);
  const ranked = [[], [], []];

  for (const item of items) {
    const tabs = Array.isArray(item?.tabs) ? item.tabs : [];
    if (matches(item?.title)) ranked[0].push(item);
    else if (tabs.some(tab => matches(tab?.title))) ranked[1].push(item);
    else if (tabs.some(tab => matches(tab?.url))) ranked[2].push(item);
  }

  return ranked.flat();
}

/**
 * Creates the DOM element for a stash card.
 */
function createStashCard(item) {
  const card = document.createElement('article');
  card.className = 'stash-card';
  if (isCollapsed(item.id)) card.classList.add('collapsed');

  const header = document.createElement('div');
  header.className = 'card-header';
  header.id = `header-${item.id}`; // Give ID for easier swapping

  // Start in View Mode
  renderViewMode(header, item);

  const ul = document.createElement('ul');
  ul.className = 'link-list';

  const tabs = Array.isArray(item.tabs) ? item.tabs : [];
  tabs.forEach((tab, idx) => {
    if (!isAllowedTabUrl(tab.url)) return;
    const li = createTabListItem(tab, item.id, idx);
    ul.appendChild(li);
  });

  card.append(header, ul);
  return card;
}

// Collapse state is intentionally session-only; stashes always reopen after a browser restart.
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

  const icon = document.createElement('span');
  icon.className = 'link-icon';
  icon.setAttribute('aria-hidden', 'true');

  const favicon = document.createElement('img');
  favicon.className = 'link-favicon';
  favicon.alt = '';
  favicon.src = chrome.runtime.getURL(`_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`);
  favicon.onerror = () => {
    icon.replaceChildren();
    icon.classList.add('link-icon-fallback');
    icon.textContent = (tab.title?.trim() || url).charAt(0).toLocaleUpperCase();
  };
  icon.append(favicon);

  const a = document.createElement('a');
  a.href = url;
  a.textContent = tab.title || url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'icon-btn remove-tab-btn';
  removeBtn.innerHTML = iconMarkup('delete');
  removeBtn.setAttribute('aria-label', `Remove ${tab.title || url} from stash`);
  removeBtn.onclick = () => removeTabFromStash(stashId, tabIndex);

  li.append(icon, a, removeBtn);

  return li;
}

/**
 * Removes a single tab from a stash by its position in the tabs array.
 * Index-based (not URL-based) so duplicate URLs in the same stash can be
 * removed individually. If the stash has no tabs left, the entry is deleted.
 */
async function removeTabFromStash(stashId, tabIndex) {
  try {
    let undoEntry;
    await updateStashItems(items => {
      const index = items.findIndex(i => i.id === stashId);
      if (index === -1 || !Array.isArray(items[index].tabs)) return null;
      if (tabIndex < 0 || tabIndex >= items[index].tabs.length) return null;

      const removedTab = items[index].tabs[tabIndex];
      undoEntry = {
        kind: 'tab',
        stashSnapshot: structuredClone(items[index]),
        label: removedTab.title || removedTab.url || 'Tab'
      };

      items[index].tabs.splice(tabIndex, 1);

      if (items[index].tabs.length === 0) {
        items.splice(index, 1);
      }

      return items;
    });
    if (undoEntry) {
      state.undoStack.push(undoEntry);
      notifyDeletion();
    }
  } catch (error) {
    console.error("Error removing tab from stash:", error);
    showNotification('Could not remove this tab. Your saved tabs were kept.');
  }
}

/**
 * Formats an ISO timestamp for display.
 */
function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  return isNaN(date.getTime()) ? timestamp : date.toLocaleString();
}

/**
 * Renders the header in "View Mode".
 */
function renderViewMode(container, item) {
  container.innerHTML = '';
  const tabs = Array.isArray(item.tabs) ? item.tabs : [];

  // Collapse / Expand toggle
  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = 'icon-btn collapse-btn';
  const initiallyCollapsed = isCollapsed(item.id);
  collapseBtn.innerHTML = iconMarkup('down');
  collapseBtn.setAttribute('aria-expanded', String(!initiallyCollapsed));
  collapseBtn.setAttribute('aria-label', initiallyCollapsed ? 'Expand stash' : 'Collapse stash');
  collapseBtn.onclick = () => {
    const card = container.closest('.stash-card');
    if (!card) return;
    const nowCollapsed = card.classList.toggle('collapsed');
    setCollapsed(item.id, nowCollapsed);
    collapseBtn.setAttribute('aria-expanded', String(!nowCollapsed));
    collapseBtn.setAttribute('aria-label', nowCollapsed ? 'Expand stash' : 'Collapse stash');
  };

  // 1. Badge
  const badge = document.createElement('h2');
  badge.className = `group-badge color-${safeColor(item.color)}`;
  badge.textContent = item.title || (item.type === 'group' ? 'Untitled Group' : 'Ungrouped Tabs');
  badge.style.cursor = 'pointer';
  badge.addEventListener('dblclick', async () => {
    try {
      const preferences = await getPreferences();
      if (preferences.editOnDoubleClick) renderEditMode(container, item);
      else await restoreGroup(item, preferences);
    } catch (error) {
      console.error('Error loading preferences:', error);
      showNotification('Could not load settings. Please try again.');
    }
  });

  // 2. Edit Pencil Button
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'icon-btn edit-btn';
  editBtn.innerHTML = iconMarkup('edit');
  editBtn.title = 'Edit entry';
  editBtn.setAttribute('aria-label', 'Edit entry');
  editBtn.onclick = () => renderEditMode(container, item);

  // 3. Metadata
  const meta = document.createElement('span');
  meta.className = 'meta-info';
  meta.textContent = `${tabs.length} tabs \u2022 ${formatTimestamp(item.timestamp)}`;

  // 4. Action Buttons
  const actions = document.createElement('div');
  actions.className = 'card-actions';

  const btnRestore = document.createElement('button');
  btnRestore.type = 'button';
  btnRestore.className = 'primary icon-only';
  btnRestore.innerHTML = iconMarkup('restore');
  btnRestore.title = 'Restore Group';
  btnRestore.setAttribute('aria-label', `Restore all tabs from ${item.title || 'stash'}`);
  btnRestore.onclick = async () => {
    btnRestore.disabled = true;
    await restoreGroup(item);
    btnRestore.disabled = false;
  };

  const btnDelete = document.createElement('button');
  btnDelete.type = 'button';
  btnDelete.className = 'danger icon-only';
  btnDelete.innerHTML = iconMarkup('delete-stash');
  btnDelete.title = 'Delete Group';
  btnDelete.setAttribute('aria-label', `Delete ${item.title || 'stash'}`);
  btnDelete.onclick = () => deleteStash(item.id);

  actions.append(btnRestore, btnDelete);
  container.append(collapseBtn, badge, editBtn, meta, actions);
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
  const colorPicker = document.createElement('fieldset');
  colorPicker.className = 'color-picker';
  const colorLegend = document.createElement('legend');
  colorLegend.className = 'visually-hidden';
  colorLegend.textContent = 'Stash color';
  colorPicker.appendChild(colorLegend);
  let selectedColor = itemColor;

  CONFIG.CHROME_COLORS.forEach(color => {
    const dot = document.createElement('input');
    dot.type = 'radio';
    dot.name = `stash-color-${item.id}`;
    dot.value = color;
    dot.checked = color === itemColor;
    dot.className = `color-dot color-${color}`;
    dot.setAttribute('aria-label', color);
    dot.addEventListener('change', () => {
      selectedColor = color;
    });
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
  saveBtn.type = 'button';
  saveBtn.className = 'icon-btn icon-only save-btn';
  saveBtn.innerHTML = iconMarkup('check');
  saveBtn.setAttribute('aria-label', 'Save changes');
  saveBtn.onclick = handleSave;

  // 4. Cancel Button
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'icon-btn icon-only cancel-btn';
  cancelBtn.innerHTML = iconMarkup('delete');
  cancelBtn.setAttribute('aria-label', 'Cancel editing');
  // Re-fetch clean data to revert changes
  cancelBtn.onclick = handleCancel;

  wrapper.append(input, colorPicker, saveBtn, cancelBtn);
  container.appendChild(wrapper);
  input.focus();
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

async function restoreGroup(item, preferences) {
  // Avoid creating duplicate tabs when the restore control is activated twice.
  if (!item?.id || state.restoringIds.has(item.id)) return;
  state.restoringIds.add(item.id);
  const tabIds = [];

  try {
    preferences ??= await getPreferences();
    const tabs = Array.isArray(item.tabs) ? item.tabs.filter(t => isAllowedTabUrl(t.url)) : [];
    if (tabs.length === 0) return;
    const canRestoreGroup = item.type === 'group' &&
      await chrome.permissions.contains({ permissions: ['tabGroups'] });

    // 1. Create Tabs
    let unloadFailures = 0;
    const created = await Promise.all(tabs.map(async t => {
      const tab = await chrome.tabs.create({ url: t.url, active: false });
      tabIds.push(tab.id);
      if (preferences.unloadAfterRestore) {
        try {
          const discarded = await chrome.tabs.discard(tab.id);
          if (!discarded?.discarded) unloadFailures++;
        } catch (error) {
          console.error('Error unloading restored tab:', error);
          unloadFailures++;
        }
      }
      return tab;
    }));

    if (canRestoreGroup) {
      // 2. Create Group
      const groupId = await chrome.tabs.group({ tabIds: created.map(tab => tab.id) });

      // 3. Apply Properties
      await chrome.tabGroups.update(groupId, {
        title: typeof item.title === 'string' ? item.title : '',
        color: safeColor(item.color),
        collapsed: false
      });
    }

    // 4. Cleanup Storage. Await this so a successful restore cannot silently
    // leave a second, apparently unrestored copy behind.
    if (!preferences.keepAfterRestore) {
      const deleted = await deleteStash(item.id, { undo: false });
      if (!deleted) throw new Error('Restored stash was not found during cleanup');
    }
    showNotification(unloadFailures
      ? 'Restored your tabs. Some tabs could not be unloaded and remain loaded.'
      : 'Restored your tabs.');

  } catch (error) {
    console.error("Error restoring group:", error);
    showNotification(tabIds.length
      ? 'Tabs were opened, but restoration could not finish. The saved stash was kept to avoid data loss.'
      : 'Could not restore this stash. Your saved tabs were kept.');
  } finally {
    state.restoringIds.delete(item.id);
  }
}

async function deleteStash(id, { undo = true } = {}) {
  try {
    let deleted = false;
    let undoEntry;
    await updateStashItems(items => {
      const itemIndex = items.findIndex(i => i.id === id);
      if (itemIndex === -1) return null;

      if (undo) undoEntry = { kind: 'stash', item: items[itemIndex] };

      deleted = true;
      return items.filter(i => i.id !== id);
    });

    if (undoEntry) {
      state.undoStack.push(undoEntry);
      notifyDeletion();
    }
    return deleted;
  } catch (error) {
    console.error("Error deleting stash:", error);
    if (!undo) throw error;
    showNotification('Could not delete this stash. Your saved tabs were kept.');
    return false;
  }
}

function notifyDeletion() {
  const count = state.undoStack.length;
  if (count === 0) return;

  if (count === 1) {
    const entry = state.undoStack[0];
    const name = entry.kind === 'stash' ? entry.item.title || 'Group' : entry.label || 'Tab';
    showNotification(`Deleted "${name.substring(0, 20)}${name.length > 20 ? '...' : ''}"`);
  } else {
    showNotification(`${count} items deleted`);
  }
}

async function handleUndo() {
  if (elements.undoBtn.disabled) return;
  const entry = state.undoStack.pop();
  if (!entry) return;
  elements.undoBtn.disabled = true;
  clearTimeout(state.notificationTimeout);

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

    if (state.undoStack.length > 0) {
      notifyDeletion();
    } else {
      dismissNotification();
    }
  } catch (error) {
    console.error("Error undoing delete:", error);
    state.undoStack.push(entry);
    showNotification('Could not undo this deletion. Try Undo again.');
  } finally {
    elements.undoBtn.disabled = false;
  }
}

// Every notification uses and should use this native popover; pending deletions keep Undo available.
function showNotification(message) {
  clearTimeout(state.notificationTimeout);
  elements.notificationMessage.textContent = message;
  elements.undoBtn.hidden = state.undoStack.length === 0;
  elements.notification.showPopover();
  state.notificationTimeout = setTimeout(dismissNotification,
    state.undoStack.length ? CONFIG.UNDO_TIMEOUT_MS : CONFIG.NOTIFICATION_TIMEOUT_MS);
}

function dismissNotification() {
  clearTimeout(state.notificationTimeout);
  elements.notification.hidePopover();
  elements.undoBtn.hidden = true;
  // Dismissal or expiry forfeits Undo so later notifications cannot revive it.
  state.undoStack = [];
}

// Native dialogs share their close handling and return the chosen button value.
function showModal(modal) {
  return new Promise((resolve) => {
    modal.returnValue = 'cancel';
    modal.addEventListener('close', () => {
      resolve(modal.returnValue);
    }, { once: true });
    modal.showModal();
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
    setTimeout(() => URL.revokeObjectURL(url), 0);
    showNotification('Exported your stashes.');
  } catch (error) {
    console.error("Error exporting:", error);
    showNotification('Could not export your stashes.');
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

// OneTab's URL/title export separates saved groups with blank lines.
function parseOneTabExport(text) {
  if (!text.trim()) throw new Error('No tabs found in OneTab export.');
  const timestamp = new Date().toISOString();
  return text.replace(/\r\n?/g, '\n').trim().split(/\n\s*\n/).map((group, index) => ({
    id: crypto.randomUUID(),
    timestamp,
    type: 'group',
    title: `OneTab group ${index + 1}`,
    color: 'grey',
    tabs: group.split('\n').map(line => {
      const match = line.trim().match(/^(\S+)(?:[ \t]+\|[ \t]?(.*))?$/);
      if (!match) throw new Error('Invalid OneTab line. Expected URL | title. Nothing was imported.');
      return { url: match[1], title: match[2] || match[1] };
    })
  }));
}

async function showImportModal() {
  if (elements.importBtn.disabled) return;
  const action = await showModal(elements.importModal);
  if (action === 'file') elements.importFile.click();
  if (action === 'confirm' && await handleImport(new File([elements.oneTabText.value], 'onetab.txt'))) {
    elements.oneTabText.value = '';
  }
}

async function handleImport(file = elements.importFile.files[0]) {
  if (!file || elements.importBtn.disabled) return false;
  if (file.size > CONFIG.MAX_IMPORT_BYTES) {
    showNotification('Import file is too large.');
    elements.importFile.value = '';
    return false;
  }

  elements.importBtn.disabled = true;
  try {
    const text = await file.text();
    const isOneTab = /\.txt$/i.test(file.name || '');
    const importedData = isOneTab ? parseOneTabExport(text) : JSON.parse(text);
    if (!Array.isArray(importedData)) {
      showNotification('Invalid format: expected an array.');
      return;
    }
    if (importedData.length > CONFIG.MAX_IMPORT_ITEMS) {
      showNotification('Import contains too many stash items.');
      return;
    }

    const valid = importedData.filter(isValidStashItem).map(normalizeImportedItem);
    // OneTab migrations are all-or-nothing so invalid tabs cannot disappear silently.
    if (isOneTab && valid.length !== importedData.length) {
      throw new Error(`OneTab export has unsupported URLs or a group exceeds ${CONFIG.MAX_TABS_PER_STASH} tabs. Nothing was imported.`);
    }
    if (valid.length === 0) {
      showNotification('No valid stash items found in file.');
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

    showNotification(`Imported ${added} new stash${added !== 1 ? 'es' : ''}.`);
    return true;
  } catch (err) {
    console.error("Import error:", err);
    showNotification(err instanceof SyntaxError ? 'Invalid JSON backup.' : `Import failed: ${err.message}`);
    return false;
  } finally {
    // Reset so the same file can be re-imported
    elements.importFile.value = '';
    elements.importBtn.disabled = false;
  }
}

async function handleDeleteAll() {
  if (await showModal(elements.confirmModal) === 'confirm') {
    try {
      await updateStashItems(() => []);
      state.undoStack = [];
      showNotification('Deleted all stashes.');
    } catch (error) {
      console.error('Error deleting all stashes:', error);
      showNotification('Could not delete all stashes. Your saved tabs were kept.');
    }
  }
}

function setupEventListeners() {
  // Keep one-time page-level wiring separate from per-card listeners created during rendering.
  elements.undoBtn.onclick = handleUndo;
  elements.dismissNotificationBtn.onclick = dismissNotification;

  // Global Actions
  // Close before an action opens a dialog so focus returns to the More button.
  elements.actionsMenu.addEventListener('click', event => {
    if (event.target.closest('a, button')) elements.actionsMenu.hidePopover();
  }, { capture: true });
  elements.deleteAllBtn.onclick = handleDeleteAll;
  elements.exportBtn.onclick = handleExport;
  elements.importBtn.onclick = showImportModal;
  elements.settingsBtn.onclick = showSettings;
  elements.settingsModal.addEventListener('close', () => elements.moreBtn.focus());
  for (const [key, input] of Object.entries(preferenceInputs)) {
    input.addEventListener('change', () => savePreference(key));
  }
  elements.importFile.onchange = () => handleImport();
  elements.searchInput.oninput = loadStashes;
  document.addEventListener('keydown', event => {
    if (event.key === 'f' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      elements.searchInput.focus();
    }
  });
}

async function showSettings() {
  for (const input of Object.values(preferenceInputs)) input.disabled = true;
  state.preferences = null;
  elements.settingsError.hidden = true;
  elements.settingsModal.showModal();
  try {
    // Retry if another manager changed settings during this read.
    let revision;
    let preferences;
    do {
      revision = state.preferencesRevision;
      preferences = await getPreferences();
    } while (revision !== state.preferencesRevision);
    state.preferences = preferences;
    for (const [key, input] of Object.entries(preferenceInputs)) {
      input.checked = preferences[key];
      input.disabled = state.savingPreferences.has(key);
    }
  } catch (error) {
    console.error('Error loading preferences:', error);
    elements.settingsError.textContent = 'Could not load settings. Close this dialog and try again.';
    elements.settingsError.hidden = false;
  }
}

async function savePreference(key) {
  const input = preferenceInputs[key];
  if (!state.preferences || state.savingPreferences.has(key) || input.disabled) return;
  const value = input.checked;
  const previous = state.preferences[key];
  const revision = state.preferencesRevision;
  state.savingPreferences.add(key);
  input.disabled = true;
  elements.settingsError.hidden = true;
  try {
    await chrome.storage.local.set({ [key]: value });
    if (state.preferences && revision === state.preferencesRevision) state.preferences[key] = value;
    input.checked = state.preferences?.[key] ?? value;
  } catch (error) {
    console.error('Error saving preference:', error);
    input.checked = state.preferences?.[key] ?? previous;
    elements.settingsError.textContent = 'Could not save this setting. Its previous value was restored. Please try again.';
    elements.settingsError.hidden = false;
  } finally {
    state.savingPreferences.delete(key);
    input.disabled = state.preferences === null;
  }
}

// Cat easter egg — deliberately isolated from application logic.
(() => {
  const cats = ['🐈', '🐈‍⬛'];
  let count = 0;
  let timeout;

  function shoo() {
    const cat = document.querySelector('.pet-cat');
    if (!cat) return;
    cat.remove();
    timeout = setTimeout(shoo, 100);
  }

  document.getElementById('catBtn').onclick = () => {
    const cat = document.createElement('span');
    cat.className = 'pet-cat';
    cat.textContent = cats[count++ % cats.length];
    cat.setAttribute('aria-hidden', 'true');
    cat.style.left = `${5 + Math.random() * 90}%`;
    cat.style.top = `${5 + Math.random() * 90}%`;
    document.body.append(cat);
    clearTimeout(timeout);
    timeout = setTimeout(shoo, 3000);
  };
})();
