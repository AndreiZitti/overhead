// Geolocation module with Munich fallback.

const MUNICH = { lat: 48.183, lon: 11.539, alt: 0.52, name: 'Munich (default)' };

function toast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove('show'), 3000);
}

export async function getLocation() {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return { ...MUNICH };
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
      // Silent fallback — the browser may still be deciding.
      finish({ ...MUNICH });
    }, 8000);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const c = pos.coords;
        finish({
          lat: c.latitude,
          lon: c.longitude,
          alt: (c.altitude == null ? 0 : c.altitude / 1000),
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
