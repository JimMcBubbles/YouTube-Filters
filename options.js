(() => {
  "use strict";

  const STORAGE_KEY = "hiddenVideoIds";

  const elIds = document.getElementById("ids");
  const elStatus = document.getElementById("status");
  const btnReload = document.getElementById("reload");
  const btnSave = document.getElementById("save");
  const btnClear = document.getElementById("clear");

  function setStatus(msg) {
    elStatus.textContent = msg;
    if (!msg) return;
    setTimeout(() => (elStatus.textContent = ""), 1500);
  }

  async function load() {
    const result = await chrome.storage.sync.get({ [STORAGE_KEY]: [] });
    const ids = Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
    elIds.value = ids.join("\n");
    setStatus(`Loaded ${ids.length}`);
  }

  async function save() {
    const lines = elIds.value
      .split("\n")
      .map(s => s.trim())
      .filter(Boolean);

    // De-dupe
    const uniq = Array.from(new Set(lines));
    await chrome.storage.sync.set({ [STORAGE_KEY]: uniq });
    elIds.value = uniq.join("\n");
    setStatus(`Saved ${uniq.length}`);
  }

  async function clearAll() {
    await chrome.storage.sync.set({ [STORAGE_KEY]: [] });
    elIds.value = "";
    setStatus("Cleared");
  }

  btnReload.addEventListener("click", () => load().catch(console.error));
  btnSave.addEventListener("click", () => save().catch(console.error));
  btnClear.addEventListener("click", () => clearAll().catch(console.error));

  load().catch(console.error);
})();
