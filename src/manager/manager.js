// Constants and Configuration
const CONFIG = {
  STORAGE_KEY: 'stashedItems',
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
  infoTimeout: null,
  restoringIds: new Set()
};

// Storage Helpers
const getStashItems = async () => {
  const result = await chrome.storage.local.get({ [CONFIG.STORAGE_KEY]: [] });
  return Array.isArray(result[CONFIG.STORAGE_KEY]) ? result[CONFIG.STORAGE_KEY] : [];
};

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
  undoToast: document.getElementById('undo-toast'),
  undoMsg: document.getElementById('undo-msg'),
  undoBtn: document.getElementById('undo-btn'),
  closeToastBtn: document.getElementById('close-toast'),
  infoToast: document.getElementById('info-toast'),
  infoMsg: document.getElementById('info-msg'),
  closeInfoToastBtn: document.getElementById('close-info-toast'),
  deleteAllBtn: document.getElementById('deleteAllBtn'),
  exportBtn: document.getElementById('exportBtn'),
  importBtn: document.getElementById('importBtn'),
  importFile: document.getElementById('importFile'),
  searchInput: document.getElementById('searchInput'),
  confirmModal: document.getElementById('confirm-modal'),
  confirmTitle: document.getElementById('confirm-title')
};

const iconMarkup = (name) =>
  `<svg class="button-icon" aria-hidden="true"><use href="#icon-${name}"></use></svg>`;

// Initial Load
loadStashes();

// Listen for local storage changes to update UI
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

    const visibleItems = items.filter(item => stashMatchesQuery(item, elements.searchInput.value));
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

function stashMatchesQuery(item, query) {
  const normalizedQuery = String(query || '').trim().toLocaleLowerCase();
  if (!normalizedQuery) return true;

  const searchableValues = [
    item?.title,
    ...(Array.isArray(item?.tabs)
      ? item.tabs.flatMap(tab => [tab?.title, tab?.url])
      : [])
  ];

  return searchableValues.some(value =>
    typeof value === 'string' && value.toLocaleLowerCase().includes(normalizedQuery)
  );
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
  icon.textContent = (tab.title?.trim() || url).charAt(0).toLocaleUpperCase();
  icon.setAttribute('aria-hidden', 'true');

  const a = document.createElement('a');
  a.href = url;
  a.textContent = tab.title || url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';

  const removeBtn = document.createElement('button');
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
  const badge = document.createElement('span');
  badge.className = `group-badge color-${safeColor(item.color)}`;
  badge.textContent = item.title || (item.type === 'group' ? 'Untitled Group' : 'Ungrouped Tabs');
  badge.style.cursor = 'pointer';
  badge.addEventListener('dblclick', () => restoreGroup(item));

  // 2. Edit Pencil Button
  const editBtn = document.createElement('button');
  editBtn.className = 'icon-btn edit-btn';
  editBtn.innerHTML = iconMarkup('edit');
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
  btnRestore.className = 'primary icon-only';
  btnRestore.innerHTML = iconMarkup('restore');
  btnRestore.title = 'Restore all tabs';
  btnRestore.setAttribute('aria-label', `Restore all tabs from ${item.title || 'stash'}`);
  btnRestore.onclick = async () => {
    btnRestore.disabled = true;
    await restoreGroup(item);
    btnRestore.disabled = false;
  };

  const btnDelete = document.createElement('button');
  btnDelete.className = 'danger icon-only';
  btnDelete.innerHTML = iconMarkup('delete-stash');
  btnDelete.title = 'Delete stash';
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
  saveBtn.className = 'icon-btn icon-only save-btn';
  saveBtn.innerHTML = iconMarkup('check');
  saveBtn.setAttribute('aria-label', 'Save changes');
  saveBtn.onclick = handleSave;

  // 4. Cancel Button
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'icon-btn icon-only cancel-btn';
  cancelBtn.innerHTML = iconMarkup('delete');
  cancelBtn.setAttribute('aria-label', 'Cancel editing');
  // Re-fetch clean data to revert changes
  cancelBtn.onclick = handleCancel;

  wrapper.append(input, colorPicker, saveBtn, cancelBtn);
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
  if (!item?.id || state.restoringIds.has(item.id)) return;
  state.restoringIds.add(item.id);
  const tabIds = [];

  try {
    const tabs = Array.isArray(item.tabs) ? item.tabs.filter(t => isAllowedTabUrl(t.url)) : [];
    if (tabs.length === 0) return;

    // 1. Create Tabs (in batches of 5 to avoid overwhelming the browser)
    for (let i = 0; i < tabs.length; i += 5) {
      const batch = tabs.slice(i, i + 5);
      const created = await Promise.all(
        batch.map(t => chrome.tabs.create({ url: t.url, active: false }))
      );
      tabIds.push(...created.map(t => t.id));
    }

    if (item.type === 'group') {
      // 2. Create Group
      const groupId = await chrome.tabs.group({ tabIds });

      // 3. Apply Properties
      await chrome.tabGroups.update(groupId, {
        title: typeof item.title === 'string' ? item.title : '',
        color: safeColor(item.color),
        collapsed: false
      });

      // Chrome 145 workaround: see fc42161032708ada098ab69c095ec945823fcffe; its removal is the following commit.
    }

    // 4. Cleanup Storage. Await this so a successful restore cannot silently
    // leave a second, apparently unrestored copy behind.
    const deleted = await deleteStash(item.id, { undo: false });
    if (!deleted) throw new Error('Restored stash was not found during cleanup');

  } catch (error) {
    console.error("Error restoring group:", error);
    showInfoToast(tabIds.length
      ? 'Tabs were opened, but the saved stash could not be removed. It was kept to avoid data loss.'
      : 'Could not restore this stash. Your saved tabs were kept.');
  } finally {
    state.restoringIds.delete(item.id);
  }
}

async function deleteStash(id, { undo = true } = {}) {
  try {
    let deleted = false;
    await updateStashItems(items => {
      // 1. Get current list to find the item we are about to delete
      const itemIndex = items.findIndex(i => i.id === id);
      if (itemIndex === -1) return null;

      // 2. Save it to memory (The Safety Net)
      if (undo) state.undoStack.push({ kind: 'stash', item: items[itemIndex] });

      // 3. Remove it from storage immediately
      deleted = true;
      return items.filter(i => i.id !== id);
    });

    // 4. Show the Undo Toast
    if (deleted && undo) showUndoToast();
    return deleted;
  } catch (error) {
    console.error("Error deleting stash:", error);
    if (!undo) throw error;
    return false;
  }
}

function showUndoToast() {
  const count = state.undoStack.length;
  if (count === 0) return;

  if (count === 1) {
    const entry = state.undoStack[0];
    const name = entry.kind === 'stash' ? entry.item.title || 'Group' : entry.label || 'Tab';
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

// Confirm Modal
function showConfirmModal(message) {
  return new Promise((resolve) => {
    elements.confirmTitle.textContent = message;
    elements.confirmModal.returnValue = 'cancel';
    elements.confirmModal.addEventListener('close', () => {
      resolve(elements.confirmModal.returnValue === 'confirm');
    }, { once: true });
    elements.confirmModal.showModal();
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
    showInfoToast('Exported your stashes.');
  } catch (error) {
    console.error("Error exporting:", error);
    showInfoToast('Could not export your stashes.');
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

function parseUrlListText(text) {
  const groups = String(text)
    .trim()
    .split(/\r?\n\s*\r?\n+/);
  const items = [];
  let skipped = 0;

  for (const group of groups) {
    const tabs = [];
    for (const rawLine of group.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;

      const separatorIndex = line.indexOf(' | ');
      const url = (separatorIndex === -1 ? line : line.slice(0, separatorIndex)).trim();
      const suppliedTitle = separatorIndex === -1 ? '' : line.slice(separatorIndex + 3).trim();

      if (!isAllowedTabUrl(url)) {
        skipped += 1;
        continue;
      }

      tabs.push({
        url,
        title: (suppliedTitle || url).slice(0, CONFIG.MAX_TITLE_LENGTH)
      });
    }

    for (let index = 0; index < tabs.length; index += CONFIG.MAX_TABS_PER_STASH) {
      items.push({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        type: 'loose',
        title: 'Imported Tabs',
        color: 'grey',
        tabs: tabs.slice(index, index + CONFIG.MAX_TABS_PER_STASH)
      });
    }
  }

  return { items, skipped };
}

function parseImportedContent(text) {
  try {
    const data = JSON.parse(text);
    if (!Array.isArray(data)) {
      return { error: 'Invalid Stasher JSON: expected an array.' };
    }
    if (data.length > CONFIG.MAX_IMPORT_ITEMS) {
      return { error: 'Import contains too many stash items.' };
    }

    const items = data.filter(isValidStashItem).map(normalizeImportedItem);
    return { items, skipped: data.length - items.length };
  } catch {
    const parsed = parseUrlListText(text);
    if (parsed.items.length > CONFIG.MAX_IMPORT_ITEMS) {
      return { error: 'Import contains too many stash items.' };
    }
    return parsed;
  }
}

async function handleImport(event) {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > CONFIG.MAX_IMPORT_BYTES) {
    showInfoToast('Import file is too large.');
    event.target.value = '';
    return;
  }

  try {
    const parsed = parseImportedContent(await file.text());
    if (parsed.error) {
      showInfoToast(parsed.error);
      return;
    }

    const valid = parsed.items;
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

    const skippedMessage = parsed.skipped > 0
      ? ` Skipped ${parsed.skipped} invalid entr${parsed.skipped === 1 ? 'y' : 'ies'}.`
      : '';
    showInfoToast(`Imported ${added} new stash${added !== 1 ? 'es' : ''}.${skippedMessage}`);
  } catch (err) {
    console.error("Import error:", err);
    showInfoToast('Could not import this file.');
  } finally {
    // Reset so the same file can be re-imported
    event.target.value = '';
  }
}

async function handleDeleteAll() {
  const confirmed = await showConfirmModal(
    "WARNING: This will delete ALL saved tabs and groups.\n\nAre you sure you want to proceed?"
  );
  if (confirmed) {
    await updateStashItems(() => []);
    hideUndoToast();
  }
}

function setupEventListeners() {
  // Toast Listeners
  elements.undoBtn.onclick = handleUndo;
  elements.closeToastBtn.onclick = hideUndoToast;
  elements.closeInfoToastBtn.onclick = hideInfoToast;

  // Global Actions
  elements.deleteAllBtn.onclick = handleDeleteAll;
  elements.exportBtn.onclick = handleExport;
  elements.importBtn.onclick = () => elements.importFile.click();
  elements.importFile.onchange = handleImport;
  elements.searchInput.oninput = loadStashes;
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
