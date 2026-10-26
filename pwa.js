/* Registers the WhereIsShe service worker and, on Chromium, a dismissible Install chip.
   The chip is position:fixed so it never changes document flow or the first-screen map.
   iOS does not fire beforeinstallprompt; nothing is shown there. */
(function () {
  "use strict";
  var KEY = "wis.pwaInstall.v1";

  function dismissed() {
    try { return localStorage.getItem(KEY) === "1"; } catch (e) { return false; }
  }
  function remember() {
    try { localStorage.setItem(KEY, "1"); } catch (e) {}
  }
  function ios() {
    var ua = navigator.userAgent || "";
    if (/iPad|iPhone|iPod/.test(ua)) return true;
    return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  }
  function standalone() {
    return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  }

  if ("serviceWorker" in navigator && (location.protocol === "http:" || location.protocol === "https:")) {
    try {
      navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(function () {});
    } catch (e) {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(function () {});
    }
  }

  if (ios()) return;

  var deferred = null;

  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    if (dismissed() || standalone()) return;
    deferred = e;
    show();
  });

  window.addEventListener("appinstalled", function () {
    deferred = null;
    remember();
    hide();
  });

  function hide() {
    var el = document.getElementById("pwaInstall");
    if (el) el.remove();
  }

  function show() {
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", show, { once: true });
      return;
    }
    if (!document.getElementById("stage") || document.getElementById("pwaInstall") || dismissed() || standalone()) return;
    var bar = document.createElement("div");
    bar.id = "pwaInstall";
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "Install WhereIsShe");
    bar.style.cssText = "position:fixed;z-index:30;left:calc(10px + env(safe-area-inset-left, 0px));bottom:calc(42vh + env(safe-area-inset-bottom, 0px));display:flex;align-items:center;margin:0;padding:2px 2px 2px 12px;border-radius:999px;background:#3B5BFF;color:#fff;box-shadow:0 8px 18px -8px rgba(0,0,0,.65);font:700 12.5px/1 Helvetica,Arial,sans-serif;letter-spacing:.02em;max-width:min(168px, calc(46vw - 20px));";
    var go = document.createElement("button");
    go.type = "button";
    go.textContent = "Install";
    go.style.cssText = "border:0;background:transparent;color:inherit;font:inherit;font-weight:700;padding:7px 4px;cursor:pointer;";
    var dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.setAttribute("aria-label", "Dismiss");
    dismiss.textContent = "\u00d7";
    dismiss.style.cssText = "border:0;background:transparent;color:inherit;font:inherit;width:28px;height:28px;padding:0;cursor:pointer;opacity:.9;";
    go.addEventListener("click", function () {
      if (!deferred || typeof deferred.prompt !== "function") return;
      var promptEvent = deferred;
      deferred = null;
      promptEvent.prompt();
      hide();
      var choice = promptEvent.userChoice;
      if (choice && typeof choice.then === "function") {
        choice.then(function (result) {
          if (result && result.outcome === "accepted") remember();
        });
      }
    });
    dismiss.addEventListener("click", function () {
      remember();
      deferred = null;
      hide();
    });
    bar.appendChild(go);
    bar.appendChild(dismiss);
    document.body.appendChild(bar);
  }
})();
