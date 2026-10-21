/* WhereIsShe basemap: OpenFreeMap vector tiles (free, no API key, no registration, any use) rendered with MapLibre GL
   inside Leaflet. Falls back once to Esri World Street Map raster tiles (keyless) if WebGL is unavailable or the
   OpenFreeMap style fails to load.
   Not used (on purpose): tile.openstreetmap.org (its tile usage policy blocks apps like this) and CARTO raster
   basemaps (since 25 Sep 2026 they need an API key and serve "API KEY REQUIRED" tiles without one). */
(function () {
  "use strict";
  var OFM_STYLE = "https://tiles.openfreemap.org/styles/liberty";
  var OFM_ATTR = '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> Data from &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
  var ESRI = { url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", maxZoom: 18,
    attribution: 'Tiles &copy; <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a> &mdash; Esri, HERE, Garmin, USGS, &copy; OpenStreetMap contributors' };
  function webgl() { try { var c = document.createElement("canvas"); return !!(c.getContext("webgl2") || c.getContext("webgl")); } catch (e) { return false; } }
  function raster(m) {
    var tl = L.tileLayer(ESRI.url, { attribution: ESRI.attribution, maxZoom: ESRI.maxZoom }).addTo(m);
    m._wisBase = { kind: "esri", layer: tl }; return tl;
  }
  window.WISTiles = function (m) {
    if (!window.maplibregl || !L.maplibreGL || !webgl()) return raster(m);
    var gl = L.maplibreGL({ style: OFM_STYLE, attribution: OFM_ATTR, interactive: false, attributionControl: false, dragRotate: false, pitchWithRotate: false });
    gl.addTo(m); m._wisBase = { kind: "openfreemap", layer: gl, loaded: false };
    if (m.attributionControl && !(gl.getAttribution && gl.getAttribution())) m.attributionControl.addAttribution(OFM_ATTR);
    var swapped = false, mm = gl.getMaplibreMap && gl.getMaplibreMap();
    function fallback(why) {
      if (swapped || m._wisBase.loaded) return; swapped = true;
      try { m.removeLayer(gl); if (m.attributionControl) m.attributionControl.removeAttribution(OFM_ATTR); } catch (e) {}
      if (window.console) console.warn("WhereIsShe map: OpenFreeMap failed (" + why + "), using Esri fallback");
      raster(m);
    }
    if (mm) {
      mm.on("load", function () { m._wisBase.loaded = true; });
      mm.on("error", function (e) { if (!m._wisBase.loaded && e && e.error && /style|Failed to fetch|NetworkError/i.test(String(e.error.message || e.error))) fallback("style error"); });
    }
    setTimeout(function () { if (!m._wisBase.loaded) fallback("timeout"); }, 15000);
    // keep the GL canvas in sync when the dock changes size (mini / hover-grow / full / reveal)
    m.on("resize", function () { var x = gl.getMaplibreMap && gl.getMaplibreMap(); if (x) x.resize(); if (gl._update) gl._update(); });
    return gl;
  };
  // test/debug helper: true once the basemap has drawn
  window.WISTiles.ready = function (m) {
    var b = m && m._wisBase; if (!b) return false;
    if (b.kind === "openfreemap") return !!b.loaded && b.layer.getMaplibreMap().areTilesLoaded();
    return m.getContainer().querySelectorAll(".leaflet-tile-loaded").length > 0;
  };
})();
