chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  try {
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "YF_OPEN_HIDDEN_PAGE") {
      const route = typeof msg.route === "string" ? msg.route : "";
      const sort = typeof msg.sort === "string" ? msg.sort : "hidden_desc";

      const url = chrome.runtime.getURL(`hidden.html#${route}?sort=${encodeURIComponent(sort)}`);

      chrome.tabs.create({ url }).then(() => {
        sendResponse({ ok: true });
      }).catch((err) => {
        sendResponse({ ok: false, error: String(err) });
      });

      return true; // async response
    }
  } catch (e) {
    sendResponse({ ok: false, error: String(e) });
  }
});
