/**
 * VTT Online Video Subtitles — Background Service Worker (Manifest V3)
 * Built by @momalekiii (https://github.com/momalekiii/VTT)
 */

const DEFAULT_STATE = {
  enabled: true,
  targetLang: "fa", // "fa" (Persian) | "en" (English) | "both" (FA + EN)
  sourceLang: "en-US", // "en-US" | "fa-IR"
  fontSize: "md", // "sm" | "md" | "lg"
};

const translationCache = new Map();
const inflightRequests = new Map();

async function injectIntoTab(tabId) {
  if (!tabId || !chrome.scripting) return;
  try {
    await chrome.scripting.insertCSS({
      target: { tabId, allFrames: true },
      files: ["content.css"],
    });
  } catch (_e) {}

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["yt-bridge.js"],
      world: "MAIN",
    });
  } catch (_e) {}

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content.js"],
    });
  } catch (_e) {}
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(null, (stored) => {
    chrome.storage.local.set(Object.assign({}, DEFAULT_STATE, stored || {}));
  });

  // Automatically inject into all already-open web tabs (including YouTube)
  if (chrome.tabs && chrome.tabs.query) {
    chrome.tabs.query({ url: ["http://*/*", "https://*/*"] }, (tabs) => {
      for (const tab of tabs || []) {
        if (tab.id) {
          injectIntoTab(tab.id);
        }
      }
    });
  }
});

function isPersianScript(text) {
  if (!text) return false;
  const persianChars = (String(text).match(/[\u0600-\u06FF]/g) || []).length;
  const latinChars = (String(text).match(/[A-Za-z]/g) || []).length;
  return persianChars > latinChars && persianChars > 0;
}

function normalizePersian(text) {
  if (!text) return "";
  return String(text)
    .replace(/[\u064A\u0649]/g, "\u06CC") // Arabic Yeh -> Persian Yeh (ی)
    .replace(/\u0643/g, "\u06A9") // Arabic Kaf -> Persian Kaf (ک)
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchWithTimeout(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

/**
 * Multi-provider online translation (GTX -> Clients5 -> MyMemory fallback)
 */
async function translateOnline(text, targetLang) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";

  if (targetLang === "fa" && isPersianScript(clean)) {
    return normalizePersian(clean);
  }

  const cacheKey = `${targetLang}::${clean}`;
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }

  if (inflightRequests.has(cacheKey)) {
    return inflightRequests.get(cacheKey);
  }

  const promise = (async () => {
    let translated = "";

    // Provider 1: Google GTX
    try {
      const url1 =
        "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=" +
        encodeURIComponent(targetLang) +
        "&dt=t&q=" +
        encodeURIComponent(clean);
      const res1 = await fetchWithTimeout(url1, 3800);
      if (res1.ok) {
        const data1 = await res1.json();
        if (Array.isArray(data1) && Array.isArray(data1[0])) {
          translated = data1[0]
            .map((part) => (Array.isArray(part) ? part[0] : ""))
            .join("")
            .trim();
        }
      }
    } catch (_e1) {}

    // Provider 2: Google Dict Chrome Extension Endpoint
    if (!translated) {
      try {
        const url2 =
          "https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=" +
          encodeURIComponent(targetLang) +
          "&q=" +
          encodeURIComponent(clean);
        const res2 = await fetchWithTimeout(url2, 3800);
        if (res2.ok) {
          const data2 = await res2.json();
          if (Array.isArray(data2)) {
            if (typeof data2[0] === "string") {
              translated = data2[0].trim();
            } else if (
              Array.isArray(data2[0]) &&
              typeof data2[0][0] === "string"
            ) {
              translated = data2[0][0].trim();
            }
          } else if (data2 && Array.isArray(data2.sentences)) {
            translated = data2.sentences
              .map((s) => s.trans || "")
              .join("")
              .trim();
          }
        }
      } catch (_e2) {}
    }

    // Provider 3: MyMemory API Fallback
    if (!translated) {
      try {
        const srcGuess = isPersianScript(clean) ? "fa" : "en";
        if (srcGuess !== targetLang) {
          const url3 =
            "https://api.mymemory.translated.net/get?q=" +
            encodeURIComponent(clean) +
            "&langpair=" +
            encodeURIComponent(`${srcGuess}|${targetLang}`);
          const res3 = await fetchWithTimeout(url3, 4000);
          if (res3.ok) {
            const data3 = await res3.json();
            if (
              data3 &&
              data3.responseData &&
              data3.responseData.translatedText
            ) {
              translated = String(data3.responseData.translatedText).trim();
            }
          }
        }
      } catch (_e3) {}
    }

    let finalOut = translated || clean;
    if (targetLang === "fa") {
      finalOut = normalizePersian(finalOut);
    }

    if (translationCache.size > 1000) {
      const firstKey = translationCache.keys().next().value;
      translationCache.delete(firstKey);
    }
    translationCache.set(cacheKey, finalOut);
    return finalOut;
  })();

  inflightRequests.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    inflightRequests.delete(cacheKey);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === "VTT_ENSURE_INJECTED") {
    const tabId = msg.tabId || (sender && sender.tab && sender.tab.id);
    if (tabId) {
      injectIntoTab(tabId).then(() => sendResponse({ ok: true }));
      return true;
    }
    sendResponse({ ok: false });
    return false;
  }

  if (msg.type === "VTT_TRANSLATE") {
    const text = msg.text || "";
    const target = msg.targetLang || "fa";

    if (target === "both") {
      Promise.all([
        translateOnline(text, "fa"),
        translateOnline(text, "en"),
      ])
        .then(([faText, enText]) => {
          sendResponse({ ok: true, fa: faText, en: enText });
        })
        .catch(() => {
          sendResponse({ ok: true, fa: text, en: text });
        });
      return true;
    }

    translateOnline(text, target)
      .then((translated) => {
        sendResponse({
          ok: true,
          text: translated,
          original: text,
        });
      })
      .catch(() => {
        sendResponse({ ok: true, text: text, original: text });
      });
    return true;
  }

  return false;
});
