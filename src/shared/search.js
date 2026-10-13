// Shared by the manager and the address-bar search; no storage or UI side effects.
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
