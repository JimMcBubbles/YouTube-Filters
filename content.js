(() => {
  "use strict";

  // ---- Injection proof ----
  document.documentElement.setAttribute("data-yf-injected", "1");
  console.log("[YF] injected:", location.href);

  // ---- Storage keys ----
  // Sync: cross-device list of hidden entries (kept minimal)
  const SYNC_ENTRIES_KEY = "hiddenVideos"; // [{id, hiddenAt, postedAtApprox}]
  // Legacy: old array of ids
  const LEGACY_IDS_KEY = "hiddenVideoIds";
  // Local: richer metadata cache (title/channel/thumb/postedText)
  const LOCAL_META_KEY = "hiddenVideoMeta"; // { [id]: {title, channel, thumb, postedText, lastSeenAt} }

  // ---- UI flags ----
  const OVERLAY_ATTR = "data-yf-overlay";
  const CARD_PROCESSED_ATTR = "data-yf-card-processed";
  const HIDDEN_CLASS = "yf-hidden-target";
  const SIDEBAR_ITEM_ATTR = "data-yf-sidebar-hidden-link";

  // ---- Match any link that can reasonably identify a video ----
  const VIDEO_ANCHOR_SELECTOR = [
    "a[href*='watch?v=']",
    "a[href^='/watch']",
    "a[href^='https://www.youtube.com/watch']",
    "a[href^='/shorts/']",
    "a[href^='https://www.youtube.com/shorts/']"
  ].join(",");

  // ---- Outer containers that actually define layout slots ----
  const OUTER_CARD_SELECTORS = [
    "ytd-rich-item-renderer",
    "ytd-rich-grid-media",
    "ytd-video-renderer",
    "ytd-grid-video-renderer",
    "ytd-compact-video-renderer",
    "ytd-playlist-video-renderer",
    "ytd-reel-item-renderer",
    "ytd-compact-movie-renderer"
  ].join(",");

  // ---- Inner lockup components that sometimes sit inside the outer card ----
  const INNER_LOCKUP_SELECTORS = [
    "yt-lockup-view-model",
    "ytd-lockup-view-model",
    "ytm-lockup-view-model"
  ].join(",");

  const ANY_CARD_SELECTORS = [OUTER_CARD_SELECTORS, INNER_LOCKUP_SELECTORS].join(",");

  // ---- Thumbnail-ish containers we prefer for overlay anchoring ----
  const THUMB_HOST_SELECTORS = [
    "ytd-thumbnail",
    "yt-thumbnail-view-model",
    "#thumbnail",
    ".yt-lockup-view-model__content-image",
    "[class*='thumbnail']",
    "[id*='thumbnail']",
    "img"
  ].join(",");

  // ---- State ----
  /** @type {{id:string, hiddenAt:number, postedAtApprox:number|null}[]} */
  let hiddenEntries = [];
  /** @type {Set<string>} */
  let hiddenIds = new Set();
  /** @type {Record<string, {title?:string, channel?:string, thumb?:string, postedText?:string, lastSeenAt?:number}>} */
  let metaCache = {};

  let scanScheduled = false;
  let lastAnchorCount = -1;
  let lastCardCount = -1;

  function now() {
    return Date.now();
  }

  function ensureGlobalStyle() {
    if (document.getElementById("yf-style")) return;
    const style = document.createElement("style");
    style.id = "yf-style";
    style.textContent = `.${HIDDEN_CLASS}{display:none!important;}`;
    document.documentElement.appendChild(style);
  }

  function getVideoIdFromUrl(url) {
    try {
      const u = new URL(url, location.origin);

      const v = u.searchParams.get("v");
      if (v) return v;

      const shortsMatch = u.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]{6,})/);
      if (shortsMatch) return shortsMatch[1];

      return null;
    } catch {
      return null;
    }
  }

  // ---- Shadow-DOM helpers ----
  function isElement(node) {
    return node && node.nodeType === Node.ELEMENT_NODE;
  }

  function getRootNodeSafe(el) {
    try {
      return el.getRootNode?.() || document;
    } catch {
      return document;
    }
  }

  // closest() that can cross a shadow boundary to the host element and continue searching
  function closestDeep(el, selector) {
    let cur = el;
    while (cur) {
      if (isElement(cur) && cur.matches(selector)) return cur;

      const parent = cur.parentElement;
      if (parent) {
        cur = parent;
        continue;
      }

      const root = getRootNodeSafe(cur);
      if (root && root instanceof ShadowRoot && root.host) {
        cur = root.host;
        continue;
      }

      cur = null;
    }
    return null;
  }

  // Query selector all in light DOM + recursively in OPEN shadow roots
  function querySelectorAllDeep(selector, root = document) {
    const results = [];

    function walk(node) {
      if (!node) return;

      try {
        results.push(...node.querySelectorAll(selector));
      } catch {
        // ignore
      }

      const treeWalker = document.createTreeWalker(
        node instanceof ShadowRoot ? node : node,
        NodeFilter.SHOW_ELEMENT
      );

      let current = treeWalker.currentNode;
      while (current) {
        if (current.shadowRoot) walk(current.shadowRoot); // open only
        current = treeWalker.nextNode();
      }
    }

    walk(root);
    return results;
  }

  // ---- Hide target selection (the key to avoiding blank holes) ----
  function getHideTargetForAnyCard(anyCard) {
    if (!(anyCard instanceof HTMLElement)) return null;

    // If we matched an inner lockup, promote to the outer layout card
    if (anyCard.matches(INNER_LOCKUP_SELECTORS)) {
      const outer = closestDeep(anyCard, OUTER_CARD_SELECTORS);
      return outer || anyCard;
    }

    // If we matched an outer card, use it
    if (anyCard.matches(OUTER_CARD_SELECTORS)) return anyCard;

    // Fallback: try to find an outer card anyway
    return closestDeep(anyCard, OUTER_CARD_SELECTORS) || anyCard;
  }

  function hideIfNeeded(hideTarget, videoId) {
    if (!videoId || !hideTarget) return;
    if (hiddenIds.has(videoId)) hideTarget.classList.add(HIDDEN_CLASS);
    else hideTarget.classList.remove(HIDDEN_CLASS);
  }

  // ---- Relative time parsing (best-effort) ----
  // Converts strings like "3 hours ago", "1 day ago", "2 weeks ago", "Streamed 5 hours ago"
  // into an approximate posted timestamp (ms since epoch).
  function parsePostedAtApprox(postedText) {
    if (!postedText || typeof postedText !== "string") return null;

    const t = postedText.toLowerCase().trim();

    // Common cases: "x hours ago", "streamed x hours ago", "x days ago", etc.
    // Also handle "yesterday" (rare in YouTube UI), and "just now".
    if (t.includes("just now")) return now();

    if (t.includes("yesterday")) return now() - 24 * 60 * 60 * 1000;

    const m = t.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/);
    if (!m) return null;

    const n = Number(m[1]);
    if (!Number.isFinite(n)) return null;

    const unit = m[2];
    const ms = {
      second: 1000,
      minute: 60 * 1000,
      hour: 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
      week: 7 * 24 * 60 * 60 * 1000,
      // Approximate months/years
      month: 30 * 24 * 60 * 60 * 1000,
      year: 365 * 24 * 60 * 60 * 1000
    }[unit];

    return now() - n * ms;
  }

  // ---- Metadata extraction from a card (best-effort) ----
  function safeText(el) {
    if (!el) return "";
    const txt = (el.textContent || "").trim();
    return txt;
  }

  function extractMetaFromCard(card) {
    // title
    const titleEl =
      card.querySelector?.("#video-title, a#video-title") ||
      card.querySelector?.("a[title][href*='watch']") ||
      card.querySelector?.(".yt-lockup-view-model__title") ||
      card.querySelector?.("h3 a") ||
      null;

    const title =
      (titleEl && (titleEl.getAttribute?.("title") || safeText(titleEl))) || "";

    // channel
    const channelEl =
      card.querySelector?.("#channel-name a") ||
      card.querySelector?.("ytd-channel-name a") ||
      card.querySelector?.(".yt-lockup-view-model__channel-name a") ||
      card.querySelector?.("a[href^='/@']") ||
      null;

    const channel = channelEl ? safeText(channelEl) : "";

    // posted text (subscriptions/feed usually has metadata line spans)
    const postedEl =
      card.querySelector?.("#metadata-line span:last-child") ||
      card.querySelector?.(".yt-lockup-metadata-view-model__metadata span:last-child") ||
      card.querySelector?.("span.inline-metadata-item:last-child") ||
      null;

    const postedText = postedEl ? safeText(postedEl) : "";

    // thumbnail
    const imgEl =
      card.querySelector?.("img#img") ||
      card.querySelector?.("ytd-thumbnail img") ||
      card.querySelector?.("img[src*='ytimg']") ||
      card.querySelector?.("img") ||
      null;

    const thumb = imgEl ? (imgEl.currentSrc || imgEl.src || "") : "";

    return { title, channel, postedText, thumb };
  }

  function metaStorageKey(id) {
    return `${LOCAL_META_KEY}:${id}`;
  }

  async function loadState() {
    // 1) Load sync entries (new format)
    const sync = await chrome.storage.sync.get({
      [SYNC_ENTRIES_KEY]: null,
      [LEGACY_IDS_KEY]: null
    });

    const entries = sync[SYNC_ENTRIES_KEY];
    const legacyIds = sync[LEGACY_IDS_KEY];

    // 2) Reset local meta cache (per-id storage in local).
    metaCache = {};

    // 3) Migrate legacy ids if present and entries not present
    if (!Array.isArray(entries) || entries.length === 0) {
      if (Array.isArray(legacyIds) && legacyIds.length > 0) {
        hiddenEntries = legacyIds
          .filter((x) => typeof x === "string" && x.length > 0)
          .map((id) => ({
            id,
            hiddenAt: now(),
            postedAtApprox: null
          }));

        await chrome.storage.sync.set({ [SYNC_ENTRIES_KEY]: hiddenEntries });
        // keep legacy key around or remove it; removing is cleaner
        await chrome.storage.sync.remove(LEGACY_IDS_KEY);
      } else {
        hiddenEntries = [];
      }
    } else {
      hiddenEntries = entries
        .filter((e) => e && typeof e.id === "string")
        .map((e) => ({
          id: e.id,
          hiddenAt: Number.isFinite(e.hiddenAt) ? e.hiddenAt : now(),
          postedAtApprox:
            e.postedAtApprox === null || Number.isFinite(e.postedAtApprox)
              ? e.postedAtApprox
              : null
        }));
    }

    hiddenIds = new Set(hiddenEntries.map((e) => e.id));
  }

  async function saveEntries() {
    await chrome.storage.sync.set({ [SYNC_ENTRIES_KEY]: hiddenEntries });
  }

  function upsertEntry(id, patch) {
    const idx = hiddenEntries.findIndex((e) => e.id === id);
    if (idx >= 0) {
      hiddenEntries[idx] = { ...hiddenEntries[idx], ...patch };
    } else {
      hiddenEntries.push({
        id,
        hiddenAt: now(),
        postedAtApprox: null,
        ...patch
      });
    }
    hiddenIds = new Set(hiddenEntries.map((e) => e.id));
  }

  function removeEntry(id) {
    hiddenEntries = hiddenEntries.filter((e) => e.id !== id);
    hiddenIds.delete(id);
  }

  // ---- Overlay ----
  function createOverlayButton({ checked, onToggle }) {
    const host = document.createElement("div");
    host.setAttribute(OVERLAY_ATTR, "1");
    host.style.position = "absolute";
    host.style.top = "6px";
    host.style.left = "6px";
    host.style.zIndex = "20"; // keep sane so menus win
    host.style.pointerEvents = "auto";

    const shadow = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = `
      button{
        all:unset;
        width:22px;height:22px;
        border-radius:6px;
        box-sizing:border-box;
        display:grid;place-items:center;
        cursor:pointer;
        background:rgba(0,0,0,.55);
        border:1px solid rgba(255,255,255,.35);
        backdrop-filter:blur(2px)
      }
      button:hover{background:rgba(0,0,0,.70);border-color:rgba(255,255,255,.55)}
      .mark{width:14px;height:14px;display:block}
      .checked path{opacity:1}
      .unchecked path{opacity:.25}
      button:focus-visible{outline:2px solid #fff;outline-offset:2px}
    `;

    const btn = document.createElement("button");
    btn.type = "button";

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.classList.add("mark");

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M9 16.2l-3.5-3.5L4 14.2l5 5 12-12-1.5-1.5z");
    path.setAttribute("fill", "white");

    svg.appendChild(path);
    btn.appendChild(svg);

    function setCheckedUI(isChecked) {
      btn.classList.toggle("checked", isChecked);
      btn.classList.toggle("unchecked", !isChecked);
      btn.setAttribute("aria-label", isChecked ? "Unhide video" : "Hide video");
      btn.setAttribute("title", isChecked ? "Unhide video" : "Hide video");
    }
    setCheckedUI(checked);

    btn.addEventListener(
      "click",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle(setCheckedUI);
      },
      true
    );

    shadow.appendChild(style);
    shadow.appendChild(btn);
    return host;
  }

  function ensurePositioningContext(el) {
    if (!(el instanceof HTMLElement)) return;
    const computedPos = getComputedStyle(el).position;
    if (computedPos === "static") el.style.position = "relative";
  }

  function isAriaHidden(el) {
    if (!(el instanceof HTMLElement)) return false;
    return el.getAttribute("aria-hidden") === "true" || el.closest?.("[aria-hidden='true']");
  }

  function pickOverlayHostFromCard(card) {
    const candidates = querySelectorAllDeep(THUMB_HOST_SELECTORS, card).filter(
      (c) => c instanceof HTMLElement
    );

    const score = (el) => {
      const tag = (el.tagName || "").toLowerCase();
      const id = (el.id || "").toLowerCase();
      const cls = (el.className || "").toString().toLowerCase();

      if (isAriaHidden(el)) return -1000;
      if (tag.includes("ytd-thumbnail") || tag.includes("yt-thumbnail-view-model")) return 100;
      if (cls.includes("yt-lockup-view-model__content-image")) return 95;
      if (id === "thumbnail" || id.includes("thumbnail")) return 90;
      if (cls.includes("thumbnail")) return 80;
      if (tag === "img") return 60;
      return 10;
    };

    let best = null;
    let bestScore = -1;
    for (const c of candidates) {
      const rect = c.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 40) continue;
      const s = score(c);
      if (s > bestScore) {
        bestScore = s;
        best = c;
      }
    }

    while (best && isAriaHidden(best)) best = best.parentElement;
    return best || card;
  }

  function pickPrimaryVideoAnchor(card) {
    const anchors = querySelectorAllDeep(VIDEO_ANCHOR_SELECTOR, card).filter(
      (a) => a instanceof HTMLAnchorElement
    );
    if (anchors.length === 0) return null;

    const score = (a) => {
      const id = (a.id || "").toLowerCase();
      const cls = (a.className || "").toString().toLowerCase();
      if (id === "thumbnail" || id.includes("thumbnail")) return 100;
      if (cls.includes("thumbnail")) return 90;
      if (cls.includes("content-image")) return 85;
      if (a.querySelector("img, ytd-thumbnail, yt-thumbnail-view-model")) return 80;
      return 50;
    };

    let best = null;
    let bestScore = -1;
    for (const a of anchors) {
      const vid = getVideoIdFromUrl(a.href);
      if (!vid) continue;
      const s = score(a);
      if (s > bestScore) {
        bestScore = s;
        best = a;
      }
    }
    return best;
  }

  async function ensureSidebarHiddenLink() {
    const hiddenUrl = chrome.runtime.getURL("hidden.html?view=videos");

    // Inject our own styling once. This avoids depending on YouTube's internal guide item data-binding,
    // which can cause cloned ytd-guide-entry-renderer items to render blank.
    const ensureStyles = () => {
        if (document.getElementById("yf-hidden-sidebar-style")) return;
        const style = document.createElement("style");
        style.id = "yf-hidden-sidebar-style";
        style.textContent = `
/* YouTube Filter: custom "Hidden" guide entry */
.yf-hidden-guide-entry {
  display: flex;
  align-items: center;
  height: 40px;
  padding: 0 16px;
  border-radius: 10px;
  text-decoration: none;
  cursor: pointer;
  color: var(--yt-spec-text-primary);
  user-select: none;
}

.yf-hidden-guide-entry:hover {
  background: rgba(255, 255, 255, 0.08);
}

html[dark] .yf-hidden-guide-entry:hover {
  background: rgba(255, 255, 255, 0.08);
}

html:not([dark]) .yf-hidden-guide-entry:hover {
  background: rgba(0, 0, 0, 0.06);
}

.yf-hidden-guide-icon {
  width: 24px;
  height: 24px;
  margin-right: 24px;
  flex: 0 0 auto;
  stroke: var(--yt-spec-icon-inactive);
  fill: none;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.yf-hidden-guide-title {
  font-size: 14px;
  line-height: 20px;
  font-weight: 400;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
        `.trim();
        (document.head || document.documentElement).appendChild(style);
    };

    const buildEntryHost = (hostClassName) => {
        const host = document.createElement("div");
        host.className = hostClassName || "style-scope ytd-guide-section-entry-renderer";
        host.setAttribute(SIDEBAR_ITEM_ATTR, "hidden");

        const a = document.createElement("a");
        a.className = "yf-hidden-guide-entry";
        a.href = hiddenUrl;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.title = "Hidden";

        // Feather "eye-off" icon (stroke-based) – resilient and CSP-safe as inline SVG.
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.classList.add("yf-hidden-guide-icon");
        const p1 = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p1.setAttribute("d", "M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.78 21.78 0 0 1 5.17-6.11");
        const p2 = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p2.setAttribute("d", "M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a21.83 21.83 0 0 1-2.99 4.33");
        const p3 = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p3.setAttribute("d", "M14.12 14.12a3 3 0 1 1-4.24-4.24");
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", "1");
        line.setAttribute("y1", "1");
        line.setAttribute("x2", "23");
        line.setAttribute("y2", "23");
        svg.appendChild(p1);
        svg.appendChild(p2);
        svg.appendChild(p3);
        svg.appendChild(line);

        const title = document.createElement("span");
        title.className = "yf-hidden-guide-title";
        title.textContent = "Hidden";

        a.appendChild(svg);
        a.appendChild(title);
        host.appendChild(a);

        const openHidden = (e) => {
            try {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation?.();
            } catch (_) {}
            window.open(hiddenUrl, "_blank", "noopener");
        };
        a.addEventListener("click", openHidden, true);
        a.addEventListener("auxclick", openHidden, true);
        a.addEventListener(
            "mousedown",
            (e) => {
                if (e.button === 0 || e.button === 1) {
                    try {
                        e.stopPropagation();
                    } catch (_) {}
                }
            },
            true
        );

        return host;
    };

    const existingAll = Array.from(document.querySelectorAll(`[${SIDEBAR_ITEM_ATTR}="hidden"]`));
    const existingGood = existingAll.find((el) => el.querySelector(".yf-hidden-guide-entry"));
    if (existingGood) return;

    ensureStyles();

    const guide = document.querySelector("ytd-guide-renderer ytd-guide-section-renderer, ytd-guide-renderer");
    if (!guide) return;

    const youSection =
        Array.from(document.querySelectorAll("ytd-guide-section-renderer")).find((s) => {
            const t = (s.querySelector("h3, #header, .title")?.textContent || "").trim().toLowerCase();
            return t === "you";
        }) ||
        (() => {
            try {
                return document.querySelector('ytd-guide-section-renderer:has(a[href*="/feed/library"])');
            } catch (_) {
                return null;
            }
        })() ||
        document.querySelector("ytd-guide-section-renderer");

    if (!youSection) return;

    const entries = Array.from(youSection.querySelectorAll("ytd-guide-entry-renderer"));
    const downloadsEntry = entries.find((e) => {
        const a = e.querySelector('a[href*="/feed/downloads"], a[href$="/feed/downloads"]');
        return !!a;
    });

    if (!downloadsEntry || !downloadsEntry.parentElement) return;

    for (const el of existingAll) {
        if (!el.querySelector(".yf-hidden-guide-entry")) {
            el.remove();
        }
    }

    const host = buildEntryHost(downloadsEntry.className);
    downloadsEntry.parentElement.insertBefore(host, downloadsEntry.nextSibling);
    log("[YF] inserted custom sidebar link: Hidden");
}

  async function updateMetaCache(id, card) {
    if (!id || !card) return;
    const m = extractMetaFromCard(card);
    const storageKey = metaStorageKey(id);
    let prev = metaCache[id];
    if (!prev) {
      try {
        const stored = await chrome.storage.local.get(storageKey);
        prev = stored[storageKey] || {};
      } catch {
        prev = {};
      }
    }
    metaCache[id] = {
      ...prev,
      ...Object.fromEntries(
        Object.entries(m).filter(([, v]) => typeof v === "string" && v.trim().length > 0)
      ),
      lastSeenAt: now()
    };
    await chrome.storage.local.set({ [storageKey]: metaCache[id] });
  }

  async function hideVideo(id, hideTarget, cardForMeta) {
    // postedAtApprox: parse from "x ago" if available
    const m = cardForMeta ? extractMetaFromCard(cardForMeta) : { postedText: "" };
    const postedAtApprox = m.postedText ? parsePostedAtApprox(m.postedText) : null;

    upsertEntry(id, {
      hiddenAt: now(),
      postedAtApprox
    });

    await saveEntries();

    // Update richer local cache for display in hidden page
    if (cardForMeta) {
      try {
        await updateMetaCache(id, cardForMeta);
      } catch (e) {
        console.warn("[YF] failed to update local meta cache", e);
      }
    }

    hideIfNeeded(hideTarget, id);
  }

  async function unhideVideo(id, hideTarget) {
    removeEntry(id);
    await saveEntries();

    // keep local meta unless you want to delete it too; I'll keep it
    hideIfNeeded(hideTarget, id);
  }

  function processAnyCard(anyCard) {
    if (!(anyCard instanceof HTMLElement)) return;

    const hideTarget = getHideTargetForAnyCard(anyCard);
    if (!(hideTarget instanceof HTMLElement)) return;

    if (hideTarget.hasAttribute(CARD_PROCESSED_ATTR)) return;

    const primaryAnchor = pickPrimaryVideoAnchor(hideTarget);
    if (!primaryAnchor) {
      hideTarget.setAttribute(CARD_PROCESSED_ATTR, "1");
      return;
    }

    const videoId = getVideoIdFromUrl(primaryAnchor.href);
    if (!videoId) {
      hideTarget.setAttribute(CARD_PROCESSED_ATTR, "1");
      return;
    }

    hideTarget.setAttribute(CARD_PROCESSED_ATTR, "1");

    // Apply hide (collapses slots so items shift)
    hideIfNeeded(hideTarget, videoId);

    // Place overlay on thumbnail-ish host, but not aria-hidden
    const overlayHost = pickOverlayHostFromCard(hideTarget);
    if (!(overlayHost instanceof HTMLElement)) return;

    if (overlayHost.querySelector?.(`[${OVERLAY_ATTR}="1"]`)) return;

    ensurePositioningContext(overlayHost);

    const overlay = createOverlayButton({
      checked: hiddenIds.has(videoId),
      onToggle: async (setCheckedUI) => {
        if (hiddenIds.has(videoId)) {
          await unhideVideo(videoId, hideTarget);
          setCheckedUI(false);
        } else {
          await hideVideo(videoId, hideTarget, hideTarget);
          setCheckedUI(true);
        }
      }
    });

    overlayHost.appendChild(overlay);

    // Update local meta cache opportunistically (even if not hidden yet)
    // This keeps titles/thumbs fresh for the Hidden page.
    updateMetaCache(videoId, hideTarget).catch(() => {});
  }

  function scanAndDecorate() {
    ensureGlobalStyle();

    // Sidebar link is cheap but not always available early
    ensureSidebarHiddenLink().catch(() => {});

    const anchors = querySelectorAllDeep(VIDEO_ANCHOR_SELECTOR, document)
      .filter((a) => a instanceof HTMLAnchorElement)
      .filter((a) => !!getVideoIdFromUrl(a.href));

    if (anchors.length !== lastAnchorCount) {
      lastAnchorCount = anchors.length;
      console.log("[YF] video anchors (deep) seen:", anchors.length);
    }

    const anyCards = new Set();
    for (const a of anchors) {
      const anyCard = closestDeep(a, ANY_CARD_SELECTORS);
      if (anyCard) anyCards.add(anyCard);
    }

    if (anyCards.size !== lastCardCount) {
      lastCardCount = anyCards.size;
      console.log("[YF] cards matched (deep):", anyCards.size);
    }

    for (const c of anyCards) processAnyCard(c);
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    setTimeout(() => {
      scanScheduled = false;
      scanAndDecorate();
    }, 50);
  }

  function setupObservers() {
    const mo = new MutationObserver(() => scheduleScan());
    mo.observe(document.documentElement, { childList: true, subtree: true });

    window.addEventListener("yt-navigate-finish", scheduleScan);
    window.addEventListener("popstate", scheduleScan);

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "sync") return;

      if (changes[SYNC_ENTRIES_KEY]) {
        const next = changes[SYNC_ENTRIES_KEY].newValue;
        hiddenEntries = Array.isArray(next) ? next : [];
        hiddenIds = new Set(hiddenEntries.map((e) => e.id).filter(Boolean));
        scheduleScan();
      }
    });
  }

  async function init() {
    await loadState();
    scanAndDecorate();
    setupObservers();
  }

  init().catch((e) => console.error("[YF] init failed", e));
})();
