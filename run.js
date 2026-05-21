/* run.js — live run page */

mapboxgl.accessToken = MAPBOX_TOKEN;
firebase.initializeApp(FIREBASE_CONFIG);
const db = firebase.database();

const COLORS = [
  '#FF6B35', '#10B981', '#3B82F6', '#8B5CF6',
  '#F59E0B', '#EC4899', '#14B8A6', '#F97316',
];

let userId = sessionStorage.getItem('rs_uid') || (() => {
  const id = Math.random().toString(36).slice(2, 11);
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

const STALE_MS       = 30_000;
const START_RADIUS_M = 50;

// ── INIT ──────────────────────────────────────────────────────────────────────

async function init() {
  // Warn if opened in Telegram's in-app browser (GPS won't work)
  if (window.TelegramWebviewProxy || /Telegram/i.test(navigator.userAgent)) {
    const banner = document.createElement('div');
    banner.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:9999;
      background:#229ED9;color:white;padding:12px 16px;text-align:center;
      font-family:Inter,sans-serif;font-size:14px;font-weight:600;line-height:1.4;`;
    banner.innerHTML = `GPS doesn't work in Telegram — <a href="${location.href}" target="_blank"
      style="color:white;text-decoration:underline">tap here to open in your browser</a>`;
    document.body.prepend(banner);
  }

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
    geolocate.trigger(); // show location dot immediately on load
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

  window.addEventListener('beforeunload', () => {
    if (isJoined) db.ref(`sessions/${sessionId}/participants/${userId}`).update({ active: false });
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
    if (!p.lat || !p.lng) return;
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
      if (isMe) myMarkerEl = el;
      const marker = new mapboxgl.Marker({ element: el })
        .setLngLat([p.lng, p.lat])
        .setPopup(new mapboxgl.Popup({ offset: 25, closeButton: false })
          .setText(isMe ? `${p.name} (You)` : p.name))
        .addTo(map);
      participantMarkers[id] = marker;
    }
    participantMarkers[id].getElement().style.opacity = opacity;

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
  // Container includes a direction cone above the circle for compass heading
  const container = document.createElement('div');
  container.style.cssText = `
    display:flex;flex-direction:column;align-items:center;
    width:40px;cursor:pointer;
    transform-origin:50% 33px;
  `;

  const cone = document.createElement('div');
  cone.className = 'bearing-cone';
  cone.style.cssText = `
    width:0;height:0;margin-bottom:3px;
    border-left:6px solid transparent;
    border-right:6px solid transparent;
    border-bottom:10px solid ${isMe ? '#FFD700' : color};
    opacity:0;transition:opacity .2s;
  `;

  const circle = document.createElement('div');
  circle.style.cssText = `
    width:40px;height:40px;border-radius:50%;
    background:${color};border:3px solid ${isMe ? '#FFD700' : 'white'};
    box-shadow:0 2px 8px rgba(0,0,0,.35);
    display:flex;align-items:center;justify-content:center;
    color:white;font-weight:700;font-size:15px;
    font-family:Inter,sans-serif;
    transition:opacity .3s;
  `;
  circle.textContent = name.charAt(0).toUpperCase();

  container.appendChild(cone);
  container.appendChild(circle);
  return container;
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

    const remaining  = (active && p.lat && p.lng) ? getRemainingDistance(p.lat, p.lng) : null;
    const notStarted = (active && p.lat && p.lng && routeCoords.length > 0)
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
      staleLine = `<span class="chip-stale">last seen ${lastSeenStr}${estM ? ` · est. ~${estM}m ahead` : ''}</span>`;
    }

    const iosBadge    = p.platform === 'ios' ? '<span class="ios-badge">iOS</span>' : '';
    const trailActive = trailVisible[id] || false;

    return `
      <div class="participant-chip ${active ? '' : 'inactive'} ${trailActive ? 'trail-on' : ''}"
           onclick="toggleTrail('${id}')" title="Tap to show/hide trail">
        <div class="chip-dot" style="background:${color}"></div>
        <div class="chip-info">
          <span class="chip-name">${p.name}${isMe ? ' (You)' : ''}${iosBadge}</span>
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

// ── JOIN / LEAVE ──────────────────────────────────────────────────────────────

async function showJoinModal() {
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
  startCompass(); // must be called within user gesture
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

  await db.ref(`sessions/${sessionId}/participants/${userId}`).update({
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
    err => console.warn('GPS error:', err),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );

  isJoined = true;
  const btn = document.getElementById('joinBtn');
  btn.textContent = '📍 Sharing';
  btn.classList.add('joined');
  btn.onclick = leaveRun;
}

async function pushLocation(lat, lng) {
  if (!isJoined) return;
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
  db.ref(`sessions/${sessionId}/participants/${userId}`).update({ active: false });
  sessionStorage.removeItem('rs_name');
  isJoined = false;
  const btn = document.getElementById('joinBtn');
  btn.textContent = '+ Join Run';
  btn.classList.remove('joined');
  btn.onclick = showJoinModal;
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
  // iOS gives webkitCompassHeading; Android gives alpha (0 = north, clockwise)
  const heading = e.webkitCompassHeading ?? (e.alpha !== null ? (360 - e.alpha) % 360 : null);
  if (heading === null || heading === undefined) return;
  myBearing = heading;
  if (myMarkerEl) {
    const cone = myMarkerEl.querySelector('.bearing-cone');
    if (cone) {
      cone.style.opacity = '1';
      myMarkerEl.style.transform = `rotate(${heading}deg)`;
    }
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

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function getRemainingDistance(lat, lng) {
  if (routeCoords.length < 2) return null;
  let minDist = Infinity, bestIdx = 0, bestT = 0;
  for (let i = 0; i < routeCoords.length - 1; i++) {
    const [x1, y1] = routeCoords[i], [x2, y2] = routeCoords[i + 1];
    const dx = x2 - x1, dy = y2 - y1, lenSq = dx*dx + dy*dy;
    const t = lenSq > 0 ? Math.max(0, Math.min(1, ((lng-x1)*dx + (lat-y1)*dy) / lenSq)) : 0;
    const d = Math.hypot(lng - (x1+t*dx), lat - (y1+t*dy));
    if (d < minDist) { minDist = d; bestIdx = i; bestT = t; }
  }
  const [x1, y1] = routeCoords[bestIdx], [x2, y2] = routeCoords[bestIdx + 1];
  let remaining = haversineKm(y1 + bestT*(y2-y1), x1 + bestT*(x2-x1), y2, x2);
  for (let i = bestIdx + 1; i < routeCoords.length - 1; i++) {
    const [ax, ay] = routeCoords[i], [bx, by] = routeCoords[i+1];
    remaining += haversineKm(ay, ax, by, bx);
  }
  return remaining;
}

function walkForwardOnRoute(lat, lng, distanceKm) {
  if (routeCoords.length < 2 || distanceKm <= 0) return null;
  let minDist = Infinity, bestIdx = 0, bestT = 0;
  for (let i = 0; i < routeCoords.length - 1; i++) {
    const [x1, y1] = routeCoords[i], [x2, y2] = routeCoords[i + 1];
    const dx = x2 - x1, dy = y2 - y1, lenSq = dx*dx + dy*dy;
    const t = lenSq > 0 ? Math.max(0, Math.min(1, ((lng-x1)*dx + (lat-y1)*dy) / lenSq)) : 0;
    const d = Math.hypot(lng - (x1+t*dx), lat - (y1+t*dy));
    if (d < minDist) { minDist = d; bestIdx = i; bestT = t; }
  }
  const [x1, y1] = routeCoords[bestIdx], [x2, y2] = routeCoords[bestIdx + 1];
  let curLat = y1 + bestT*(y2-y1), curLng = x1 + bestT*(x2-x1);
  let left = distanceKm;
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
      <p style="color:#6B7280;max-width:280px">${msg}</p>
      <a href="index.html" style="background:#FF6B35;color:white;
        padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">
        Create New Run
      </a>
    </div>
  `;
}

document.addEventListener('DOMContentLoaded', init);
