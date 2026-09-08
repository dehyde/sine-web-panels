export const PANEL_TYPE = "panel";
export const SEPARATOR_TYPE = "separator";
export const MIN_PANEL_WIDTH = 320;
export const DEFAULT_PANEL_WIDTH = 420;

const PREFS = Object.freeze({
  enabled: "sine.web-panels.enabled",
  width: "sine.web-panels.width",
  items: "sine.web-panels.items",
});

function generateId(prefix = "item") {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.round(Math.random() * 100000)}`;
}

export function normalizeWebPanelUrl(rawUrl) {
  const trimmed = String(rawUrl ?? "").trim();
  if (!trimmed) {
    return null;
  }

  const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

export function titleFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const TITLE_PREFIX_UNREAD_COUNT = /^\s*(?:\((\d{1,4})\)|\[(\d{1,4})\])(?:\s+|$)/;

export function parseWebPanelUnreadCount(title) {
  if (typeof title !== "string") {
    return null;
  }

  const match = TITLE_PREFIX_UNREAD_COUNT.exec(title);
  if (!match) {
    return null;
  }

  const count = Number.parseInt(match[1] ?? match[2], 10);
  return count > 0 ? count : null;
}

export function formatWebPanelUnreadCount(count) {
  if (!Number.isInteger(count) || count <= 0) {
    return "";
  }
  return count > 99 ? "99+" : String(count);
}

function sanitizeItem(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const id = item.id ? String(item.id) : null;
  if (!id) {
    return null;
  }

  if (item.type === SEPARATOR_TYPE) {
    return { type: SEPARATOR_TYPE, id };
  }

  const url = normalizeWebPanelUrl(item.url);
  if (!url) {
    return null;
  }

  return {
    type: PANEL_TYPE,
    id,
    title: typeof item.title === "string" && item.title.trim() ? item.title.trim() : titleFromUrl(url),
    url,
  };
}

function readStringPref(name, fallback = "") {
  return Services.prefs.getStringPref(name, fallback);
}

function setStringPref(name, value) {
  Services.prefs.setStringPref(name, String(value));
}

export class WebPanelsStore {
  static prefs = PREFS;

  get enabled() {
    return Services.prefs.getBoolPref(PREFS.enabled, true);
  }

  set enabled(value) {
    Services.prefs.setBoolPref(PREFS.enabled, Boolean(value));
  }

  get width() {
    const value = Number.parseInt(readStringPref(PREFS.width, String(DEFAULT_PANEL_WIDTH)), 10);
    return Math.max(MIN_PANEL_WIDTH, Number.isFinite(value) ? value : DEFAULT_PANEL_WIDTH);
  }

  set width(value) {
    const width = Math.max(MIN_PANEL_WIDTH, Math.round(Number(value) || DEFAULT_PANEL_WIDTH));
    setStringPref(PREFS.width, String(width));
  }

  get items() {
    return this.loadItems();
  }

  set items(items) {
    const sanitized = Array.isArray(items) ? items.map(sanitizeItem).filter(Boolean) : [];
    setStringPref(PREFS.items, JSON.stringify(sanitized));
  }

  loadItems({ persistNormalized = false } = {}) {
    let parsed;
    try {
      parsed = JSON.parse(readStringPref(PREFS.items, "[]"));
    } catch {
      parsed = [];
    }

    if (!Array.isArray(parsed)) {
      parsed = [];
    }

    const sanitized = parsed.map(sanitizeItem).filter(Boolean);
    if (persistNormalized) {
      this.items = sanitized;
    }
    return sanitized;
  }

  createPanel(rawUrl) {
    const url = normalizeWebPanelUrl(rawUrl);
    if (!url) {
      return null;
    }
    return {
      type: PANEL_TYPE,
      id: generateId("panel"),
      title: titleFromUrl(url),
      url,
    };
  }

  createSeparator() {
    return {
      type: SEPARATOR_TYPE,
      id: generateId("separator"),
    };
  }

  insert(item, index = this.items.length) {
    const nextItems = this.items;
    const safeIndex = Math.max(0, Math.min(Number.isInteger(index) ? index : nextItems.length, nextItems.length));
    nextItems.splice(safeIndex, 0, item);
    this.items = nextItems;
    return nextItems;
  }

  updatePanel(id, rawUrl) {
    const url = normalizeWebPanelUrl(rawUrl);
    if (!url) {
      return null;
    }

    const nextItems = this.items;
    const index = nextItems.findIndex(item => item.id === id && item.type === PANEL_TYPE);
    if (index < 0) {
      return null;
    }

    nextItems[index] = {
      ...nextItems[index],
      title: titleFromUrl(url),
      url,
    };
    this.items = nextItems;
    return nextItems[index];
  }

  replacePanel(item) {
    const normalizedItem = sanitizeItem(item);
    if (normalizedItem?.type !== PANEL_TYPE) {
      return null;
    }

    const nextItems = this.items;
    const index = nextItems.findIndex(
      entry => entry.id === normalizedItem.id && entry.type === PANEL_TYPE
    );
    if (index < 0) {
      return null;
    }

    nextItems[index] = normalizedItem;
    this.items = nextItems;
    return normalizedItem;
  }

  remove(id) {
    const nextItems = this.items.filter(item => item.id !== id);
    this.items = nextItems;
    return nextItems;
  }

  move(id, targetIndex) {
    const nextItems = this.items;
    const currentIndex = nextItems.findIndex(item => item.id === id);
    if (currentIndex < 0) {
      return nextItems;
    }

    const [item] = nextItems.splice(currentIndex, 1);
    const safeIndex = Math.max(0, Math.min(targetIndex, nextItems.length));
    nextItems.splice(safeIndex, 0, item);
    this.items = nextItems;
    return nextItems;
  }
}
