const ready = document.getElementById("ready");
const setup = document.getElementById("setup");
const status = document.getElementById("status");

// Keep the cached voice catalog fresh so new voices appear without the user
// having to press "Load voices" in Options. The popup runs on every toolbar
// click, so a light TTL check here is enough. /v1/voices is public (no key).
const CATALOG_TTL_MS = 60 * 60 * 1000;

async function refreshCatalogIfStale() {
  try {
    const { cloudCatalog, cloudCatalogFetchedAt } = await chrome.storage.local.get({
      cloudCatalog: null,
      cloudCatalogFetchedAt: null
    });
    // The background worker stores cloudCatalogFetchedAt as an ISO string.
    const fetchedMs = cloudCatalogFetchedAt ? Date.parse(cloudCatalogFetchedAt) : NaN;
    const fresh =
      cloudCatalog &&
      cloudCatalog.length &&
      Number.isFinite(fetchedMs) &&
      Date.now() - fetchedMs < CATALOG_TTL_MS;
    if (fresh) return;
    await chrome.runtime.sendMessage({ type: "catalog" });
  } catch (_) {
    // Best effort: the picker still falls back to the cached or bundled list.
  }
}

function showSetup(message = "") {
  ready.style.display = "none";
  setup.style.display = "block";
  document.getElementById("plan").textContent = "";
  document.getElementById("upgrade").style.display = "none";
  status.textContent = message;
}

async function loadAccount() {
  status.textContent = "";
  const local = await chrome.storage.local.get({ cloudApiKey: "", cloudBaseUrl: "" });
  const key = local.cloudApiKey;

  if (!key) {
    showSetup();
    return;
  }

  const base = (local.cloudBaseUrl || BRAUO_CLOUD_API).replace(/\/$/, "");
  try {
    const response = await fetch(base + "/v1/account", {
      headers: {
        Authorization: "Bearer " + key,
        [BRAUO_CLIENT_HEADER]: BRAUO_CLIENT_NAME
      }
    });

    if (response.status === 401) {
      showSetup("Your API key was rejected. Paste a new one.");
      return;
    }
    if (!response.ok) {
      showSetup("Could not reach Brauo. Check your connection.");
      return;
    }

    const { plan, credits } = await response.json();
    const normalizedPlan = String(plan || "").toLowerCase();
    await chrome.storage.local.set({ cloudPlan: normalizedPlan });
    document.getElementById("upgrade").style.display = normalizedPlan === "free" ? "block" : "none";
    ready.style.display = "block";
    setup.style.display = "none";
    document.getElementById("plan").textContent = normalizedPlan
      ? normalizedPlan.charAt(0).toUpperCase() + normalizedPlan.slice(1)
      : "";
    document.getElementById("credits").textContent = `${Math.round(credits)} credits left${normalizedPlan === "free" ? " · Free ~20/day" : ""}`;
  } catch (_) {
    showSetup("Could not reach Brauo. Check your connection.");
  }
}

document.getElementById("create").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://brauo.com" });
});

document.getElementById("signin").addEventListener("click", () => {
  // Pass our own extension id so the connect page sends the key back to this
  // exact extension (published and unpacked ids differ).
  const url = "https://brauo.com/account/connect?ext=" +
    encodeURIComponent(chrome.runtime.id);
  chrome.tabs.create({ url });
});

document.getElementById("save").addEventListener("click", async () => {
  const key = document.getElementById("key").value.trim();
  if (!key) {
    status.textContent = "Paste your API key.";
    return;
  }
  await chrome.storage.local.set({ cloudApiKey: key });
  await loadAccount();
});

document.getElementById("account").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://brauo.com/account" });
});

document.getElementById("options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById("read").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "brauo-activate" });
  } catch (_) {
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["shared.js", "voices.js", "content.js"] });
      await chrome.tabs.sendMessage(tab.id, { type: "brauo-activate" });
    } catch (e) {
      document.getElementById("status").textContent = "This page can't be read.";
      return;
    }
  }
  window.close();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && String(changes.cloudApiKey?.newValue || "").trim()) {
    loadAccount();
  }
});

loadAccount();
refreshCatalogIfStale();
