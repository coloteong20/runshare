/* create.js — route creation page */

mapboxgl.accessToken = MAPBOX_TOKEN;
firebase.initializeApp(FIREBASE_CONFIG);
const db = firebase.database();

const creatorId = sessionStorage.getItem('rs_uid') || (() => {
  const id = Math.random().toString(36).slice(2, 11);
  sessionStorage.setItem('rs_uid', id);
  return id;
})();

let map;
let waypoints       = [];
let markers         = [];
let routeCoords     = [];
let routeDistKm     = 0;
let isSaving        = false;
let elevationVisible = false;

// ── INIT ──────────────────────────────────────────────────────────────────────

function initMap() {
  map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/streets-v12',
    center: [103.8198, 1.3521],
    zoom: 13,
  });

  // Try to center on user's current location
  navigator.geolocation?.getCurrentPosition(pos => {
    map.setCenter([pos.coords.longitude, pos.coords.latitude]);
  });

  // Search box
  const geocoder = new MapboxGeocoder({
    accessToken: MAPBOX_TOKEN,
    mapboxgl,
    placeholder: 'Search for a location…',
    marker: false,
  });
  map.addControl(geocoder, 'top-left');

  // Locate me button
  map.addControl(new mapboxgl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: false,
  }), 'top-right');

  map.on('load', () => {
    // Route source + layers
    map.addSource('route', {
      type: 'geojson',
      data: emptyGeoJSON(),
    });
    map.addLayer({
      id: 'route-casing',
      type: 'line',
      source: 'route',
      paint: { 'line-color': 'white', 'line-width': 7, 'line-opacity': .7 },
    });
    map.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#FF6B35', 'line-width': 4 },
    });

    // Terrain source for elevation queries (no visual exaggeration)
    map.addSource('mapbox-dem', {
      type: 'raster-dem',
      url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
      tileSize: 512,
      maxzoom: 14,
    });
    map.setTerrain({ source: 'mapbox-dem', exaggeration: 0.0001 });

    // Elevation overlay — colored segments drawn over route-casing
    map.addSource('route-elevation', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    map.addLayer({
      id: 'route-elevation-layer',
      type: 'line', source: 'route-elevation',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 4 },
    });

    map.on('click', onMapClick);
  });
}

// ── WAYPOINTS ─────────────────────────────────────────────────────────────────

async function onMapClick(e) {
  const { lng, lat } = e.lngLat;
  waypoints.push([lng, lat]);

  const el = makeWaypointEl(waypoints.length === 1 ? 'start' : 'mid');
  const marker = new mapboxgl.Marker({ element: el, draggable: true })
    .setLngLat([lng, lat])
    .addTo(map);

  marker.on('dragend', async () => {
    const idx = markers.indexOf(marker);
    const { lng: lx, lat: ly } = marker.getLngLat();
    waypoints[idx] = [lx, ly];
    await refreshRoute();
  });

  markers.push(marker);
  await refreshRoute();
  updatePanel();
}

function makeWaypointEl(type) {
  const el = document.createElement('div');
  const colors = { start: '#10B981', mid: '#FF6B35', end: '#EF4444' };
  el.style.cssText = `
    width:18px;height:18px;border-radius:50%;
    background:${colors[type]};border:3px solid white;
    box-shadow:0 2px 6px rgba(0,0,0,.4);cursor:pointer;
  `;
  return el;
}

async function refreshRoute() {
  if (waypoints.length < 2) {
    setRouteOnMap([]);
    routeDistKm = 0;
    updateDistDisplay();
    return;
  }

  const result = await fetchDirections(waypoints);
  if (result) {
    routeCoords = result.coordinates;
    routeDistKm = result.distanceKm;
  } else {
    // Fallback: straight lines between waypoints
    routeCoords = waypoints;
    routeDistKm = straightLineDistance(waypoints);
    showToast('Could not snap to roads — using straight lines');
  }
  setRouteOnMap(routeCoords);
  if (elevationVisible) clearElevation();
  updateDistDisplay();
}

async function fetchDirections(points) {
  const coords = points.map(p => p.join(',')).join(';');
  const url = `https://api.mapbox.com/directions/v5/mapbox/walking/${coords}` +
    `?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;
  try {
    const res  = await fetch(url);
    const data = await res.json();
    if (data.routes?.[0]) {
      return {
        coordinates: data.routes[0].geometry.coordinates,
        distanceKm:  data.routes[0].distance / 1000,
      };
    }
  } catch (err) {
    console.error('Directions error:', err);
  }
  return null;
}

function setRouteOnMap(coordinates) {
  map.getSource('route').setData({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates },
  });
}

// ── CONTROLS ──────────────────────────────────────────────────────────────────

async function undoLastMarker() {
  if (!waypoints.length) return;
  waypoints.pop();
  markers.pop()?.remove();
  await refreshRoute();
  updatePanel();
}

async function closeLoop() {
  if (waypoints.length < 2) return;
  waypoints.push([...waypoints[0]]);

  const el = makeWaypointEl('end');
  new mapboxgl.Marker({ element: el }).setLngLat(waypoints[0]).addTo(map);

  await refreshRoute();
  updatePanel();
}

function clearRoute() {
  waypoints   = [];
  routeCoords = [];
  routeDistKm = 0;
  markers.forEach(m => m.remove());
  markers = [];
  setRouteOnMap([]);
  clearElevation();
  updatePanel();
  updateDistDisplay();
}

// ── ELEVATION ─────────────────────────────────────────────────────────────────

async function toggleElevation() {
  if (elevationVisible) {
    clearElevation();
    return;
  }
  const btn = document.getElementById('elevationBtn');
  btn.textContent = 'Loading…';
  btn.disabled    = true;
  await updateElevationDisplay();
  btn.disabled    = false;
}

function clearElevation() {
  if (map.getSource('route-elevation')) {
    map.getSource('route-elevation').setData({ type: 'FeatureCollection', features: [] });
  }
  elevationVisible = false;
  document.getElementById('elevationBtn').textContent = '⛰ Elevation';
  document.getElementById('climbVal').textContent = '—';
}

async function updateElevationDisplay() {
  if (routeCoords.length < 2) return;

  // Wait for terrain tiles to fully load
  await new Promise(resolve => {
    if (map.areTilesLoaded()) return resolve();
    map.once('idle', resolve);
  });

  const step    = Math.max(1, Math.floor(routeCoords.length / 150));
  const samples = routeCoords.filter((_, i) => i % step === 0);
  if (samples[samples.length - 1] !== routeCoords[routeCoords.length - 1]) {
    samples.push(routeCoords[routeCoords.length - 1]);
  }

  const pts = samples.map(([lng, lat]) => ({
    lng, lat, elev: map.queryTerrainElevation([lng, lat]) ?? 0,
  }));

  const features = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p1 = pts[i], p2 = pts[i + 1];
    const distM = haversineKm(p1.lat, p1.lng, p2.lat, p2.lng) * 1000;
    const slope = distM > 0 ? ((p2.elev - p1.elev) / distM) * 100 : 0;
    features.push({
      type: 'Feature',
      properties: { color: slopeColor(slope) },
      geometry: { type: 'LineString', coordinates: [[p1.lng, p1.lat], [p2.lng, p2.lat]] },
    });
  }

  map.getSource('route-elevation').setData({ type: 'FeatureCollection', features });
  elevationVisible = true;
  document.getElementById('elevationBtn').textContent = '⛰ Hide';

  const totalClimb = pts.reduce((sum, p, i) => {
    if (i === 0) return 0;
    const rise = p.elev - pts[i - 1].elev;
    return sum + (rise > 0 ? rise : 0);
  }, 0);
  document.getElementById('climbVal').textContent = `+${Math.round(totalClimb)}m`;
}

function slopeColor(slope) {
  if (slope > 8)  return '#EF4444'; // very steep
  if (slope > 5)  return '#F97316'; // steep
  if (slope > 2)  return '#F59E0B'; // gentle uphill
  if (slope > -2) return '#10B981'; // flat
  return '#3B82F6';                 // downhill
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── PANEL UI ──────────────────────────────────────────────────────────────────

function updatePanel() {
  const n = waypoints.length;
  const stats    = document.getElementById('routeStats');
  const form     = document.getElementById('createForm');
  const instr    = document.getElementById('instruction');

  document.getElementById('waypointCount').textContent = n;
  stats.style.display  = n > 0  ? 'flex' : 'none';
  form.style.display   = n >= 2 ? 'flex' : 'none';

  instr.textContent = n === 0
    ? 'Click the map to add your starting point'
    : n === 1
    ? 'Click again to add more waypoints along the route'
    : 'Keep adding points, or name and create your run below';

  // Hide instruction row once the form is visible — saves vertical space on mobile
  document.querySelector('.instruction').style.display = n >= 2 ? 'none' : 'flex';
}

function updateDistDisplay() {
  document.getElementById('distanceVal').textContent = routeDistKm.toFixed(1);
}

// ── CREATE SESSION ────────────────────────────────────────────────────────────

async function createSession() {
  if (waypoints.length < 2) { showToast('Add at least 2 points on the map first'); return; }
  if (routeCoords.length < 2) routeCoords = waypoints; // last-resort fallback
  if (isSaving) return;

  const name = document.getElementById('sessionName').value.trim() || 'Group Run';
  isSaving   = true;

  const btn = document.getElementById('createBtn');
  btn.textContent = 'Creating…';
  btn.disabled    = true;

  const id = Math.random().toString(36).slice(2, 11);

  const password = document.getElementById('sessionPassword').value.trim();
  const payload = {
    name,
    createdAt:  Date.now(),
    distanceKm: parseFloat(routeDistKm.toFixed(2)),
    route:      routeCoords,
    waypoints,
    creatorId,
    ...(password && { password }),
  };

  try {
    console.log('[RunShare] Saving session', id, 'to Firebase...');
    await db.ref(`sessions/${id}`).set(payload);
    console.log('[RunShare] Save SUCCESS — session id:', id);
    saveToHistory({ id, name, distanceKm: payload.distanceKm, createdAt: payload.createdAt });
    showShareModal(id);
  } catch (err) {
    console.error('[RunShare] Save FAILED:', err);
    alert('Could not save session: ' + err.message);
  }

  isSaving        = false;
  btn.textContent = 'Create Run & Get Link →';
  btn.disabled    = false;
}

// ── HISTORY ───────────────────────────────────────────────────────────────────

function saveToHistory(entry) {
  let h = JSON.parse(localStorage.getItem('runshare_history') || '[]');
  h = [entry, ...h].slice(0, 20);
  localStorage.setItem('runshare_history', JSON.stringify(h));
}

function toggleHistory() {
  const panel = document.getElementById('historyPanel');
  const opening = !panel.classList.contains('open');
  if (opening) renderHistory();
  panel.classList.toggle('open', opening);
}

function renderHistory() {
  const h    = JSON.parse(localStorage.getItem('runshare_history') || '[]');
  const list = document.getElementById('historyList');
  if (!h.length) {
    list.innerHTML = '<div class="empty-state">No runs yet — create your first one!</div>';
    return;
  }
  list.innerHTML = h.map(s => `
    <div class="history-item" onclick="location.href='run.html?s=${s.id}'">
      <div class="history-item-name">${s.name}</div>
      <div class="history-item-meta">${s.distanceKm.toFixed(1)} km &middot; ${new Date(s.createdAt).toLocaleDateString()}</div>
    </div>
  `).join('');
}

// ── SHARE MODAL ───────────────────────────────────────────────────────────────

let pendingSessionId = '';

function showShareModal(id) {
  pendingSessionId = id;
  const base = location.href.replace(/index(\.html)?$/, '').replace(/\?.*$/, '');
  const link = `${base}run?s=${id}`;
  document.getElementById('shareLink').value = link;
  document.getElementById('shareModal').style.display = 'flex';
}

function copyLink() {
  const input = document.getElementById('shareLink');
  const text = input.value;
  const btn = document.getElementById('copyBtn');
  const done = () => { btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = 'Copy', 2000); };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => { input.select(); document.execCommand('copy'); done(); });
  } else {
    input.select(); input.setSelectionRange(0, 99999); document.execCommand('copy'); done();
  }
}

function closeModal() {
  document.getElementById('shareModal').style.display = 'none';
}

function goToRun() {
  const link = document.getElementById('shareLink').value;
  if (link) location.href = link + '&join=1';
}

// ── BOOT ──────────────────────────────────────────────────────────────────────

function emptyGeoJSON() {
  return { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } };
}

function straightLineDistance(points) {
  let dist = 0;
  for (let i = 1; i < points.length; i++) {
    const [lng1, lat1] = points[i - 1], [lng2, lat2] = points[i];
    const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
    dist += R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  return dist;
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.opacity = '1';
  setTimeout(() => t.style.opacity = '0', 3000);
}

function togglePanel() {
  document.querySelector('.bottom-panel').classList.toggle('collapsed');
}

document.addEventListener('DOMContentLoaded', initMap);
