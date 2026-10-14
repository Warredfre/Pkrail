(function () {
  "use strict";

  const LINES_DIR = "./lines/";
  const STORAGE_ZONES = "pkrail.zones.v3";
  const STORAGE_SETTINGS = "pkrail.settings.v2";

  const state = {
    lines: [],
    engine: null,
    zones: [],
    settings: {
      source: "gps",
      simulatedLineId: "demo.nantes_bordeaux",
      speedKmh: 140,
      pingPong: false
    },
    snapshot: null,
    simPK: 110000,
    simSign: 1,
    watchId: null,
    simTimer: null,
    tab: "position"
  };

  const els = {};

  function $(id) { return document.getElementById(id); }

  function loadSettings() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_SETTINGS) || "null");
      if (raw) Object.assign(state.settings, raw);
    } catch (_) { /* ignore */ }
  }

  function saveSettings() {
    localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(state.settings));
  }

  function loadZones() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_ZONES) || "null");
      if (Array.isArray(raw)) {
        state.zones = raw.map(PKRail.normalizeZone);
      }
    } catch (_) { /* ignore */ }
    state.zones = [];
  }

  function saveZones() {
    localStorage.setItem(STORAGE_ZONES, JSON.stringify(state.zones));
  }

  async function loadCatalog() {
    const catalog = await (await fetch(LINES_DIR + "catalog.json")).json();
    const lines = [];
    for (const name of catalog.lines) {
      const file = await (await fetch(LINES_DIR + name)).json();
      lines.push(PKRail.prepareLine(file));
    }
    state.lines = lines;
    state.engine = PKRail.createEngine(lines);
    loadZones();
    const known = new Set(lines.map((l) => l.id));
    const before = state.zones.length;
    state.zones = state.zones.filter((z) => known.has(z.lineId));
    if (state.zones.length !== before) saveZones();
    fillLineSelects();
    startSource();
  }

  function fillLineSelects() {
    const sim = $("sim-line");
    const zone = $("zone-line");
    [sim, zone].forEach((sel) => {
      sel.innerHTML = "";
      state.lines.forEach((line) => {
        const opt = document.createElement("option");
        opt.value = line.id;
        opt.textContent = line.name;
        sel.appendChild(opt);
      });
    });
    sim.value = state.settings.simulatedLineId;
    if (![...sim.options].some((o) => o.value === sim.value) && sim.options.length) {
      sim.selectedIndex = 0;
      state.settings.simulatedLineId = sim.value;
    }
    $("speed").value = String(state.settings.speedKmh);
    $("source").value = state.settings.source;
    $("pingpong").checked = state.settings.pingPong;
    syncSimPanel();
    prefillZoneLine();
  }

  function prefillZoneLine() {
    const sel = $("zone-line");
    const hint = $("zone-line-hint");
    if (!sel) return;
    const detected = state.snapshot && state.snapshot.position && state.snapshot.position.line;
    if (detected && [...sel.options].some((o) => o.value === detected.id)) {
      sel.value = detected.id;
      if (hint) {
        hint.innerHTML = "Ligne détectée par le GPS : <b>" + escapeHtml(detected.name) +
          "</b>. Inutile de la choisir, sauf si la détection s’est trompée (un PK n’existe que sur une ligne).";
      }
    } else if (hint) {
      hint.textContent = "Pas de ligne GPS pour l’instant : choisissez la ligne de la zone. Le PK 120+000 de Nantes–Bordeaux n’est pas le même que celui de Paris–Lyon.";
    }
  }

  function syncSimPanel() {
    const sim = state.settings.source === "simulation";
    const panel = $("sim-panel");
    if (panel) panel.hidden = !sim;
    const hint = $("gps-mode-help");
    if (hint) hint.hidden = sim;
  }

  function jumpTo(pk) {
    state.settings.source = "simulation";
    $("source").value = "simulation";
    saveSettings();
    syncSimPanel();
    if (!state.simTimer) startSimulation();
    state.simPK = pk;
    showTab("position");
  }

  function startSource() {
    stopSource();
    state.engine.reset();
    if (state.settings.source === "gps") startGPS();
    else startSimulation();
  }

  function stopSource() {
    if (state.watchId != null) {
      navigator.geolocation.clearWatch(state.watchId);
      state.watchId = null;
    }
    if (state.simTimer) {
      clearInterval(state.simTimer);
      state.simTimer = null;
    }
  }

  function startSimulation() {
    const line = lineById(state.settings.simulatedLineId) || state.lines[0];
    if (!line) return;
    state.simPK = Math.min(Math.max(117000, line.minPKMeters), line.maxPKMeters);
    state.simSign = 1;
    tickSimulation();
    state.simTimer = setInterval(tickSimulation, 500);
  }

  function tickSimulation() {
    const line = lineById(state.settings.simulatedLineId) || state.lines[0];
    if (!line) return;
    const speed = Math.max(0, Number(state.settings.speedKmh) || 0) / 3.6;
    state.simPK += state.simSign * speed * 0.5;
    if (state.simPK >= line.maxPKMeters) {
      if (state.settings.pingPong) { state.simPK = line.maxPKMeters; state.simSign = -1; }
      else state.simPK = line.minPKMeters;
    } else if (state.simPK <= line.minPKMeters) {
      if (state.settings.pingPong) { state.simPK = line.minPKMeters; state.simSign = 1; }
      else state.simPK = line.maxPKMeters;
    }
    const coord = PKRail.coordinateAtPK(line, state.simPK);
    if (!coord) return;
    ingest({
      latitude: coord.latitude,
      longitude: coord.longitude,
      accuracy: 6,
      speed: speed,
      course: 90,
      timestamp: Date.now(),
      simulated: true,
      zones: state.zones
    });
  }

  function startGPS() {
    $("line-name").textContent = "Détection automatique de la ligne";
    $("status-line").textContent = "Recherche GPS… autorisez la position si Safari le demande";
    $("pk").textContent = "PK —";
    $("alert-title").textContent = "🟢  NORMAL";
    $("alert-sub").textContent = "Aucune ligne à choisir : le GPS projette votre position sur le catalogue.";
    if (!navigator.geolocation) {
      ingest({ latitude: NaN, longitude: NaN, accuracy: -1, speed: -1, course: -1, timestamp: Date.now(), zones: state.zones });
      $("gps-help").textContent = "La géolocalisation n’est pas disponible dans ce navigateur.";
      return;
    }
    state.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        ingest({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          speed: pos.coords.speed == null ? -1 : pos.coords.speed,
          course: pos.coords.heading == null ? -1 : pos.coords.heading,
          timestamp: pos.timestamp || Date.now(),
          simulated: false,
          zones: state.zones
        });
      },
      (err) => {
        $("gps-help").textContent = "GPS : " + err.message + " — Safari n’autorise la position que sur HTTPS, et seulement tant que l’onglet est ouvert.";
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
    );
  }

  function ingest(sample) {
    const snap = state.engine.ingest(sample);
    snap.alert = PKRail.evaluateZones(
      (snap.position && snap.position.pkMeters) || 0,
      (snap.position && snap.position.line.id) || "",
      (snap.position && snap.position.direction) || "unknown",
      state.zones,
      1000
    );
    if (!snap.position) snap.alert = { level: "normal", symbol: "🟢", title: "NORMAL", subtitle: "", distanceMeters: null, zone: null };
    state.snapshot = snap;
    renderPosition();
  }

  function lineById(id) {
    return state.lines.find((l) => l.id === id);
  }

  function directionLabel(dir) {
    if (dir === "increasing") return "PK croissant";
    if (dir === "decreasing") return "PK décroissant";
    return "Sens indéterminé";
  }

  function statusLabel(status) {
    const map = {
      tracking: "Suivi en cours",
      simulated: "Simulation",
      gpsLost: "GPS perdu (tunnel / masque)",
      noLineDetected: "Aucune ligne détectée",
      tooFarFromTrack: "Trop éloigné d’une ligne",
      waitingForFix: "Recherche GPS…",
      noRailwayData: "Données ferroviaires absentes",
      multipleLineCandidates: "Plusieurs lignes possibles",
      insufficientAccuracy: "Précision GPS insuffisante"
    };
    return map[status] || status;
  }

  function renderPosition() {
    const snap = state.snapshot;
    const level = (snap && snap.alert && snap.alert.level) || "normal";
    document.body.className = "level-" + level;
    if (!snap) return;
    $("line-name").textContent = snap.position
      ? snap.position.line.name
      : (state.settings.source === "gps" ? "Détection automatique — hors ligne catalogue" : "Hors ligne configurée");
    $("status-line").textContent = statusLabel(snap.status);
    if (snap.position && snap.position.confidence !== "none") {
      $("pk").textContent = snap.position.display;
      $("confidence").hidden = snap.position.confidence !== "low";
      $("confidence").textContent = snap.position.deadReckoned
        ? "ESTIMATION (GPS PERDU) — CONFIANCE FAIBLE"
        : "CONFIANCE FAIBLE";
    } else {
      $("pk").textContent = "PK —";
      $("confidence").hidden = true;
    }
    $("alert-title").textContent = snap.alert.symbol + "  " + snap.alert.title;
    $("alert-sub").textContent = snap.alert.subtitle || (snap.position ? snap.position.display : "");
    const kmh = snap.speed >= 0 ? Math.round(snap.speed * 3.6) + " km/h" : "—";
    $("metric-speed").textContent = kmh;
    $("metric-gps").textContent = snap.accuracy >= 0 ? "±" + Math.round(snap.accuracy) + " m" : "—";
    $("metric-dir").textContent = snap.position ? directionLabel(snap.position.direction) : "—";
    $("metric-dist").textContent = snap.position ? Math.round(snap.position.distanceToTrack) + " m" : "—";
    if ($("demo-banner")) $("demo-banner").hidden = true;
  }

  function zonesGroupedByLine() {
    const order = state.lines.map((l) => l.id);
    const groups = new Map();
    state.lines.forEach((line) => groups.set(line.id, { id: line.id, name: line.name, zones: [] }));
    state.zones.forEach((zone) => {
      if (!groups.has(zone.lineId)) {
        groups.set(zone.lineId, { id: zone.lineId, name: zone.lineId, zones: [] });
      }
      groups.get(zone.lineId).zones.push(zone);
    });
    groups.forEach((g) => g.zones.sort((a, b) => a.lower - b.lower));
    const listed = order.map((id) => groups.get(id)).filter((g) => g && g.zones.length);
    groups.forEach((g, id) => {
      if (!order.includes(id) && g.zones.length) listed.push(g);
    });
    return listed;
  }

  function renderZones() {
    const box = $("zone-list");
    box.innerHTML = "";
    if (!state.zones.length) {
      box.innerHTML = "<div class='row'><div class='meta'>Aucune zone enregistrée. Créez-en une ci-dessous : elle sera classée sous sa ligne.</div></div>";
      return;
    }
    zonesGroupedByLine().forEach((group) => {
      const header = document.createElement("div");
      header.className = "line-header";
      header.textContent = group.name + "  ·  " + group.zones.length + " zone" + (group.zones.length > 1 ? "s" : "");
      box.appendChild(header);
      group.zones.forEach((zone) => {
        const row = document.createElement("div");
        row.className = "row";
        row.innerHTML =
          "<div class='swatch' style='background:" + (zone.colorHex || "#E65100") + "'></div>" +
          "<div class='meta'><b>" + escapeHtml(zone.name) + (zone.enabled ? "" : " (OFF)") + "</b>" +
          "<span>" + PKRail.displayPK(zone.startPKMeters) + " → " + PKRail.displayPK(zone.endPKMeters) + "</span></div>";
        const toggle = document.createElement("button");
        toggle.className = "icon-btn";
        toggle.textContent = zone.enabled ? "ON" : "OFF";
        toggle.onclick = () => {
          zone.enabled = !zone.enabled;
          saveZones();
          renderZones();
        };
        const del = document.createElement("button");
        del.className = "icon-btn";
        del.textContent = "✕";
        del.onclick = () => {
          state.zones = state.zones.filter((z) => z.id !== zone.id);
          saveZones();
          renderZones();
        };
        row.appendChild(toggle);
        row.appendChild(del);
        box.appendChild(row);
      });
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function showTab(name) {
    state.tab = name;
    document.querySelectorAll(".screen").forEach((el) => el.classList.toggle("active", el.dataset.tab === name));
    document.querySelectorAll(".tabbar button").forEach((el) => el.classList.toggle("active", el.dataset.tab === name));
    if (name === "zones") {
      renderZones();
      prefillZoneLine();
    }
  }

  function bind() {
    document.querySelectorAll(".tabbar button").forEach((btn) => {
      btn.addEventListener("click", () => showTab(btn.dataset.tab));
    });
    $("source").addEventListener("change", () => {
      state.settings.source = $("source").value;
      saveSettings();
      syncSimPanel();
      startSource();
    });
    $("sim-line").addEventListener("change", () => {
      state.settings.simulatedLineId = $("sim-line").value;
      saveSettings();
      if (state.settings.source === "simulation") startSource();
    });
    $("speed").addEventListener("change", () => {
      state.settings.speedKmh = Number($("speed").value);
      saveSettings();
    });
    $("pingpong").addEventListener("change", () => {
      state.settings.pingPong = $("pingpong").checked;
      saveSettings();
    });
    $("restart-sim").addEventListener("click", () => {
      state.settings.source = "simulation";
      $("source").value = "simulation";
      saveSettings();
      syncSimPanel();
      startSource();
      showTab("position");
    });
    $("jump-orange").addEventListener("click", () => jumpTo(119300));
    $("jump-red").addEventListener("click", () => jumpTo(125400));
    $("save-zone").addEventListener("click", () => {
      const name = $("zone-name").value.trim() || "Zone";
      const start = PKRail.parsePK($("zone-start").value);
      const end = PKRail.parsePK($("zone-end").value);
      const err = $("zone-error");
      if (start == null || end == null) {
        err.textContent = "PK invalide. Exemple : 120+000";
        return;
      }
      if (Math.abs(end - start) < 1) {
        err.textContent = "Le début et la fin doivent être différents.";
        return;
      }
      err.textContent = "";
      state.zones.unshift(PKRail.normalizeZone({
        id: crypto.randomUUID(),
        name,
        lineId: $("zone-line").value,
        startPKMeters: start,
        endPKMeters: end,
        colorHex: $("zone-color").value,
        details: "",
        enabled: true
      }));
      saveZones();
      $("zone-name").value = "";
      renderZones();
    });
  }

  async function boot() {
    loadSettings();
    bind();
    showTab("position");
    try {
      await loadCatalog();
    } catch (e) {
      $("status-line").textContent = "Impossible de charger le catalogue : " + e.message;
    }
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    }
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
