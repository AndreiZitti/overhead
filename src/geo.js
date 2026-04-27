// Geolocation module with Munich fallback. Reverse-geocodes coords to a
// human-readable place name via BigDataCloud's free reverse-geocode API
// (no key required, CORS-enabled). Falls back to coord string on failure.

const MUNICH = { lat: 48.183, lon: 11.539, alt: 0.52, name: 'Munich, DE' };

function toast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove('show'), 3000);
}

async function reverseGeocode(lat, lon) {
  try {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    const place = j.city || j.locality || j.principalSubdivision || null;
    const cc = j.countryCode || '';
    if (!place) return null;
    return cc ? `${place}, ${cc}` : place;
  } catch {
    return null;
  }
}

export async function getLocation() {
  const coord = await getCoord();
  if (coord.name === MUNICH.name) return coord; // skip geocode for hardcoded fallback
  const name = await reverseGeocode(coord.lat, coord.lon);
  if (name) coord.name = name;
  return coord;
}

function getCoord() {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return Promise.resolve({ ...MUNICH });
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(val);
    };

    const timeoutId = setTimeout(() => {
      finish({ ...MUNICH });
    }, 8000);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const c = pos.coords;
        finish({
          lat: c.latitude,
          lon: c.longitude,
          alt: c.altitude == null ? 0 : c.altitude / 1000,
          name: 'your location',
        });
      },
      () => {
        toast('Location blocked — using Munich');
        finish({ ...MUNICH });
      },
      { enableHighAccuracy: false, timeout: 7000, maximumAge: 600000 }
    );
  });
}
