/* run.js — live run page */

mapboxgl.accessToken = MAPBOX_TOKEN;
firebase.initializeApp(FIREBASE_CONFIG);
const db = firebase.database();

const COLORS = [
  '#FF6B35', '#10B981', '#3B82F6', '#8B5CF6',
  '#F59E0B', '#EC4899', '#14B8A6', '#F97316',
];

let userId = sessionStorage.getItem('rs_uid') || (() => {
  const id = randomId();
  sessionStorage.setItem('rs_uid', id);
  return id;
})();

let map;
let sessionId;
let sessionPassword    = null;
let isCreator          = false;
let watchId            = null;
let isJoined           = false;
let followMe           = false;
let colorIndex         = 0;
let participantColors  = {};
let participantMarkers = {};
let routeCoords        = [];
let lastPushLocation   = null;
let smoothedPace       = null;
let ghostMarkers       = {};
let lastParticipants   = {};
let trailVisible       = {};
let lastTrailPoint     = null;
let myMarkerEl         = null;
let myBearing          = null;
let preJoinWatchId     = null;
let preJoinMarker      = null;
let myRef              = null;
let wakeLock           = null;
let wakeWanted         = true;   // user can turn it off to save battery
let wakeDenied         = null;   // error name when the OS refuses the lock

const STALE_MS       = 30_000;
const START_RADIUS_M = 50;

// ── INIT ──────────────────────────────────────────────────────────────────────

async function init() {
  sessionId = new URLSearchParams(location.search).get('s');
  if (!sessionId) return showError('No session ID in link.');

  let session;
  try {
    const snap = await db.ref(`sessions/${sessionId}`).once('value');
    if (!snap.exists()) return showError('Session not found — the link may be invalid.');
    session = snap.val();
    routeCoords = session.route || [];
  } catch (err) {
    return showError('Could not connect to database: ' + err.message);
  }

  if (session.ended) return showEndedOverlay();

  sessionPassword = session.password || null;
  isCreator = session.creatorId === userId;

  document.getElementById('sessionTitle').textContent = session.name;
  document.getElementById('sessionMeta').textContent =
    `${session.distanceKm?.toFixed(1) ?? '?'} km`;

  if (isCreator) document.getElementById('endRunBtn').style.display = 'inline-flex';
  if (sessionPassword) document.getElementById('passwordRow').style.display = 'flex';

  map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/streets-v12',
    center: [103.8198, 1.3521],
    zoom: 13,
  });

  const geolocate = new mapboxgl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: false,
  });
  map.addControl(geolocate, 'top-right');

  map.on('load', () => {
    renderRoute(session.route);
    db.ref(`sessions/${sessionId}/participants`).on('value', onParticipantsSnapshot);
  });

  db.ref(`sessions/${sessionId}/ended`).on('value', snap => {
    if (snap.val() === true) showEndedOverlay();
  });

  const savedName = sessionStorage.getItem('rs_name');
  if (savedName) {
    startSharing(savedName);
  } else if (new URLSearchParams(location.search).get('join') === '1') {
    map.on('load', () => showJoinModal());
  }

  document.addEventListener('visibilitychange', onVisibilityChange);

  // beforeunload does not reliably fire on mobile (backgrounding Safari, losing
  // signal, battery death). onDisconnect is registered with the server, so it
  // still marks the runner inactive when the connection simply disappears.
  window.addEventListener('pagehide', () => {
    if (isJoined && myRef) myRef.update({ active: false });
  });
}

// ── ROUTE ─────────────────────────────────────────────────────────────────────

function renderRoute(coordinates) {
  if (!coordinates?.length) return;
  const bounds = coordinates.reduce(
    (b, c) => b.extend(c),
    new mapboxgl.LngLatBounds(coordinates[0], coordinates[0])
  );
  map.fitBounds(bounds, { padding: { top: 80, bottom: 120, left: 40, right: 40 }, maxZoom: 15 });

  map.addSource('route', {
    type: 'geojson',
    data: { type: 'Feature', geometry: { type: 'LineString', coordinates } },
  });
  map.addLayer({
    id: 'route-casing',
    type: 'line', source: 'route',
    paint: { 'line-color': 'white', 'line-width': 7, 'line-opacity': .7 },
  });
  map.addLayer({
    id: 'route-line',
    type: 'line', source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#FF6B35', 'line-width': 4 },
  });

  addStaticMarker(coordinates[0], '#10B981');
  if (JSON.stringify(coordinates[0]) !== JSON.stringify(coordinates.at(-1))) {
    addStaticMarker(coordinates.at(-1), '#EF4444');
  }
}

function addStaticMarker(lngLat, color) {
  const el = document.createElement('div');
  el.style.cssText = `
    width:14px;height:14px;border-radius:50%;
    background:${color};border:3px solid white;
    box-shadow:0 2px 6px rgba(0,0,0,.4);
  `;
  new mapboxgl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
}

// ── PARTICIPANTS ──────────────────────────────────────────────────────────────

function onParticipantsSnapshot(snapshot) {
  const all = snapshot.val() || {};
  const now = Date.now();
  lastParticipants = all;

  Object.keys(all).forEach(id => {
    if (!participantColors[id]) participantColors[id] = COLORS[colorIndex++ % COLORS.length];
  });

  Object.entries(all).forEach(([id, p]) => {
    // lat/lng of exactly 0 are valid coordinates (equator / prime meridian),
    // so a truthiness check would silently drop those runners.
    if (typeof p.lat !== 'number' || typeof p.lng !== 'number') return;
    const isMe  = id === userId;
    const age   = now - (p.lastSeen || 0);
    const active = age < 120_000;
    const stale  = age > STALE_MS;
    const color  = participantColors[id];
    const opacity = !active ? '0.3' : stale ? '0.5' : '1';

    if (participantMarkers[id]) {
      participantMarkers[id].setLngLat([p.lng, p.lat]);
      participantMarkers[id].getElement().style.opacity = opacity;
    } else {
      const el = makeRunnerEl(p.name, color, isMe);
      if (isMe) {
        myMarkerEl = el.querySelector('.runner-inner');
        if (myBearing !== null) applyBearing(myBearing);
      }
      const marker = new mapboxgl.Marker({ element: el })
        .setLngLat([p.lng, p.lat])
        .setPopup(new mapboxgl.Popup({ offset: 25, closeButton: false })
          .setText(isMe ? `${p.name} (You)` : p.name))
        .addTo(map);
      participantMarkers[id] = marker;
    }

    // Ghost marker for stale-but-recent participants with known pace
    if (stale && active && p.pace) {
      const elapsedMins   = Math.min(age / 60000, 10);
      const estimatedDist = elapsedMins / p.pace;
      const estimated     = walkForwardOnRoute(p.lat, p.lng, estimatedDist);
      if (estimated) {
        const [estLat, estLng] = estimated;
        if (ghostMarkers[id]) {
          ghostMarkers[id].setLngLat([estLng, estLat]);
        } else {
          const el = makeGhostEl(color);
          ghostMarkers[id] = new mapboxgl.Marker({ element: el })
            .setLngLat([estLng, estLat])
            .setPopup(new mapboxgl.Popup({ offset: 25, closeButton: false })
              .setText(`${p.name} (estimated)`))
            .addTo(map);
        }
      }
    } else if (ghostMarkers[id]) {
      ghostMarkers[id].remove();
      delete ghostMarkers[id];
    }

    if (isMe && followMe && !stale) map.easeTo({ center: [p.lng, p.lat], duration: 500 });
  });

  Object.keys(participantMarkers).forEach(id => {
    if (!all[id]) { participantMarkers[id].remove(); delete participantMarkers[id]; }
  });
  Object.keys(ghostMarkers).forEach(id => {
    if (!all[id]) { ghostMarkers[id].remove(); delete ghostMarkers[id]; }
  });

  renderParticipantBar(all, now);
}

function makeRunnerEl(name, color, isMe) {
  // wrapper: Mapbox owns the positioning transform on this
  // inner:   we rotate this for compass — kept separate to avoid conflict
  const wrapper = document.createElement('div');

  const inner = document.createElement('div');
  inner.className = 'runner-inner';
  inner.style.cssText = 'cursor:pointer;line-height:0;transform-origin:50% 50%;';

  // SVG marker: circle (50×50) with overflow:visible fan extending upward
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '50');
  svg.setAttribute('height', '50');
  svg.setAttribute('viewBox', '0 0 50 50');
  svg.style.cssText = 'overflow:visible;filter:drop-shadow(0 2px 6px rgba(0,0,0,.35));';

  // Wide fan — Google Maps style, hidden until bearing available
  // Path: from circle centre (25,25) → left base → curved tip → right base → close
  const fan = document.createElementNS(ns, 'path');
  fan.setAttribute('d', 'M25,25 L8,-2 Q25,-18 42,-2 Z');
  fan.setAttribute('fill', color);
  fan.setAttribute('fill-opacity', '0.45');
  fan.className = 'bearing-cone';
  fan.style.cssText = 'opacity:0;transition:opacity .3s;';

  const circle = document.createElementNS(ns, 'circle');
  circle.setAttribute('cx', '25'); circle.setAttribute('cy', '25'); circle.setAttribute('r', '20');
  circle.setAttribute('fill', color);
  circle.setAttribute('stroke', isMe ? '#FFD700' : 'white');
  circle.setAttribute('stroke-width', '3');

  const text = document.createElementNS(ns, 'text');
  text.setAttribute('x', '25'); text.setAttribute('y', '25');
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('dominant-baseline', 'central');
  text.setAttribute('fill', 'white');
  text.setAttribute('font-size', '15');
  text.setAttribute('font-weight', '700');
  text.setAttribute('font-family', 'Inter,-apple-system,sans-serif');
  text.textContent = name.charAt(0).toUpperCase();

  svg.appendChild(fan);
  svg.appendChild(circle);
  svg.appendChild(text);
  inner.appendChild(svg);
  wrapper.appendChild(inner);
  return wrapper;
}

function renderParticipantBar(all, now) {
  const chips   = document.getElementById('participantChips');
  const countEl = document.getElementById('activeCount');
  const entries = Object.entries(all);

  const activeCount = entries.filter(([, p]) => now - (p.lastSeen || 0) < 120_000).length;
  countEl.textContent = `${activeCount} active`;

  if (!entries.length) {
    chips.innerHTML = '<span style="color:var(--muted);font-size:13px">No runners yet — share the link to get started</span>';
    return;
  }

  chips.innerHTML = entries.map(([id, p]) => {
    const active = now - (p.lastSeen || 0) < 120_000;
    const color  = participantColors[id] || '#999';
    const isMe   = id === userId;

    const hasFix     = typeof p.lat === 'number' && typeof p.lng === 'number';
    const remaining  = (active && hasFix) ? getRemainingDistance(p.lat, p.lng) : null;
    const notStarted = (active && hasFix && routeCoords.length > 0)
      ? haversineKm(p.lat, p.lng, routeCoords[0][1], routeCoords[0][0]) * 1000 < START_RADIUS_M
      : false;
    const etaStr  = notStarted ? null : formatETA(remaining, p.pace ?? null);
    const paceStr = notStarted ? null : (p.pace ? formatPace(p.pace) : null);

    const age   = now - (p.lastSeen || 0);
    const stale = active && age > STALE_MS;

    const metaParts = [];
    if (notStarted)              metaParts.push('Not started');
    else if (remaining !== null) metaParts.push(`${remaining.toFixed(1)} km left`);
    if (etaStr)                  metaParts.push(etaStr);
    if (paceStr)                 metaParts.push(paceStr);

    let staleLine = '';
    if (stale) {
      const lastSeenStr = new Date(p.lastSeen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const elapsedMins = Math.min(age / 60000, 10);
      const estM = p.pace ? Math.round(elapsedMins / p.pace * 1000) : null;
      // "phone locked" and "lost signal" look identical from here unless the
      // device managed to flag itself on the way out. Say which one it was.
      const reason = p.paused ? 'phone locked' : 'last seen';
      staleLine = `<span class="chip-stale">${reason} ${lastSeenStr}${estM ? ` · est. ~${estM}m ahead` : ''}</span>`;
    }

    const iosBadge    = p.platform === 'ios' ? '<span class="ios-badge">iOS</span>' : '';
    const trailActive = trailVisible[id] || false;

    return `
      <div class="participant-chip ${active ? '' : 'inactive'} ${trailActive ? 'trail-on' : ''}"
           onclick="toggleTrail('${escapeHtml(id)}')" title="Tap to show/hide trail">
        <div class="chip-dot" style="background:${color}"></div>
        <div class="chip-info">
          <span class="chip-name">${escapeHtml(p.name)}${isMe ? ' (You)' : ''}${iosBadge}</span>
          ${metaParts.length ? `<span class="chip-meta">${metaParts.join(' · ')}</span>` : ''}
          ${staleLine}
        </div>
        ${!active ? '<span class="offline-badge">offline</span>' : ''}
      </div>
    `;
  }).join('');
}

// ── TRAILS ────────────────────────────────────────────────────────────────────

async function toggleTrail(participantId) {
  if (trailVisible[participantId]) {
    if (map.getLayer(`trail-${participantId}`)) map.removeLayer(`trail-${participantId}`);
    if (map.getSource(`trail-${participantId}`)) map.removeSource(`trail-${participantId}`);
    trailVisible[participantId] = false;
  } else {
    const snap = await db.ref(`sessions/${sessionId}/trails/${participantId}`).once('value');
    const raw  = snap.val();
    if (!raw) return;
    const coords = Object.values(raw).map(p => [p.lng, p.lat]);
    if (coords.length < 2) return;
    const color = participantColors[participantId] || '#999';
    map.addSource(`trail-${participantId}`, {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } },
    });
    map.addLayer({
      id: `trail-${participantId}`,
      type: 'line', source: `trail-${participantId}`,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': color, 'line-width': 2, 'line-opacity': 0.65, 'line-dasharray': [2, 2] },
    });
    trailVisible[participantId] = true;
  }
  renderParticipantBar(lastParticipants, Date.now());
}

// ── PRE-JOIN LOCATION DOT ─────────────────────────────────────────────────────

function startPreJoinLocation() {
  if (preJoinMarker) return;
  navigator.geolocation?.getCurrentPosition(pos => {
    if (isJoined) return; // user joined while waiting for fix — skip dot
    const { latitude: lat, longitude: lng } = pos.coords;
    const el = document.createElement('div');
    el.style.cssText = `
      width:16px;height:16px;border-radius:50%;
      background:#4285F4;border:3px solid white;
      box-shadow:0 0 0 5px rgba(66,133,244,0.25);
    `;
    preJoinMarker = new mapboxgl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map);
    map.easeTo({ center: [lng, lat], duration: 800 });
  }, err => {
    // GPS blocked — likely an in-app browser (Telegram, Instagram, etc.)
    if (err.code === 1 || err.code === 2) showOpenInBrowserBanner();
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
}

function stopPreJoinLocation() {
  if (preJoinMarker) { preJoinMarker.remove(); preJoinMarker = null; }
}

function showOpenInBrowserBanner() {
  if (document.getElementById('browser-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'browser-banner';
  banner.style.cssText = `position:fixed;top:56px;left:0;right:0;z-index:9999;
    background:#EF4444;color:white;padding:10px 16px;text-align:center;
    font-family:Inter,sans-serif;font-size:13px;font-weight:600;line-height:1.5;`;
  banner.innerHTML = `GPS is blocked — open this link in Safari or Chrome instead
    <a href="${location.href}" target="_blank"
    style="display:block;color:white;text-decoration:underline;margin-top:2px">Tap to open in browser →</a>`;
  document.body.appendChild(banner);
}

// ── JOIN / LEAVE ──────────────────────────────────────────────────────────────

async function showJoinModal() {
  startPreJoinLocation(); // user gesture context — iOS will grant location permission
  const modal     = document.getElementById('joinModal');
  const nameInput = document.getElementById('joinName');

  const snap = await db.ref(`sessions/${sessionId}/participants/${userId}`).once('value');
  if (snap.exists() && snap.val().name) {
    nameInput.value    = snap.val().name;
    nameInput.readOnly = true;
    nameInput.style.cssText += ';background:var(--surface);color:var(--muted);cursor:not-allowed';
  } else {
    nameInput.readOnly  = false;
    nameInput.value     = '';
    nameInput.style.cssText = '';
  }

  modal.style.display = 'flex';
  nameInput.focus();
}

function hideJoinModal() {
  document.getElementById('joinModal').style.display = 'none';
}

function handleJoinKey(e) {
  if (e.key === 'Enter') submitJoin();
}

async function submitJoin() {
  // Must call before any await — iOS requires DeviceOrientationEvent.requestPermission
  // to be invoked synchronously within a user gesture handler
  startCompass();

  const name = document.getElementById('joinName').value.trim();
  if (!name) { document.getElementById('joinName').focus(); return; }

  if (sessionPassword) {
    const entered = document.getElementById('joinPassword').value.trim();
    if (entered !== sessionPassword) {
      document.getElementById('passwordError').style.display = 'block';
      document.getElementById('joinPassword').focus();
      return;
    }
  }

  const snap = await db.ref(`sessions/${sessionId}/participants`).once('value');
  const participants = snap.val() || {};
  const nameTaken = Object.entries(participants).some(
    ([id, p]) => p.name?.toLowerCase() === name.toLowerCase() && id !== userId
  );
  if (nameTaken) {
    document.getElementById('nameError').style.display = 'block';
    document.getElementById('joinName').focus();
    return;
  }

  hideJoinModal();
  await startSharing(name);
}

async function endRun() {
  if (!isCreator) return;
  if (!confirm('End this run for everyone?')) return;
  await db.ref(`sessions/${sessionId}`).update({ ended: true, endedAt: Date.now() });
}

function detectPlatform() {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'other';
}

async function startSharing(name) {
  sessionStorage.setItem('rs_name', name);

  myRef = db.ref(`sessions/${sessionId}/participants/${userId}`);
  myRef.onDisconnect().update({ active: false });

  await myRef.update({
    name,
    platform: detectPlatform(),
    lat:      null,
    lng:      null,
    lastSeen: Date.now(),
    joinedAt: Date.now(),
    active:   true,
  });

  if (!navigator.geolocation) { alert('Your browser does not support location sharing.'); return; }

  watchId = navigator.geolocation.watchPosition(
    pos => pushLocation(pos.coords.latitude, pos.coords.longitude),
    err => { console.warn('GPS error:', err); if (err.code === 1 || err.code === 2) showOpenInBrowserBanner(); },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );

  isJoined = true;
  acquireWakeLock();   // called from the join tap, so we still have the gesture
  renderWakeStatus();
  const btn = document.getElementById('joinBtn');
  btn.textContent = '📍 Sharing';
  btn.classList.add('joined');
  btn.onclick = leaveRun;
}

async function pushLocation(lat, lng) {
  if (!isJoined) return;
  stopPreJoinLocation(); // swap pre-join dot for real participant marker on first GPS fix
  const now = Date.now();

  if (lastPushLocation) {
    const dt   = (now - lastPushLocation.time) / 60000;
    const dist = haversineKm(lastPushLocation.lat, lastPushLocation.lng, lat, lng);
    if (dist > 0.015 && dt > 0.05) {
      const instant = dt / dist;
      if (instant >= 2 && instant <= 20) {
        smoothedPace = smoothedPace ? 0.7 * smoothedPace + 0.3 * instant : instant;
      }
    }
  }
  lastPushLocation = { lat, lng, time: now };

  await db.ref(`sessions/${sessionId}/participants/${userId}`).update({
    lat, lng, lastSeen: now,
    ...(smoothedPace && { pace: parseFloat(smoothedPace.toFixed(2)) }),
  });

  // Append to trail, throttled to >20m movement
  if (!lastTrailPoint || haversineKm(lastTrailPoint.lat, lastTrailPoint.lng, lat, lng) > 0.02) {
    db.ref(`sessions/${sessionId}/trails/${userId}`).push({ lat, lng });
    lastTrailPoint = { lat, lng };
  }
}

function leaveRun() {
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  releaseWakeLock();
  if (myRef) { myRef.onDisconnect().cancel(); myRef.update({ active: false }); }
  sessionStorage.removeItem('rs_name');
  isJoined = false;
  renderWakeStatus();
  const btn = document.getElementById('joinBtn');
  btn.textContent = '+ Join Run';
  btn.classList.remove('joined');
  btn.onclick = showJoinModal;
}

// ── STAYING ALIVE IN THE BACKGROUND ───────────────────────────────────────────
//
// iOS suspends a page's JavaScript when Safari is backgrounded or the screen
// locks. That is deliberate OS behaviour, not something a web page can opt out
// of: watchPosition keeps its registration but no callback ever runs, so a
// pocketed phone silently stops reporting. There is no web API that grants
// background geolocation on iOS — not service workers, not background sync,
// not installing to the home screen.
//
// So we do the three things that are actually available:
//   1. keep the screen from locking at all, which is the whole problem;
//   2. recover in one step the moment the page comes back;
//   3. tell the other runners which of the two happened.

function wakeLockSupported() {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
}

async function acquireWakeLock() {
  if (!wakeWanted || !wakeLockSupported() || wakeLock) return;
  if (document.visibilityState !== 'visible') return;  // request would be rejected
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeDenied = null;
    // The lock is dropped for us whenever the document stops being visible,
    // so this fires on every lock or app switch and we re-request on the way back.
    wakeLock.addEventListener('release', () => { wakeLock = null; renderWakeStatus(); });
  } catch (err) {
    // Low Power Mode is the common one, and it turns on exactly when a long run
    // has drained the battery — so never leave the indicator claiming the screen
    // is held when the request was refused.
    wakeLock = null;
    wakeDenied = err && err.name ? err.name : 'error';
    console.warn('Wake lock refused:', wakeDenied, err && err.message);
  }
  renderWakeStatus();
}

async function releaseWakeLock() {
  if (!wakeLock) return;
  try { await wakeLock.release(); } catch (_) { /* already gone */ }
  wakeLock = null;
  renderWakeStatus();
}

function toggleWakeLock() {
  wakeWanted = !wakeWanted;
  // A tap is a fresh user gesture, so a refusal that was only about missing one
  // is worth retrying here.
  if (wakeWanted) { wakeDenied = null; acquireWakeLock(); } else { releaseWakeLock(); }
  renderWakeStatus();
}

function renderWakeStatus() {
  const el = document.getElementById('wakeStatus');
  if (!el) return;
  if (!isJoined) { el.style.display = 'none'; return; }
  el.style.display = 'inline-flex';

  if (!wakeLockSupported()) {
    el.textContent = '⚠︎ screen may sleep';
    el.title = 'This browser cannot keep the screen awake (needs iOS 16.4+). '
             + 'Locking the phone will pause your location.';
    el.className = 'wake-status warn';
    return;
  }
  if (!wakeWanted) {
    el.textContent = '☾ sleep allowed';
    el.title = 'Screen may lock. Your location pauses while it is locked. Tap to keep awake.';
    el.className = 'wake-status off';
    return;
  }
  if (!wakeLock && wakeDenied) {
    el.textContent = '⚠︎ screen may sleep';
    el.title = wakeDenied === 'NotAllowedError'
      ? 'The phone refused to stay awake — usually Low Power Mode. Turn it off, '
        + 'then tap here to retry. While the screen is locked your location pauses.'
      : 'Could not keep the screen awake (' + wakeDenied + '). Tap to retry. '
        + 'While the screen is locked your location pauses.';
    el.className = 'wake-status warn';
    return;
  }
  el.textContent = wakeLock ? '☀ screen stays on' : '☀ keeping awake…';
  el.title = 'Screen is held awake so location keeps updating. Tap to allow sleeping '
           + '(saves battery, but pauses sharing while locked).';
  el.className = 'wake-status on';
}

// Restart the position watch. After a suspension iOS may never deliver to the
// old registration again, so a fresh watch is cheaper than trusting the old one.
function restartWatch() {
  if (!isJoined || !navigator.geolocation) return;
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  watchId = navigator.geolocation.watchPosition(
    pos => pushLocation(pos.coords.latitude, pos.coords.longitude),
    err => { console.warn('GPS error:', err); if (err.code === 1 || err.code === 2) showOpenInBrowserBanner(); },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
}

function onVisibilityChange() {
  if (!isJoined) return;

  if (document.visibilityState === 'hidden') {
    // Best effort: the page may be frozen before this reaches the server, which
    // is exactly why the ghost marker exists. When it does land, the other
    // runners can say "phone locked" instead of "signal lost".
    if (myRef) myRef.update({ paused: true, pausedAt: Date.now() });
    return;
  }

  // Back in the foreground. Close the gap immediately rather than waiting for
  // the watch to produce its first fix.
  acquireWakeLock();
  restartWatch();
  if (myRef) myRef.update({ paused: false });
  navigator.geolocation?.getCurrentPosition(
    pos => pushLocation(pos.coords.latitude, pos.coords.longitude),
    () => {},
    { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
  );
}

// ── COMPASS ───────────────────────────────────────────────────────────────────

function startCompass() {
  if (typeof DeviceOrientationEvent === 'undefined') return;
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    // iOS 13+ requires explicit permission within a user gesture
    DeviceOrientationEvent.requestPermission()
      .then(state => { if (state === 'granted') window.addEventListener('deviceorientation', onOrientation, true); })
      .catch(() => {});
  } else {
    window.addEventListener('deviceorientation', onOrientation, true);
  }
}

function onOrientation(e) {
  const heading = e.webkitCompassHeading ?? (e.alpha !== null ? (360 - e.alpha) % 360 : null);
  if (heading === null || heading === undefined) return;
  myBearing = heading;
  applyBearing(heading);
}

function applyBearing(heading) {
  if (!myMarkerEl) return;
  const cone = myMarkerEl.querySelector('.bearing-cone');
  if (cone) {
    cone.style.opacity = '1';
    myMarkerEl.style.transform = `rotate(${heading}deg)`;
  }
}

// ── MARKERS ───────────────────────────────────────────────────────────────────

function makeGhostEl(color) {
  const el = document.createElement('div');
  el.style.cssText = `
    width:32px;height:32px;border-radius:50%;
    background:${color};opacity:0.55;
    border:2px dashed white;
    box-shadow:0 2px 6px rgba(0,0,0,.2);
    display:flex;align-items:center;justify-content:center;
    color:white;font-size:14px;cursor:pointer;
  `;
  el.textContent = '?';
  return el;
}

// ── MATH HELPERS ─────────────────────────────────────────────────────────────

// Both callers below need "where on the route is this runner?". It was copy-pasted,
// and both copies compared lng/lat degrees with Math.hypot as if the earth were a
// flat square grid. A degree of longitude is only cos(lat) as long as a degree of
// latitude, so the nearest-segment search picked the wrong segment away from the
// equator — invisible in Singapore (cos≈1.00), wrong by 1.6x in London.
function nearestPointOnRoute(lat, lng) {
  if (routeCoords.length < 2) return null;
  const k = lngScale(lat);
  let minDist = Infinity, bestIdx = 0, bestT = 0;
  for (let i = 0; i < routeCoords.length - 1; i++) {
    const [x1, y1] = routeCoords[i], [x2, y2] = routeCoords[i + 1];
    const dx = (x2 - x1) * k, dy = y2 - y1, lenSq = dx*dx + dy*dy;
    const t = lenSq > 0
      ? Math.max(0, Math.min(1, ((lng - x1) * k * dx + (lat - y1) * dy) / lenSq))
      : 0;
    const d = Math.hypot((lng - x1) * k - t * dx, (lat - y1) - t * dy);
    if (d < minDist) { minDist = d; bestIdx = i; bestT = t; }
  }
  const [x1, y1] = routeCoords[bestIdx], [x2, y2] = routeCoords[bestIdx + 1];
  return { bestIdx, lat: y1 + bestT * (y2 - y1), lng: x1 + bestT * (x2 - x1) };
}

function getRemainingDistance(lat, lng) {
  const np = nearestPointOnRoute(lat, lng);
  if (!np) return null;
  const [x2, y2] = routeCoords[np.bestIdx + 1];
  let remaining = haversineKm(np.lat, np.lng, y2, x2);
  for (let i = np.bestIdx + 1; i < routeCoords.length - 1; i++) {
    const [ax, ay] = routeCoords[i], [bx, by] = routeCoords[i+1];
    remaining += haversineKm(ay, ax, by, bx);
  }
  return remaining;
}

function walkForwardOnRoute(lat, lng, distanceKm) {
  if (distanceKm <= 0) return null;
  const np = nearestPointOnRoute(lat, lng);
  if (!np) return null;
  let curLat = np.lat, curLng = np.lng;
  let left = distanceKm;
  const bestIdx = np.bestIdx;
  for (let i = bestIdx; i < routeCoords.length - 1; i++) {
    const [nx, ny] = routeCoords[i + 1];
    const segDist = haversineKm(curLat, curLng, ny, nx);
    if (segDist >= left) {
      const frac = left / segDist;
      return [curLat + frac*(ny - curLat), curLng + frac*(nx - curLng)];
    }
    left -= segDist; curLat = ny; curLng = nx;
  }
  const last = routeCoords[routeCoords.length - 1];
  return [last[1], last[0]];
}

function formatETA(remainingKm, paceMinPerKm) {
  if (remainingKm === null) return null;
  if (remainingKm < 0.05) return '🏁 Finished';
  if (!paceMinPerKm) return null;
  const mins = Math.round(remainingKm * paceMinPerKm);
  return `~${mins < 1 ? '<1' : mins} min`;
}

function formatPace(paceMinPerKm) {
  const mins = Math.floor(paceMinPerKm);
  const secs = Math.round((paceMinPerKm - mins) * 60).toString().padStart(2, '0');
  return `${mins}:${secs}/km`;
}

function showEndedOverlay() {
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  releaseWakeLock();
  isJoined = false;
  sessionStorage.removeItem('rs_name');
  document.getElementById('endedOverlay').style.display = 'flex';
}

// ── FOLLOW ME ─────────────────────────────────────────────────────────────────

function toggleFollow() {
  followMe = !followMe;
  const btn = document.getElementById('centerBtn');
  btn.classList.toggle('active', followMe);
  btn.title = followMe ? 'Stop following me' : 'Follow my position';
}

// ── ERROR ─────────────────────────────────────────────────────────────────────

function showError(msg) {
  document.body.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;
      justify-content:center;height:100vh;padding:24px;text-align:center;
      font-family:Inter,sans-serif;gap:16px;">
      <div style="font-size:48px">⚠️</div>
      <h2>Session Not Found</h2>
      <p style="color:#6B7280;max-width:280px">${escapeHtml(msg)}</p>
      <a href="index.html" style="background:#FF6B35;color:white;
        padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">
        Create New Run
      </a>
    </div>
  `;
}

document.addEventListener('DOMContentLoaded', init);
