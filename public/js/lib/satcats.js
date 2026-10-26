/**
 * The satellite groups and what a name says about an object. No imports: the
 * OVERHEAD view needs these at load to draw its toggles, while sats.js pulls in
 * the SGP4 library (17 files) and is only fetched when satellite mode is used.
 */

/**
 * The toggles. `groups` are CelesTrak GROUP names, one snapshot file each
 * (the snapshot job in the website repo fetches exactly these). A satellite
 * belongs to the first category whose group lists it.
 */
export const CATEGORIES = [
  { key: 'stations', label: 'Stations', groups: ['stations'], colour: '#8fdc6a', on: true },
  { key: 'bright', label: 'Bright', groups: ['visual'], colour: '#f2b45a', on: false },
  { key: 'science', label: 'Weather & science', groups: ['weather', 'science'], colour: '#7fb2f0', on: false },
  { key: 'starlink', label: 'Starlink', groups: ['starlink'], colour: '#b39dfa', on: false },
];

/** What the object is, from its catalogue name alone. The name is all we have. */
export function kindOf(name) {
  const n = String(name || '').toUpperCase();
  if (/\bR\/B\b/.test(n)) return 'rocket body';
  if (/\bDEB\b/.test(n)) return 'debris';
  if (/^(ISS|CSS)\b/.test(n)) return 'station module';
  return 'satellite';
}
