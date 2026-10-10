/**
 * VTT Minimal Popup Controller
 * Built by @momalekiii (https://github.com/momalekiii/VTT)
 */
(function () {
  "use strict";

  var enableToggle = document.getElementById("enableToggle");
  var statusDot = document.getElementById("statusDot");
  var statusText = document.getElementById("statusText");
  var targetBtns = document.querySelectorAll("#targetLangGroup .seg-btn");
  var sourceBtns = document.querySelectorAll("#sourceLangGroup .seg-btn");
  var sizeBtns = document.querySelectorAll("#fontSizeGroup .seg-btn");
  var liveSpeechBtn = document.getElementById("liveSpeechBtn");
  var liveSpeechLabel = document.getElementById("liveSpeechLabel");
  var exportVttBtn = document.getElementById("exportVttBtn");
  var exportSrtBtn = document.getElementById("exportSrtBtn");

  var state = {
    enabled: true,
    targetLang: "fa",
    sourceLang: "en-US",
    fontSize: "md",
    isSpeechActive: false,
    hasVideo: false,
    cuesCount: 0,
  };

  function sendToActiveTab(message, cb) {
    if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.query) {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        var tab = tabs && tabs[0];
        if (!tab || !tab.id) {
          if (cb) cb(null);
          return;
        }
        try {
          chrome.tabs.sendMessage(tab.id, message, function (res) {
            if (chrome.runtime.lastError) {
              // Tab was open before extension loaded — inject content scripts now and retry!
              chrome.runtime.sendMessage(
                { type: "VTT_ENSURE_INJECTED", tabId: tab.id },
                function () {
                  void chrome.runtime.lastError;
                  setTimeout(function () {
                    chrome.tabs.sendMessage(tab.id, message, function (res2) {
                      void chrome.runtime.lastError;
                      if (cb) cb(res2 || null);
                    });
                  }, 250);
                }
              );
              return;
            }
            if (cb) cb(res || null);
          });
        } catch (_e) {
          if (cb) cb(null);
        }
      });
      return;
    }

    // Fallback when running inside standalone interactive preview
    if (window.parent && window.parent.VTTOnlineController) {
      var ctrl = window.parent.VTTOnlineController;
      if (message.type === "VTT_UPDATE_SETTINGS") {
        ctrl.setSettings(message);
      } else if (message.type === "VTT_TOGGLE_SPEECH") {
        var active = ctrl.toggleOnlineSpeechRecognition();
        if (cb) cb({ ok: true, isSpeechActive: active });
        return;
      } else if (message.type === "VTT_EXPORT") {
        var txt = ctrl.exportSubtitles(message.format);
        if (cb) cb({ ok: true, content: txt });
        return;
      }
      if (cb) cb({ ok: true });
    } else if (cb) {
      cb(null);
    }
  }

  function renderUI() {
    enableToggle.checked = state.enabled;
    statusDot.classList.toggle("off", !state.enabled);

    if (!state.enabled) {
      statusText.textContent = "Subtitles Paused";
    } else if (state.hasVideo) {
      statusText.textContent =
        state.cuesCount > 0
          ? "Active · " + state.cuesCount + " cues captured"
          : "Active on playing video";
    } else {
      statusText.textContent = "Online · Persian & English";
    }

    targetBtns.forEach(function (btn) {
      btn.classList.toggle(
        "active",
        btn.getAttribute("data-target") === state.targetLang
      );
    });

    sourceBtns.forEach(function (btn) {
      btn.classList.toggle(
        "active",
        btn.getAttribute("data-source") === state.sourceLang
      );
    });

    sizeBtns.forEach(function (btn) {
      btn.classList.toggle(
        "active",
        btn.getAttribute("data-size") === state.fontSize
      );
    });

    liveSpeechBtn.classList.toggle("live-active", state.isSpeechActive);
    liveSpeechLabel.textContent = state.isSpeechActive
      ? "Listening..."
      : "Live Audio";
  }

  function pushSettings() {
    renderUI();
    if (
      typeof chrome !== "undefined" &&
      chrome.storage &&
      chrome.storage.local
    ) {
      chrome.storage.local.set({
        enabled: state.enabled,
        targetLang: state.targetLang,
        sourceLang: state.sourceLang,
        fontSize: state.fontSize,
      });
    }
    sendToActiveTab({
      type: "VTT_UPDATE_SETTINGS",
      enabled: state.enabled,
      targetLang: state.targetLang,
      sourceLang: state.sourceLang,
      fontSize: state.fontSize,
    });
  }

  enableToggle.addEventListener("change", function () {
    state.enabled = enableToggle.checked;
    pushSettings();
  });

  targetBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      state.targetLang = btn.getAttribute("data-target");
      state.enabled = true;
      pushSettings();
    });
  });

  sourceBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      state.sourceLang = btn.getAttribute("data-source");
      pushSettings();
    });
  });

  sizeBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      state.fontSize = btn.getAttribute("data-size");
      pushSettings();
    });
  });

  liveSpeechBtn.addEventListener("click", function () {
    sendToActiveTab({ type: "VTT_TOGGLE_SPEECH" }, function (res) {
      if (res && typeof res.isSpeechActive === "boolean") {
        state.isSpeechActive = res.isSpeechActive;
      } else {
        state.isSpeechActive = !state.isSpeechActive;
      }
      renderUI();
    });
  });

  function downloadExport(fmt) {
    sendToActiveTab({ type: "VTT_EXPORT", format: fmt }, function (res) {
      var content =
        res && res.content
          ? res.content
          : fmt === "srt"
          ? "1\n00:00:00,000 --> 00:00:04,000\nزیرنویس آنلاین توسط افزونه VTT (@momalekiii)\n"
          : "WEBVTT\nNOTE Generated by VTT (@momalekiii)\n\n00:00:00.000 --> 00:00:04.000\nزیرنویس آنلاین توسط افزونه VTT (@momalekiii)\n";

      var blob = new Blob([content], { type: "text/plain;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "subtitles." + state.targetLang + "." + fmt;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 1000);
      statusText.textContent = "Downloaded ." + fmt.toUpperCase();
    });
  }

  exportVttBtn.addEventListener("click", function () {
    downloadExport("vtt");
  });

  exportSrtBtn.addEventListener("click", function () {
    downloadExport("srt");
  });

  // Initialize from storage + active tab
  if (
    typeof chrome !== "undefined" &&
    chrome.storage &&
    chrome.storage.local
  ) {
    chrome.storage.local.get(null, function (saved) {
      if (saved) {
        if (typeof saved.enabled === "boolean") state.enabled = saved.enabled;
        if (saved.targetLang) state.targetLang = saved.targetLang;
        if (saved.sourceLang) state.sourceLang = saved.sourceLang;
        if (saved.fontSize) state.fontSize = saved.fontSize;
      }
      renderUI();
    });

    chrome.storage.onChanged.addListener(function (changes) {
      if (changes.enabled) state.enabled = Boolean(changes.enabled.newValue);
      if (changes.targetLang && changes.targetLang.newValue) {
        state.targetLang = changes.targetLang.newValue;
      }
      if (changes.sourceLang && changes.sourceLang.newValue) {
        state.sourceLang = changes.sourceLang.newValue;
      }
      if (changes.fontSize && changes.fontSize.newValue) {
        state.fontSize = changes.fontSize.newValue;
      }
      renderUI();
    });
  }

  sendToActiveTab({ type: "VTT_GET_STATUS" }, function (res) {
    if (res) {
      if (typeof res.enabled === "boolean") state.enabled = res.enabled;
      if (res.targetLang) state.targetLang = res.targetLang;
      if (res.sourceLang) state.sourceLang = res.sourceLang;
      if (res.fontSize) state.fontSize = res.fontSize;
      state.isSpeechActive = Boolean(res.isSpeechActive);
      state.hasVideo = Boolean(res.hasVideo);
      state.cuesCount = Number(res.cuesCount) || 0;
      renderUI();
    }
  });
})();
