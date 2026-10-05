export const PANEL_TYPE = "panel";
export const SEPARATOR_TYPE = "separator";
export const MIN_PANEL_WIDTH = 320;
export const DEFAULT_PANEL_WIDTH = 420;

// Panel geometry.
//
// Ported from Tom Bar-Gal's ai/local-hardened-baseline branch, which solved
// this properly: the panel's maximum width has to come from the page viewport
// Zen actually gives the content, not from window.innerWidth. innerWidth is
// the whole chrome window, so Zen's left tab sidebar is never subtracted and
// the panel is free to grow over it.
//
// Both functions are pure so the arithmetic can be tested without a browser —
// the measuring is the caller's job.
export const PANEL_VIEWPORT_INSET = 8;
export const PANEL_VIEWPORT_MAX_WIDTH_RATIO = 0.95;
// The navigation controls sit just outside the panel frame. Reserve their
// whole footprint while clamping so a narrow panel cannot push them into
// Zen's sidebar. This stays deliberately in sync with the 34px Glance-size
// control, 8px resizer target, and 4px gutter in the stylesheet.
export const PANEL_CONTROL_LANE = 46;

function positiveNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function finiteNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// Intersect a measured rect with a fallback viewport, so a missing or nonsense
// measurement degrades to the window rather than to zero.
export function calculateWebPanelViewportGeometry(rect, fallbackViewport = {}) {
  const top = finiteNumber(rect?.top, 0);
  const left = finiteNumber(rect?.left, 0);
  const width = positiveNumber(rect?.width, positiveNumber(fallbackViewport.width, 1));
  const height = positiveNumber(
    rect?.height,
    positiveNumber(fallbackViewport.height, PANEL_VIEWPORT_INSET * 2)
  );

  const fallbackTop = finiteNumber(fallbackViewport.top, top);
  const fallbackLeft = finiteNumber(fallbackViewport.left, left);
  const fallbackWidth = positiveNumber(fallbackViewport.width, width);
  const fallbackHeight = positiveNumber(fallbackViewport.height, height);

  const visibleTop = Math.max(top, fallbackTop);
  const visibleBottom = Math.min(top + height, fallbackTop + fallbackHeight);
  const visibleLeft = Math.max(left, fallbackLeft);
  const visibleRight = Math.min(left + width, fallbackLeft + fallbackWidth);
  const visibleHeight = Math.max(0, visibleBottom - visibleTop);
  const visibleWidth = Math.max(0, visibleRight - visibleLeft);

  const unreservedMaxWidth = Math.max(1, Math.floor(visibleWidth * PANEL_VIEWPORT_MAX_WIDTH_RATIO));

  return {
    top: visibleTop + PANEL_VIEWPORT_INSET,
    height: Math.max(0, visibleHeight - PANEL_VIEWPORT_INSET * 2),
    // The page's visible width bounds the panel itself, but the controls also
    // occupy a lane on the page side of the frame. Clamping only the panel
    // here would still let that lane cover Zen's sidebar in a narrow window.
    maxWidth: Math.max(1, unreservedMaxWidth - PANEL_CONTROL_LANE),
    unreservedMaxWidth,
  };
}

// Turn a measured rect into a maximum, or null when the measurement cannot be
// trusted. Two ways it cannot: no rect at all (nothing laid out yet), or a
// maximum below the minimum panel width — which never means "the window is
// tiny", it means we measured the wrong element. Trusting either would be
// worse than not clamping: falling back to the whole window is how the panel
// ends up over Zen's sidebar, and a maximum under the minimum pins every
// clamp to a single value and freezes the resizer.
export function panelMaxWidthFromViewport(rect, fallbackViewport, minWidth = MIN_PANEL_WIDTH) {
  if (!rect || !(Number(rect.width) > 0)) {
    return null;
  }

  const { maxWidth, unreservedMaxWidth } = calculateWebPanelViewportGeometry(rect, fallbackViewport);
  // Validate the measurement before accounting for the control lane. A real
  // 400px page may sensibly leave 340px for the panel, while a 100px rect is
  // still a bad measurement and must not freeze the resizer.
  return unreservedMaxWidth >= minWidth ? maxWidth : null;
}

// The minimum yields to the maximum: on a window too narrow for MIN_PANEL_WIDTH
// a panel that overflows the viewport is worse than one below its floor.
export function clampWebPanelWidth(width, maxWidth, minWidth = MIN_PANEL_WIDTH) {
  const safeMax = Math.max(1, Math.floor(Number(maxWidth) || 1));
  const safeMin = Math.min(
    safeMax,
    Math.max(1, Math.round(Number(minWidth) || MIN_PANEL_WIDTH))
  );
  const requested = Number.isFinite(Number(width)) ? Math.round(Number(width)) : safeMin;
  return Math.min(safeMax, Math.max(safeMin, requested));
}

const PREFS = Object.freeze({
  enabled: "sine.web-panels.enabled",
  collapsed: "sine.web-panels.collapsed",
  width: "sine.web-panels.width",
  items: "sine.web-panels.items",
  shortcutModifier: "sine.web-panels.shortcut-modifier",
  navigationOrder: "sine.web-panels.navigation-order",
  lastUrls: "sine.web-panels.last-urls",
  lastTitles: "sine.web-panels.last-titles",
  resizerColor: "sine.web-panels.resizer-color",
});

// The resize handle's colour is the one setting that becomes CSS, so it is
// validated rather than trusted. Empty means "follow the theme", which is the
// default and the way back from any custom value.
//
// Hex and bare identifiers cover named colours; the functional forms are
// allowed with a deliberately narrow character set. No quotes, semicolons,
// braces or url() get through, so nothing here can escape the declaration it
// is written into.
const COLOR_FUNCTIONS = "rgba?|hsla?|hwb|lab|lch|oklab|oklch";
const COLOR_PATTERNS = Object.freeze([
  /^#[0-9a-f]{3,4}$/i,
  /^#[0-9a-f]{6}$/i,
  /^#[0-9a-f]{8}$/i,
  /^[a-z]+$/i,
  new RegExp(`^(?:${COLOR_FUNCTIONS})\\([0-9a-z%.,\\s/+-]*\\)$`, "i"),
]);

// Zen stamps :root[zen-right-side="true"] when its sidebar is on the right, and
// the rail takes the side the sidebar is NOT on. The inversion is the whole
// point and is easy to get backwards in a refactor, so it lives here where a
// test can hold it still.
export function webPanelSideForSidebar(zenRightSide) {
  return String(zenRightSide) === "true" ? "left" : "right";
}

export function normalizeResizerColor(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return "";
  }

  return COLOR_PATTERNS.some(pattern => pattern.test(trimmed)) ? trimmed : "";
}

// "accel" is the platform's primary modifier: Cmd on macOS, Ctrl elsewhere —
// the same concept Gecko uses for key elements, so a single setting is correct
// on every platform.
export const SHORTCUT_MODIFIERS = Object.freeze([
  "disabled",
  "accel",
  "accel+alt",
  "accel+shift",
  "alt",
  "alt+shift",
]);

export const DEFAULT_SHORTCUT_MODIFIER = "accel+alt";

export const NAVIGATION_ORDER_HISTORY_FIRST = "history-first";
export const NAVIGATION_ORDER_HOME_FIRST = "home-first";
export const NAVIGATION_ORDERS = Object.freeze([
  NAVIGATION_ORDER_HISTORY_FIRST,
  NAVIGATION_ORDER_HOME_FIRST,
]);
export const DEFAULT_NAVIGATION_ORDER = NAVIGATION_ORDER_HISTORY_FIRST;

export function normalizeNavigationOrder(value) {
  return NAVIGATION_ORDERS.includes(value) ? value : DEFAULT_NAVIGATION_ORDER;
}

// Values written before the setting became platform-neutral.
const LEGACY_SHORTCUT_MODIFIERS = Object.freeze({
  ctrl: "accel",
  "ctrl+alt": "accel+alt",
  "ctrl+shift": "accel+shift",
});

export function normalizeShortcutModifier(value) {
  const migrated = LEGACY_SHORTCUT_MODIFIERS[value] ?? value;
  return SHORTCUT_MODIFIERS.includes(migrated) ? migrated : DEFAULT_SHORTCUT_MODIFIER;
}

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

// The triggering principal for every page load the mod starts. It used to be
// the system principal; with it, the redirect-time CheckLoadURI is a
// pass-through, so a panel's server (or a MITM on an http: panel) answering
// 302 → file:/about:/chrome: was not stopped the way it is for a page's own
// navigation (audit 2026-10-02). The destination's own content principal keeps
// the load same-site, so SameSite=Strict cookies are still sent — a null
// principal would make it a cross-site navigation and open some sites logged
// out — and Firefox blocks those redirects. Anything but http(s) gets no
// principal at all, so a caller cannot load it.
export function loadPrincipalFor(url, chromeWindow = null) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  const href = parsed.href;
  const privateBrowsing = chromeWindow?.PrivateBrowsingUtils?.isWindowPrivate?.(chromeWindow) === true;
  return Services.scriptSecurityManager.createContentPrincipal(
    Services.io.newURI(href),
    privateBrowsing ? { privateBrowsingId: 1 } : {}
  );
}

export function prettyPanelName(rawTitle) {
  const stripped = String(rawTitle ?? "")
    .replace(/^\s*[([]\d{1,4}[)\]]\s*/, "")
    .trim();
  if (!stripped) {
    return null;
  }

  const parts = stripped
    .split(/\s+[-–—|·:]\s+/)
    .map(part => part.trim())
    .filter(Boolean);
  if (!parts.length) {
    return stripped;
  }

  const last = parts[parts.length - 1];
  // A long trailing segment is a headline, not a site name.
  return last.length <= 40 ? last : parts[0];
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
    // A name the user typed, kept apart from `title` so that re-deriving the
    // title from the URL can never silently discard it.
    name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : undefined,
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

  // Collapsed is not "disabled": the rail is out of sight and gives its strip
  // of window back, but every panel stays loaded and one hover at the window
  // edge brings it in. Disabling tears the runtime down.
  get collapsed() {
    return Services.prefs.getBoolPref(PREFS.collapsed, false);
  }

  set collapsed(value) {
    Services.prefs.setBoolPref(PREFS.collapsed, Boolean(value));
  }

  get width() {
    const value = Number.parseInt(readStringPref(PREFS.width, String(DEFAULT_PANEL_WIDTH)), 10);
    return Math.max(MIN_PANEL_WIDTH, Number.isFinite(value) ? value : DEFAULT_PANEL_WIDTH);
  }

  set width(value) {
    const width = Math.max(MIN_PANEL_WIDTH, Math.round(Number(value) || DEFAULT_PANEL_WIDTH));
    setStringPref(PREFS.width, String(width));
  }

  // "" means the accent falls back to its theme chain in the stylesheet.
  get resizerColor() {
    return normalizeResizerColor(readStringPref(PREFS.resizerColor, ""));
  }

  set resizerColor(value) {
    setStringPref(PREFS.resizerColor, normalizeResizerColor(value));
  }

  get shortcutModifier() {
    return normalizeShortcutModifier(
      readStringPref(PREFS.shortcutModifier, DEFAULT_SHORTCUT_MODIFIER)
    );
  }

  set shortcutModifier(value) {
    setStringPref(PREFS.shortcutModifier, normalizeShortcutModifier(value));
  }

  get navigationOrder() {
    return normalizeNavigationOrder(
      readStringPref(PREFS.navigationOrder, DEFAULT_NAVIGATION_ORDER)
    );
  }

  set navigationOrder(value) {
    setStringPref(PREFS.navigationOrder, normalizeNavigationOrder(value));
  }

  // Where each panel actually was, keyed by panel id. Deliberately a separate
  // pref from `items`: items is user configuration (order, titles, home urls),
  // and folding volatile navigation state into it would rewrite the whole rail
  // on every page change.
  get lastUrls() {
    try {
      const parsed = JSON.parse(readStringPref(PREFS.lastUrls, "{}"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  set lastUrls(value) {
    setStringPref(PREFS.lastUrls, JSON.stringify(value ?? {}));
  }

  // The URL a panel should open on: where it was last, falling back to its
  // configured home.
  resolveUrl(item) {
    const remembered = normalizeWebPanelUrl(this.lastUrls[item.id]);
    return remembered ?? item.url;
  }

  rememberUrl(id, rawUrl) {
    const url = normalizeWebPanelUrl(rawUrl);
    if (!url || !id) {
      return;
    }
    const next = this.lastUrls;
    if (next[id] === url) {
      return;
    }
    next[id] = url;
    this.lastUrls = next;
  }

  forgetUrl(id) {
    const next = this.lastUrls;
    if (!(id in next)) {
      return;
    }
    delete next[id];
    this.lastUrls = next;
  }

  // Panels are titled by hostname ("mail.google.com"), which is not what anyone
  // searches for. Remember the page's own title so the finder can match "gmail".
  // Titles stored before rememberTitle kept only the site name.
  scrubTitles() {
    const titles = this.lastTitles;
    let changed = false;
    for (const [id, title] of Object.entries(titles)) {
      const clean = prettyPanelName(title);
      if (clean !== title) {
        changed = true;
        if (clean) {
          titles[id] = clean;
        } else {
          delete titles[id];
        }
      }
    }
    if (changed) {
      this.lastTitles = titles;
    }
  }

  get lastTitles() {
    try {
      const parsed = JSON.parse(readStringPref(PREFS.lastTitles, "{}"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  set lastTitles(value) {
    setStringPref(PREFS.lastTitles, JSON.stringify(value ?? {}));
  }

  // Only the site name is kept. The full tab title is personal data that
  // would otherwise sit in prefs.js and about:config — Gmail's carries the
  // account address ("Inbox (1,140) - someone@gmail.com - Gmail") — and the
  // rail and finder only ever show the site name anyway.
  rememberTitle(id, title) {
    const clean = prettyPanelName(title);
    if (!id || !clean) {
      return;
    }
    const next = this.lastTitles;
    if (next[id] === clean) {
      return;
    }
    next[id] = clean;
    this.lastTitles = next;
  }

  forgetTitle(id) {
    const next = this.lastTitles;
    if (!(id in next)) {
      return;
    }
    delete next[id];
    this.lastTitles = next;
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

  createPanel(rawUrl, name = "") {
    const url = normalizeWebPanelUrl(rawUrl);
    if (!url) {
      return null;
    }
    return {
      type: PANEL_TYPE,
      id: generateId("panel"),
      title: titleFromUrl(url),
      name: name.trim() || undefined,
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

  updatePanel(id, rawUrl, name = null) {
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
      name: name === null ? nextItems[index].name : (name.trim() || undefined),
      url,
    };
    this.items = nextItems;
    return nextItems[index];
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
