// Initial Load
document.addEventListener('DOMContentLoaded', loadStashes);

// REAL-TIME UPDATE LISTENER
// This listens for changes in chrome.storage.local. 
// If 'stashedItems' changes (because you clicked the extension icon), we reload the list.
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes.stashedItems) {
    loadStashes();
  }
});

const CHROME_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

// --- 1. Load and Render Data ---
async function loadStashes() {
  const result = await chrome.storage.local.get({ stashedItems: [] });
  const container = document.getElementById('stash-container');
  container.innerHTML = '';

  if (result.stashedItems.length === 0) {
    container.innerHTML = '<p style="text-align:center; padding:20px;">No tabs stashed yet.</p>';
    return;
  }

  result.stashedItems.forEach(item => {
    const card = document.createElement('div');
    card.className = 'stash-card';
    
    // --- HEADER CREATION ---
    const header = document.createElement('div');
    header.className = 'card-header';
    header.id = `header-${item.id}`; // Give ID for easier swapping

    // We render the "View Mode" by default
    renderViewMode(header, item);

    card.appendChild(header);

    // --- LIST CREATION ---
    const ul = document.createElement('ul');
    ul.className = 'link-list';

    item.tabs.forEach(tab => {
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
      ul.appendChild(li);
    });

    card.appendChild(ul);
    container.appendChild(card);
  });
}

// --- Helper: Render View Mode (Standard Display) ---
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

  // Assemble
  container.appendChild(badge);
  container.appendChild(editBtn);
  container.appendChild(meta);
  actions.appendChild(btnRestore);
  actions.appendChild(btnDelete);
  container.appendChild(actions);
}

// --- Helper: Render Edit Mode (Input + Colors) ---
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

  CHROME_COLORS.forEach(color => {
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

  // 3. Save Button (Checkmark)
  const saveBtn = document.createElement('button');
  saveBtn.className = 'icon-btn save-btn';
  saveBtn.innerHTML = '&#10004;';
  saveBtn.onclick = async () => {
    await updateStashData(item.id, input.value, selectedColor);
  };

  // 4. Cancel Button (X)
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'icon-btn cancel-btn';
  cancelBtn.innerHTML = '&#10006;';
  // Re-fetch clean data to revert changes
  cancelBtn.onclick = async () => {
    const freshData = await chrome.storage.local.get({ stashedItems: [] });
    const originalItem = freshData.stashedItems.find(i => i.id === item.id);
    renderViewMode(container, originalItem);
  };

  wrapper.appendChild(input);
  wrapper.appendChild(colorPicker);
  wrapper.appendChild(saveBtn);
  wrapper.appendChild(cancelBtn);
  container.appendChild(wrapper);
}

// --- Helper: Save Changes to Storage ---
async function updateStashData(id, newTitle, newColor) {
  const result = await chrome.storage.local.get({ stashedItems: [] });
  const index = result.stashedItems.findIndex(i => i.id === id);
  
  if (index !== -1) {
    // Update the specific fields
    result.stashedItems[index].title = newTitle;
    result.stashedItems[index].color = newColor;
    
    // Save back to storage (This triggers the onChanged listener to reload UI)
    await chrome.storage.local.set({ stashedItems: result.stashedItems });
  }
}

// --- 2. Restore Functionality (The "Stealth Mode" Fix) ---
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

      // ---------------------------------------------------------------------
      // THE FIX: "Stealth Hop"
      // We create the helper window MINIMIZED and UNFOCUSED.
      // ---------------------------------------------------------------------
      
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
    deleteStash(item.id);
    loadStashes();

  } catch (error) {
    console.error("Error restoring group:", error);
    // If something breaks, we don't alert the user, we just log it.
  } finally {
    // 6. SAFETY: Always close the temp window, even if errors occurred
    if (tempWindow) {
      await chrome.windows.remove(tempWindow.id);
    }
  }
}

// --- 3. Delete Functionality ---
async function deleteStash(id) {
  const result = await chrome.storage.local.get({ stashedItems: [] });
  const newItems = result.stashedItems.filter(item => item.id !== id);
  await chrome.storage.local.set({ stashedItems: newItems });
  loadStashes();
}

// --- 4. Export / Import ---
document.getElementById('deleteAllBtn').onclick = async () => {
  if(confirm("Are you sure you want to delete ALL history?")) {
    await chrome.storage.local.clear();
    loadStashes();
  }
};

document.getElementById('exportBtn').onclick = async () => {
  const result = await chrome.storage.local.get({ stashedItems: [] });
  const blob = new Blob([JSON.stringify(result.stashedItems, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `grouptab-stash-${Date.now()}.json`;
  a.click();
};

document.getElementById('importBtn').onclick = () => {
  document.getElementById('importFile').click();
};

document.getElementById('importFile').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (event) => {
    try {
      const importedData = JSON.parse(event.target.result);
      if (Array.isArray(importedData)) {
        const current = await chrome.storage.local.get({ stashedItems: [] });
        const merged = [...importedData, ...current.stashedItems];
        const unique = merged.filter((v,i,a)=>a.findIndex(t=>(t.id === v.id))===i);
        await chrome.storage.local.set({ stashedItems: unique });
        loadStashes();
        alert('Import successful!');
      }
    } catch (err) { alert('Error parsing JSON'); }
  };
  reader.readAsText(file);
};