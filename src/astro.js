// Pure astronomy helpers ported verbatim from docs/reference/orbitarium-reference.html.
// No DOM, no globals other than `satellite` (vendor lib loaded as a classic script).

/**
 * Sun ECI direction unit vector.
 * @param {Date} date
 * @returns {{x:number,y:number,z:number}} Unit vector in ECI (dimensionless).
 * Source: reference lines 572-587.
 */
export function sunECI(date){
  const jd = (date.getTime()/86400000) + 2440587.5;
  const T = (jd - 2451545.0) / 36525;
  const L = ((280.46646 + 36000.76983*T + 0.0003032*T*T) % 360) * Math.PI/180;
  const M = ((357.52911 + 35999.05029*T - 0.0001537*T*T) % 360) * Math.PI/180;
  const C = (1.914602 - 0.004817*T - 0.000014*T*T)*Math.sin(M)
          + (0.019993 - 0.000101*T)*Math.sin(2*M)
          + 0.000289*Math.sin(3*M);
  const lambda = L + C*Math.PI/180;
  const eps = (23.439291 - 0.0130042*T) * Math.PI/180;
  return {
    x: Math.cos(lambda),
    y: Math.cos(eps)*Math.sin(lambda),
    z: Math.sin(eps)*Math.sin(lambda)
  };
}

/**
 * Moon ECI direction unit vector.
 * @param {Date} date
 * @returns {{x:number,y:number,z:number}} Unit vector in ECI (dimensionless).
 * Source: reference lines 590-606.
 */
export function moonECI(date){
  const jd = (date.getTime()/86400000) + 2440587.5;
  const T = (jd - 2451545.0) / 36525;
  const Lp = (218.316 + 481267.8813*T) * Math.PI/180;
  const M  = (134.963 + 477198.8676*T) * Math.PI/180;
  const Mp = (357.5291 + 35999.0503*T) * Math.PI/180;
  const F  = (93.272 + 483202.0175*T) * Math.PI/180;
  let lambda = Lp + (6.289*Math.sin(M) - 1.274*Math.sin(M-2*F) + 0.658*Math.sin(2*F)
                    - 0.186*Math.sin(Mp) - 0.059*Math.sin(2*M-2*F))*Math.PI/180;
  let beta = (5.128*Math.sin(F) + 0.281*Math.sin(M+F) - 0.278*Math.sin(F-M))*Math.PI/180;
  const eps = (23.439291 - 0.0130042*T) * Math.PI/180;
  // Ecliptic -> equatorial
  const x = Math.cos(beta)*Math.cos(lambda);
  const y = Math.cos(eps)*Math.cos(beta)*Math.sin(lambda) - Math.sin(eps)*Math.sin(beta);
  const z = Math.sin(eps)*Math.cos(beta)*Math.sin(lambda) + Math.cos(eps)*Math.sin(beta);
  return {x,y,z};
}

/**
 * Convert an ECI direction unit vector to topocentric look angles.
 * @param {{x:number,y:number,z:number}} dir ECI unit vector.
 * @param {{longitude:number,latitude:number,height:number}} observerGd Geodetic observer (rad, rad, km).
 * @param {number} gmst Greenwich mean sidereal time (rad).
 * @returns {{az:number,el:number,range:number}} Azimuth/elevation in rad, range in km.
 * Source: reference lines 609-616. Uses global `satellite` (vendor lib).
 */
export function eciDirToAzEl(dir, observerGd, gmst){
  // Build a fake "satellite" position at large radius along dir, then convert.
  const R = 1e9;
  const pos = { x: dir.x*R, y: dir.y*R, z: dir.z*R };
  const ecf = satellite.eciToEcf(pos, gmst);
  const look = satellite.ecfToLookAngles(observerGd, ecf);
  return { az: look.azimuth, el: look.elevation, range: look.rangeSat };
}

/**
 * Earth-shadow cylinder test: is a satellite sunlit?
 * @param {{x:number,y:number,z:number}} satEci Satellite ECI position (km).
 * @param {{x:number,y:number,z:number}} sunDir Sun ECI unit vector.
 * @returns {boolean} True if illuminated.
 * Source: reference lines 619-627.
 */
export function isSunlit(satEci, sunDir){
  const dot = satEci.x*sunDir.x + satEci.y*sunDir.y + satEci.z*sunDir.z;
  if (dot >= 0) return true; // on day side
  const px = satEci.x - dot*sunDir.x;
  const py = satEci.y - dot*sunDir.y;
  const pz = satEci.z - dot*sunDir.z;
  const perp = Math.sqrt(px*px + py*py + pz*pz);
  return perp > 6378.137; // Earth radius km — if perp distance > Re, sat clears the shadow
}

/**
 * Rough apparent magnitude estimate.
 * @param {{isStation:boolean,inVisual:boolean}} s Satellite metadata.
 * @param {number} rangeKm Slant range to observer (km).
 * @returns {number} Apparent magnitude.
 * Source: reference lines 673-678.
 */
export function estimateMag(s, rangeKm){
  const m0 = s.isStation ? -1.0       // ISS/CSS — very large structures
           : s.inVisual ? 2.0         // CelesTrak visual catalog — known bright
           : 4.5;                      // typical Starlink / generic LEO
  return m0 + 5 * Math.log10(rangeKm / 1000);
}

/**
 * Visibility tier classifier.
 * @param {{isStation:boolean}} s Satellite metadata.
 * @param {boolean} sunlit Output of isSunlit.
 * @param {boolean} observerDark True if sun altitude < -6°.
 * @param {number} mag Apparent magnitude (estimateMag).
 * @returns {'naked'|'binocular'|'telescope'|'daylight'|'shadow'}
 * Source: reference lines 686-693.
 */
export function tierOf(s, sunlit, observerDark, mag){
  if (!sunlit) return 'shadow';
  if (!observerDark) return 'daylight';
  if (s.isStation) return 'naked';
  if (mag <= 4.5) return 'naked';
  if (mag <= 7.5) return 'binocular';
  return 'telescope';
}
