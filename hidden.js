// Hidden page logic
const SYNC_ENTRIES_KEY = "hiddenVideos";
const LOCAL_META_KEY = "hiddenVideoMeta";

const $list = document.getElementById("list");
const $empty = document.getElementById("empty");
const $sort = document.getElementById("sort");
const $clear = document.getElementById("clearAll");

function byId(arr) {
  const m = new Map();
  for (const x of arr) m.set(x.id, x);
  return m;
}

function formatDateTime(ms) {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "";
  }
}

function safeNum(x) {
  return Number.isFinite(x) ? x : null;
}

function sortEntries(entries, mode) {
  const copy = [...entries];

  const cmp = (a, b) => {
    const ha = safeNum(a.hiddenAt) ?? 0;
    const hb = safeNum(b.hiddenAt) ?? 0;
    const pa = safeNum(a.postedAtApprox);
    const pb = safeNum(b.postedAtApprox);

    switch (mode) {
      case "hidden_asc":
        return ha - hb;
      case "hidden_desc":
        return hb - ha;
      case "posted_asc": {
        // nulls last
        if (pa === null && pb === null) return hb - ha; // fallback hidden desc
        if (pa === null) return 1;
        if (pb === null) return -1;
        return pa - pb;
      }
      case "posted_desc": {
        if (pa === null && pb === null) return hb - ha;
        if (pa === null) return 1;
        if (pb === null) return -1;
        return pb - pa;
      }
      default:
        return hb - ha;
    }
  };

  copy.sort(cmp);
  return copy;
}

async function load() {
  const [{ [SYNC_ENTRIES_KEY]: entriesRaw }, { [LOCAL_META_KEY]: meta }] =
    await Promise.all([
      chrome.storage.sync.get({ [SYNC_ENTRIES_KEY]: [] }),
      chrome.storage.local.get({ [LOCAL_META_KEY]: {} })
    ]);

  const entries = Array.isArray(entriesRaw) ? entriesRaw : [];
  const metaCache = meta || {};

  render(entries, metaCache);
}

function render(entries, metaCache) {
  $list.innerHTML = "";

  if (!entries || entries.length === 0) {
    if ($empty) $empty.hidden = false;
    return;
  }
  if ($empty) $empty.hidden = true;

  const sorted = sortEntries(entries, $sort.value);

  for (const e of sorted) {
    const id = e.id;
    const m = metaCache[id] || {};

    const title = (m.title || "").trim() || `Video ${id}`;
    const channel = (m.channel || "").trim();
    const postedText = (m.postedText || "").trim();

    const hiddenAt = safeNum(e.hiddenAt);
    const postedAtApprox = safeNum(e.postedAtApprox);

    const thumb =
      (m.thumb || "").trim() ||
      `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;

    const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;

    const card = document.createElement("div");
    card.className = "card";

    const aThumb = document.createElement("a");
    aThumb.className = "thumb";
    aThumb.href = watchUrl;
    aThumb.target = "_blank";
    aThumb.rel = "noopener noreferrer";

    const img = document.createElement("img");
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.src = thumb;
    img.alt = title;

    aThumb.appendChild(img);

    const body = document.createElement("div");
    body.className = "body";

    const row1 = document.createElement("div");
    row1.className = "row";

    const titleLink = document.createElement("a");
    titleLink.className = "link";
    titleLink.href = watchUrl;
    titleLink.target = "_blank";
    titleLink.rel = "noopener noreferrer";
    titleLink.textContent = title;

    const actions = document.createElement("div");
    actions.className = "actions";

    const unhideBtn = document.createElement("button");
    unhideBtn.className = "btn";
    unhideBtn.textContent = "Unhide";
    unhideBtn.addEventListener("click", async () => {
      await unhide(id);
    });

    actions.appendChild(unhideBtn);

    row1.appendChild(titleLink);
    row1.appendChild(actions);

    const row2 = document.createElement("div");
    row2.className = "meta";
    row2.textContent = channel ? `Channel: ${channel}` : "Channel: (unknown)";

    const row3 = document.createElement("div");
    row3.className = "meta";

    const parts = [];

    if (hiddenAt) parts.push(`Hidden: ${formatDateTime(hiddenAt)}`);

    if (postedAtApprox) parts.push(`Posted (approx): ${formatDateTime(postedAtApprox)}`);
    else if (postedText) parts.push(`Posted: ${postedText}`);
    else parts.push(`Posted: (unknown)`);

    row3.textContent = parts.join(" • ");

    body.appendChild(row1);
    body.appendChild(row2);
    body.appendChild(row3);

    card.appendChild(aThumb);
    card.appendChild(body);

    $list.appendChild(card);
  }
}

async function unhide(id) {
  const { [SYNC_ENTRIES_KEY]: entriesRaw } = await chrome.storage.sync.get({
    [SYNC_ENTRIES_KEY]: []
  });

  const entries = Array.isArray(entriesRaw) ? entriesRaw : [];
  const next = entries.filter((e) => e && e.id !== id);

  await chrome.storage.sync.set({ [SYNC_ENTRIES_KEY]: next });
  await load();
}

$sort?.addEventListener("change", load);
$clear?.addEventListener("click", async () => {
  await chrome.storage.sync.set({ [SYNC_ENTRIES_KEY]: [] });
  await load();
});

load().catch((e) => {
  console.error("Hidden page failed to load", e);
});
