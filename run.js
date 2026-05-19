/* run.js — live run page */

mapboxgl.accessToken = MAPBOX_TOKEN;
firebase.initializeApp(FIREBASE_CONFIG);
const db = firebase.database();

const COLORS = [
  '#FF6B35', '#10B981', '#3B82F6', '#8B5CF6',
  '#F59E0B', '#EC4899', '#14B8A6', '#F97316',
];

// Persist user identity across page reloads within the same session
let userId = sessionStorage.getItem('rs_uid') || (() => {
  const id = Math.random().toString(36).slice(2, 11);
  sessionStorage.setItem('rs_uid', id);
  return id;
})();

let map;
let sessionId;
let sessionPassword = null;
let isCreator       = false;
let watchId         = null;
let isJoined        = false;
let followMe        = false;
let colorIndex      = 0;
let participantColors  = {};
let participantMarkers = {};

// ── INIT ──────────────────────────────────────────────────────────────────────

async function init() {
  sessionId = new URLSearchParams(location.search).get('s');
  console.log('[RunShare] init — sessionId:', sessionId);
  if (!sessionId) return showError('No session ID in link.');

  // Load session from Firebase immediately — don't wait for map
  let session;
  try {
    console.log('[RunShare] Fetching from Firebase...');
    const snap = await db.ref(`sessions/${sessionId}`).once('value');
    console.log('[RunShare] Snapshot exists:', snap.exists(), '| val:', snap.val());
    if (!snap.exists()) return showError('Session not found — the link may be invalid.');
    session = snap.val();
  } catch (err) {
    console.error('[RunShare] Firebase read error:', err);
    return showError('Could not connect to database: ' + err.message);
  }

  if (session.ended) return showEndedOverlay();

  sessionPassword = session.password || null;
  isCreator = session.creatorId === userId;

  // Update header immediately
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

  map.addControl(new mapboxgl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: false,
  }), 'top-right');

  map.on('load', () => {
    renderRoute(session.route);
    db.ref(`sessions/${sessionId}/participants`).on('value', onParticipantsSnapshot);
  });

  // Listen for run being ended by creator
  db.ref(`sessions/${sessionId}/ended`).on('value', snap => {
    if (snap.val() === true) showEndedOverlay();
  });

  // Re-join automatically if the user already had a name this session
  const savedName = sessionStorage.getItem('rs_name');
  if (savedName) startSharing(savedName);

  // Stop sharing if user closes or navigates away
  window.addEventListener('beforeunload', () => {
    if (isJoined) db.ref(`sessions/${sessionId}/participants/${userId}`).update({ active: false });
  });
}

// ── ROUTE ─────────────────────────────────────────────────────────────────────

function renderRoute(coordinates) {
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

  // Start / finish markers
  addStaticMarker(coordinates[0], '#10B981');
  if (JSON.stringify(coordinates[0]) !== JSON.stringify(coordinates.at(-1))) {
    addStaticMarker(coordinates.at(-1), '#EF4444');
  }
}

function addStaticMarker(lngLat, color) {
  const el  = document.createElement('div');
  el.style.cssText = `
    width:14px;height:14px;border-radius:50%;
    background:${color};border:3px solid white;
    box-shadow:0 2px 6px rgba(0,0,0,.4);
  `;
  new mapboxgl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
}

// ── PARTICIPANTS ──────────────────────────────────────────────────────────────

function onParticipantsSnapshot(snapshot) {
  const all  = snapshot.val() || {};
  const now  = Date.now();

  // Assign colors to new participants
  Object.keys(all).forEach(id => {
    if (!participantColors[id]) {
      participantColors[id] = COLORS[colorIndex++ % COLORS.length];
    }
  });

  // Update / create markers
  Object.entries(all).forEach(([id, p]) => {
    if (!p.lat || !p.lng) return;
    const isMe    = id === userId;
    const active  = now - (p.lastSeen || 0) < 120_000;
    const color   = participantColors[id];

    if (participantMarkers[id]) {
      participantMarkers[id].setLngLat([p.lng, p.lat]);
      participantMarkers[id].getElement().style.opacity = active ? '1' : '0.4';
    } else {
      const el     = makeRunnerEl(p.name, color, isMe);
      const marker = new mapboxgl.Marker({ element: el })
        .setLngLat([p.lng, p.lat])
        .setPopup(new mapboxgl.Popup({ offset: 25, closeButton: false })
          .setText(isMe ? `${p.name} (You)` : p.name))
        .addTo(map);
      participantMarkers[id] = marker;
    }

    if (isMe && followMe) {
      map.easeTo({ center: [p.lng, p.lat], duration: 500 });
    }
  });

  // Remove stale markers
  Object.keys(participantMarkers).forEach(id => {
    if (!all[id]) { participantMarkers[id].remove(); delete participantMarkers[id]; }
  });

  renderParticipantBar(all, now);
}

function makeRunnerEl(name, color, isMe) {
  const el = document.createElement('div');
  el.style.cssText = `
    width:40px;height:40px;border-radius:50%;
    background:${color};border:3px solid ${isMe ? '#FFD700' : 'white'};
    box-shadow:0 2px 8px rgba(0,0,0,.35);
    display:flex;align-items:center;justify-content:center;
    color:white;font-weight:700;font-size:15px;
    font-family:Inter,sans-serif;cursor:pointer;
    transition:opacity .3s;
  `;
  el.textContent = name.charAt(0).toUpperCase();
  return el;
}

function renderParticipantBar(all, now) {
  const chips    = document.getElementById('participantChips');
  const countEl  = document.getElementById('activeCount');
  const entries  = Object.entries(all);

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
    return `
      <div class="participant-chip ${active ? '' : 'inactive'}">
        <div class="chip-dot" style="background:${color}"></div>
        <span>${p.name}${isMe ? ' (You)' : ''}</span>
        ${!active ? '<span class="offline-badge">offline</span>' : ''}
      </div>
    `;
  }).join('');
}

// ── JOIN / LEAVE ──────────────────────────────────────────────────────────────

async function showJoinModal() {
  const modal = document.getElementById('joinModal');
  const nameInput = document.getElementById('joinName');

  // Lock to existing name if this user already joined before
  const snap = await db.ref(`sessions/${sessionId}/participants/${userId}`).once('value');
  if (snap.exists() && snap.val().name) {
    nameInput.value = snap.val().name;
    nameInput.readOnly = true;
    nameInput.style.cssText += ';background:var(--surface);color:var(--muted);cursor:not-allowed';
  } else {
    nameInput.readOnly = false;
    nameInput.value = '';
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

  // Check for duplicate name
  const snap = await db.ref(`sessions/${sessionId}/participants`).once('value');
  const participants = snap.val() || {};
  const nameTaken = Object.entries(participants).some(
    ([id, p]) => p.name?.toLowerCase() === name.toLowerCase() && id !== userId
  );
  if (nameTaken) {
    const nameErr = document.getElementById('nameError');
    nameErr.style.display = 'block';
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

async function startSharing(name) {
  sessionStorage.setItem('rs_name', name);

  // Register in Firebase
  await db.ref(`sessions/${sessionId}/participants/${userId}`).update({
    name,
    lat:      null,
    lng:      null,
    lastSeen: Date.now(),
    joinedAt: Date.now(),
    active:   true,
  });

  // Start GPS
  if (!navigator.geolocation) {
    alert('Your browser does not support location sharing.');
    return;
  }

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
  await db.ref(`sessions/${sessionId}/participants/${userId}`).update({
    lat, lng, lastSeen: Date.now(),
  });
}

function leaveRun() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  db.ref(`sessions/${sessionId}/participants/${userId}`).update({ active: false });
  sessionStorage.removeItem('rs_name');
  isJoined = false;

  const btn = document.getElementById('joinBtn');
  btn.textContent = '+ Join Run';
  btn.classList.remove('joined');
  btn.onclick = showJoinModal;
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
