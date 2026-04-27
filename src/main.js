import { getLocation } from './geo.js';

console.log('orbitarium boot');
console.log('satellite.js loaded:', typeof window.satellite !== 'undefined');

const fmt = (n, d = 3) => Number(n).toFixed(d);
const fmtLatLon = (obs) =>
  `${fmt(Math.abs(obs.lat))}°${obs.lat >= 0 ? 'N' : 'S'} • ` +
  `${fmt(Math.abs(obs.lon))}°${obs.lon >= 0 ? 'E' : 'W'}`;

const observer = await getLocation();

const locNameEl = document.getElementById('locName');
const coordsEl = document.getElementById('coords');
if (locNameEl) locNameEl.textContent = observer.name;
if (coordsEl) coordsEl.textContent = fmtLatLon(observer);
