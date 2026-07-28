importScripts("shared.js");

// Brauo service worker: talks to the TTS service so content scripts never hit CORS.

async function getConfig() {
  return brauoNormalizeConfig(await chrome.storage.sync.get(null), await chrome.storage.local.get({ cloudApiKey: "", cloudBaseUrl: "" }));
}

function brauoError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Default for account/catalog: fail fast on a hung connection.
// Speak is longer: free-tier Kokoro on CPU needs ~25s for ~900 chars and ~50s
// near the 2000-char limit; 15s aborted legitimate synthesis as "network" errors.
const BRAUO_FETCH_TIMEOUT_MS = 15000;
const BRAUO_SPEAK_TIMEOUT_MS = 90000;

async function fetchWithTimeout(url, init, ms = BRAUO_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url, init, attempts = 3, timeoutMs = BRAUO_FETCH_TIMEOUT_MS) {
  let lastResponse;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let retryResponse;
    try {
      const response = await fetchWithTimeout(url, init, timeoutMs);
      lastResponse = response;
      if (response.status !== 429 && response.status < 500) return response;
      retryResponse = response;
    } catch (_) {
      // Network failures are retried below.
    }

    if (attempt < attempts - 1) {
      const retryAfter = retryResponse && retryResponse.headers.get("Retry-After");
      const retryAfterSeconds = retryAfter === null ? NaN : Number(retryAfter);
      const delay = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
        ? Math.min(retryAfterSeconds, 10) * 1000
        : 700 * (2 ** attempt) + Math.random() * 300;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  if (lastResponse) return lastResponse;
  throw brauoError("network", "Could not reach the voice service. Check your connection.");
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
  }
  return btoa(bin);
}

const BRAUO_CLOUD_ERROR_MESSAGES = {
  invalid_key: "Your Brauo Cloud API key was rejected. Check it in Options.",
  quota_exceeded: "You have reached your Brauo Cloud usage limit.",
  voice_not_found: "That voice is not available. Pick another voice in Options.",
  text_too_long: "This block is too long to synthesize."
};

const BrauoCloudProvider = {
  async speak(text, voice, cfg) {
    if (!cfg.cloud.apiKey) {
      throw brauoError("NO_KEY", "Set your Brauo Cloud API key in Options");
    }
    const baseUrl = cfg.cloud.baseUrl.replace(/\/$/, "");
    const res = await fetchWithRetry(`${baseUrl}/v1/speak`, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + cfg.cloud.apiKey,
        "Content-Type": "application/json",
        [BRAUO_CLIENT_HEADER]: BRAUO_CLIENT_NAME
      },
      body: JSON.stringify({ text, voice, format: "mp3", cache: true })
    }, 3, BRAUO_SPEAK_TIMEOUT_MS);
    if (!res.ok) throw await BrauoCloudProvider.responseError(res);
    const contentType = res.headers.get("Content-Type") || "";
    const cache = res.headers.get("X-Brauo-Cache");
    const result = {
      b64: toBase64(await res.arrayBuffer()),
      mime: contentType.startsWith("audio/") ? contentType : "audio/mp3"
    };
    if (cache) result.cache = cache;
    return result;
  },

  async listVoices(cfg) {
    const baseUrl = cfg.cloud.baseUrl.replace(/\/$/, "");
    const res = await fetchWithRetry(`${baseUrl}/v1/voices`);
    if (!res.ok) throw await BrauoCloudProvider.responseError(res);
    const data = await res.json();
    return (data.voices || []).map((v) => ({
      model: v.id,
      name: v.display_name || v.id,
      lang: v.language || "?",
      tier: v.tier || "pro",
      badge: v.badge || ""
    }));
  },

  async responseError(res) {
    const data = await res.json().catch(() => null);
    const envelope = data && data.error;
    const code = (envelope && envelope.code) || `http_${res.status}`;
    const message = BRAUO_CLOUD_ERROR_MESSAGES[code]
      || (res.status === 429 && "The voice service is busy. Try again in a moment.")
      || (res.status >= 500 && "The voice service had a temporary problem. Try again.")
      || (envelope && envelope.message)
      || `Request failed (${res.status}).`;
    return brauoError(
      code,
      message
    );
  }
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type === "tts") {
    getConfig()
      .then(async (cfg) => {
        const requestCfg = {
          ...cfg,
          cloud: {
            ...cfg.cloud,
            ...(msg.key !== undefined ? { apiKey: msg.key } : {}),
            ...(msg.baseUrl !== undefined ? { baseUrl: msg.baseUrl } : {})
          }
        };
        // msg.model: sent by pre-0.2.0 content scripts that stay injected in open tabs across an update.
        const voice = msg.voice || msg.model || cfg.cloud.voice;
        const { b64, mime, cache } = await BrauoCloudProvider.speak(msg.text, voice, requestCfg);
        return { ok: true, b64, mime, cache };
      })
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, code: e.code || "error", error: e.message }));
    return true;
  }
  if (msg.type === "catalog") {
    getConfig()
      .then(async (cfg) => {
        const requestCfg = {
          ...cfg,
          cloud: {
            ...cfg.cloud,
            ...(msg.key !== undefined ? { apiKey: msg.key } : {}),
            ...(msg.baseUrl !== undefined ? { baseUrl: msg.baseUrl } : {})
          }
        };
        const voices = await BrauoCloudProvider.listVoices(requestCfg);
        const fetchedAt = new Date().toISOString();
        await chrome.storage.local.set({ cloudCatalog: voices, cloudCatalogFetchedAt: fetchedAt });
        return { ok: true, voices };
      })
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, code: e.code || "error", error: e.message }));
    return true;
  }
  if (msg.type === "openOptions") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }
});

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (sender.origin !== "https://brauo.com") {
    sendResponse({ ok: false });
    return false;
  }
  if (!msg || msg.type !== "brauo-connect") {
    sendResponse({ ok: false });
    return false;
  }

  const { apiKey, plan } = msg;
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    sendResponse({ ok: false, error: "invalid_key" });
    return false;
  }

  const normalizedPlan = String(plan || "").toLowerCase();
  (async () => {
    await chrome.storage.local.set({
      cloudApiKey: apiKey,
      ...(normalizedPlan ? { cloudPlan: normalizedPlan } : {})
    });
    sendResponse({ ok: true });
  })().catch(() => sendResponse({ ok: false }));
  return true;
});


// First install: open the welcome tour (a listenable "what is Brauo" article the
// user can immediately try the reader on). Updates and reloads do not open it.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: "https://brauo.com/welcome?src=ext" });
  }
});
