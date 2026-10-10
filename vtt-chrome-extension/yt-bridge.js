/**
 * VTT — YouTube MAIN World Bridge
 * Runs in page context ("world": "MAIN") to access YouTube's internal
 * #movie_player API, ytInitialPlayerResponse captionTracks, and timedtext network responses.
 * Merges rapid word-by-word ASR fragments into calm, readable 3.5s–5.5s sentence cues.
 * Built by @momalekiii (https://github.com/momalekiii/VTT)
 */
(function () {
  "use strict";

  if (window.__VTT_YT_BRIDGE_ACTIVE__) return;
  window.__VTT_YT_BRIDGE_ACTIVE__ = true;

  var lastVideoId = "";
  var extractedTracksForVideo = "";

  function postToContentScript(type, payload) {
    try {
      window.postMessage(
        {
          source: "VTT_YT_BRIDGE",
          type: type,
          payload: payload,
        },
        "*"
      );
    } catch (_e) {}
  }

  /**
   * Merge fragmented or word-by-word cues into comfortable, readable sentence blocks
   * (~3.5s to 5.8s duration, ~8 to 15 words per subtitle cue).
   */
  function mergeIntoReadableCues(rawCues) {
    if (!Array.isArray(rawCues) || rawCues.length === 0) return [];

    // Step 1: Clean and deduplicate overlapping rolling lines
    var cleaned = [];
    for (var i = 0; i < rawCues.length; i++) {
      var item = rawCues[i];
      if (!item || !item.text) continue;
      var txt = item.text.replace(/\s+/g, " ").trim();
      if (!txt) continue;

      var prev = cleaned[cleaned.length - 1];
      if (prev) {
        if (prev.text === txt) {
          prev.end = Math.max(prev.end, item.end);
          continue;
        }
        // If new cue is just a rolling extension of previous cue
        if (txt.indexOf(prev.text) === 0 && item.start - prev.start < 4.0) {
          prev.text = txt;
          prev.end = Math.max(prev.end, item.end);
          continue;
        }
      }
      cleaned.push({
        start: Number(item.start) || 0,
        end: Number(item.end) || (Number(item.start) || 0) + 3.0,
        text: txt,
      });
    }

    if (cleaned.length === 0) return [];

    // Step 2: Group short fragments into 3.5s–5.5s readable chunks (max ~14 words / ~85 chars)
    var merged = [];
    var current = null;

    for (var j = 0; j < cleaned.length; j++) {
      var c = cleaned[j];
      if (!current) {
        current = {
          start: c.start,
          end: c.end,
          text: c.text,
        };
        continue;
      }

      var combinedText = current.text + " " + c.text;
      var wordCount = combinedText.split(/\s+/).length;
      var spanDuration = Math.max(c.end, current.end) - current.start;
      var gap = c.start - current.end;
      var endsWithSentencePunct = /[.!?؟।]\s*$/.test(current.text);
      var currentDuration = current.end - current.start;

      var shouldSplit =
        gap > 1.2 ||
        wordCount > 14 ||
        combinedText.length > 88 ||
        spanDuration > 5.8 ||
        (endsWithSentencePunct && currentDuration >= 2.6) ||
        currentDuration >= 4.2;

      if (shouldSplit) {
        // Ensure minimum readable duration of 2.8s if there is room before next cue
        var minEnd = Math.min(c.start, current.start + 2.8);
        current.end = Number(Math.max(current.end, minEnd).toFixed(2));
        merged.push(current);
        current = {
          start: c.start,
          end: c.end,
          text: c.text,
        };
      } else {
        current.text = combinedText;
        current.end = Math.max(current.end, c.end);
      }
    }

    if (current) {
      current.end = Number(
        Math.max(current.end, current.start + 3.0).toFixed(2)
      );
      merged.push(current);
    }

    // Step 3: Fix any overlapping timestamps between consecutive merged cues
    for (var k = 0; k < merged.length - 1; k++) {
      if (merged[k].end > merged[k + 1].start) {
        merged[k].end = Number(merged[k + 1].start.toFixed(2));
      }
    }

    return merged;
  }

  /**
   * Parse YouTube JSON3 timedtext format into readable sentence cues
   */
  function parseJson3Events(data) {
    if (!data || !Array.isArray(data.events)) return [];
    var rawCues = [];
    for (var i = 0; i < data.events.length; i++) {
      var ev = data.events[i];
      if (!ev || !Array.isArray(ev.segs)) continue;
      var text = ev.segs
        .map(function (s) {
          return s && s.utf8 ? s.utf8 : "";
        })
        .join("")
        .replace(/\n+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) continue;
      var startSec = (Number(ev.tStartMs) || 0) / 1000;
      var durSec = (Number(ev.dDurationMs) || 3000) / 1000;
      rawCues.push({
        start: Number(startSec.toFixed(2)),
        end: Number((startSec + Math.max(0.5, Math.min(durSec, 6.0))).toFixed(2)),
        text: text,
      });
    }
    return mergeIntoReadableCues(rawCues);
  }

  /**
   * Parse YouTube XML / SRV1 / SRV3 timedtext format into readable sentence cues
   */
  function parseXmlTimedText(xmlText) {
    if (!xmlText || typeof xmlText !== "string") return [];
    try {
      var parser = new DOMParser();
      var doc = parser.parseFromString(xmlText, "text/xml");
      var nodes = doc.querySelectorAll("text, p");
      var rawCues = [];
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        var raw = (node.textContent || "").replace(/\s+/g, " ").trim();
        if (!raw) continue;
        var start = 0;
        var dur = 3.0;
        if (node.hasAttribute("start")) {
          start = parseFloat(node.getAttribute("start")) || 0;
          dur = parseFloat(node.getAttribute("dur")) || 3.0;
        } else if (node.hasAttribute("t")) {
          start = (parseFloat(node.getAttribute("t")) || 0) / 1000;
          dur = (parseFloat(node.getAttribute("d")) || 3000) / 1000;
        }
        rawCues.push({
          start: Number(start.toFixed(2)),
          end: Number((start + Math.max(0.5, Math.min(dur, 6.0))).toFixed(2)),
          text: raw,
        });
      }
      return mergeIntoReadableCues(rawCues);
    } catch (_e) {
      return [];
    }
  }

  function handleTimedTextResponse(rawBody) {
    if (!rawBody || typeof rawBody !== "string") return;
    var trimmed = rawBody.trim();
    var cues = [];
    if (trimmed.startsWith("{")) {
      try {
        cues = parseJson3Events(JSON.parse(trimmed));
      } catch (_e) {}
    } else if (trimmed.startsWith("<")) {
      cues = parseXmlTimedText(trimmed);
    }
    if (cues.length > 0) {
      postToContentScript("YT_CUES_LOADED", { cues: cues });
    }
  }

  // 1. Intercept fetch() calls to /api/timedtext
  var origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function () {
      var args = arguments;
      var url =
        typeof args[0] === "string"
          ? args[0]
          : args[0] && args[0].url
          ? args[0].url
          : "";
      var p = origFetch.apply(this, args);
      if (url && url.indexOf("/api/timedtext") !== -1) {
        p.then(function (res) {
          try {
            res
              .clone()
              .text()
              .then(function (txt) {
                handleTimedTextResponse(txt);
              })
              .catch(function () {});
          } catch (_e) {}
        }).catch(function () {});
      }
      return p;
    };
  }

  // 2. Intercept XMLHttpRequest calls to /api/timedtext
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__vttUrl = typeof url === "string" ? url : "";
    return origOpen.apply(this, arguments);
  };

  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    if (this.__vttUrl && this.__vttUrl.indexOf("/api/timedtext") !== -1) {
      this.addEventListener("load", function () {
        try {
          if (typeof this.responseText === "string" && this.responseText) {
            handleTimedTextResponse(this.responseText);
          }
        } catch (_e) {}
      });
    }
    return origSend.apply(this, arguments);
  };

  // 3. Proactively activate YouTube's caption module & fetch captionTracks from #movie_player
  function inspectYouTubePlayer() {
    if (!/youtube\.com|youtu\.be/i.test(location.hostname)) return;

    var player = document.getElementById("movie_player");
    if (!player) return;

    if (
      player.classList &&
      (player.classList.contains("ad-showing") ||
        player.classList.contains("ad-interrupting"))
    ) {
      return;
    }

    var playerResponse = null;
    try {
      if (typeof player.getPlayerResponse === "function") {
        playerResponse = player.getPlayerResponse();
      }
    } catch (_e) {}

    if (!playerResponse && window.ytInitialPlayerResponse) {
      playerResponse = window.ytInitialPlayerResponse;
    }

    var videoId =
      (playerResponse &&
        playerResponse.videoDetails &&
        playerResponse.videoDetails.videoId) ||
      new URLSearchParams(location.search).get("v") ||
      "";

    if (videoId && videoId !== lastVideoId) {
      lastVideoId = videoId;
      extractedTracksForVideo = "";
      postToContentScript("YT_VIDEO_CHANGED", { videoId: videoId });
    }

    try {
      if (typeof player.loadModule === "function") {
        player.loadModule("captions");
      }
      var ccBtn = document.querySelector(".ytp-subtitles-button");
      if (ccBtn && ccBtn.getAttribute("aria-pressed") === "false") {
        ccBtn.click();
      }
    } catch (_e) {}

    if (videoId && extractedTracksForVideo !== videoId && playerResponse) {
      var tracklist =
        playerResponse.captions &&
        playerResponse.captions.playerCaptionsTracklistRenderer &&
        playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks;

      if (Array.isArray(tracklist) && tracklist.length > 0) {
        extractedTracksForVideo = videoId;
        var chosen =
          tracklist.find(function (t) {
            return /^fa/i.test(t.languageCode);
          }) ||
          tracklist.find(function (t) {
            return /^en/i.test(t.languageCode);
          }) ||
          tracklist[0];

        if (chosen && chosen.baseUrl) {
          var json3Url =
            chosen.baseUrl.indexOf("fmt=") !== -1
              ? chosen.baseUrl.replace(/fmt=[^&]+/, "fmt=json3")
              : chosen.baseUrl + "&fmt=json3";

          origFetch(json3Url, { credentials: "include" })
            .then(function (r) {
              return r.text();
            })
            .then(function (txt) {
              if (txt && txt.trim()) {
                handleTimedTextResponse(txt);
              } else {
                return origFetch(chosen.baseUrl, { credentials: "include" })
                  .then(function (r2) {
                    return r2.text();
                  })
                  .then(function (xmlTxt) {
                    handleTimedTextResponse(xmlTxt);
                  });
              }
            })
            .catch(function () {});
        }
      } else {
        postToContentScript("YT_NO_CAPTION_TRACKS", { videoId: videoId });
      }
    }
  }

  setInterval(inspectYouTubePlayer, 1000);
  window.addEventListener("yt-navigate-finish", function () {
    setTimeout(inspectYouTubePlayer, 300);
  });
})();
