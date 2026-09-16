/* util.js — helpers shared by the create and run pages */

// Session and user ids are the only thing protecting a run's live location data,
// so they must be unguessable. Math.random() is a predictable PRNG and its
// base-36 expansion is also variable-length, which silently produced short ids.
function randomId(bytes = 12) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}

// Anything that reaches innerHTML must go through this. Runner names come from
// other people's devices, so an unescaped name is stored XSS against everyone
// watching the run.
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// A degree of longitude is shorter than a degree of latitude everywhere except
// the equator, so lng/lat pairs cannot be treated as a flat plane. Scaling lng
// by cos(lat) makes planar distance comparisons correct away from the equator.
// Without this, nearest-segment snapping picks the wrong segment: harmless in
// Singapore (ratio 1.00), wrong by a factor of 1.6 in London.
function lngScale(lat) {
  return Math.cos(lat * Math.PI / 180);
}
