// What goes on the Europe map: mainland Europe from the Atlantic to the Urals, modern
// countries, no islands (DESIGN.md §2).

/** Countries whose provinces are on the map (ISO 3166-1 alpha-2; Kosovo is XK). */
export const INCLUDE = new Set(
  (
    'PT ES FR AD MC BE NL LU DE CH LI AT IT SM VA DK NO SE FI PL CZ SK HU SI HR BA RS XK ME AL MK ' +
    'GR BG RO MD UA BY LT LV EE RU TR'
  ).split(' '),
);

/** Only these Turkish provinces (Thrace); everything east of the Bosporus is left out. */
export const TURKEY_KEEP = new Set(['Edirne', 'Kirklareli', 'Kırklareli', 'Tekirdag', 'Tekirdağ', 'Istanbul', 'İstanbul']);
export const TURKEY_MAX_LON = 29.0;

/** Russian provinces whose label point is east of this are Asian (Tyumen, Kurgan, ...). */
export const RUSSIA_MAX_LABEL_LON = 62;
/** Nothing east of the Urals. */
export const MAX_LON = 61;

/** Start countries and their capitals (lon, lat). */
export const PLAYABLE: Array<{ id: string; name: string; capital: [number, number] }> = [
  { id: 'PT', name: 'Portugal', capital: [-9.14, 38.72] },
  { id: 'ES', name: 'Spain', capital: [-3.7, 40.42] },
  { id: 'FR', name: 'France', capital: [2.35, 48.86] },
  { id: 'DE', name: 'Germany', capital: [13.4, 52.52] },
  { id: 'IT', name: 'Italy', capital: [12.5, 41.9] },
  { id: 'PL', name: 'Poland', capital: [21.01, 52.23] },
  { id: 'UA', name: 'Ukraine', capital: [30.52, 50.45] },
  { id: 'RU', name: 'Russia', capital: [37.62, 55.75] },
  { id: 'BY', name: 'Belarus', capital: [27.56, 53.9] },
  { id: 'SE', name: 'Sweden', capital: [18.07, 59.33] },
  { id: 'NO', name: 'Norway', capital: [10.75, 59.91] },
  { id: 'FI', name: 'Finland', capital: [24.94, 60.17] },
  { id: 'RO', name: 'Romania', capital: [26.1, 44.43] },
  { id: 'GR', name: 'Greece', capital: [23.73, 37.98] },
  { id: 'AT', name: 'Austria', capital: [16.37, 48.21] },
  { id: 'CZ', name: 'Czech Republic', capital: [14.42, 50.09] },
  { id: 'HU', name: 'Hungary', capital: [19.04, 47.5] },
  { id: 'BG', name: 'Bulgaria', capital: [23.32, 42.7] },
];

/** Big industrial areas: the region containing each point gets the industry trait. */
export const INDUSTRY: Array<[string, number, number]> = [
  ['Ruhr', 7.0, 51.45],
  ['Rhine-Neckar', 8.47, 49.49],
  ['Stuttgart', 9.18, 48.78],
  ['Saxony', 12.92, 50.83],
  ['Upper Silesia', 19.02, 50.26],
  ['Ostrava', 18.29, 49.83],
  ['Lombardy', 9.19, 45.46],
  ['Piedmont', 7.69, 45.07],
  ['Nord', 3.06, 50.63],
  ['Lorraine', 6.18, 49.12],
  ['Rhône-Alpes', 4.84, 45.76],
  ['Catalonia', 2.17, 41.39],
  ['Basque Country', -2.93, 43.26],
  ['Gothenburg', 11.97, 57.71],
  ['Donbas', 37.8, 48.0],
  ['Dnipro', 35.04, 48.46],
  ['Kharkiv', 36.23, 49.99],
  ['Tula', 37.62, 54.19],
  ['Nizhny Novgorod', 44.0, 56.33],
  ['Saint Petersburg', 30.32, 59.94],
  ['Perm', 56.25, 58.01],
  ['Yekaterinburg', 60.6, 56.84],
  ['Chelyabinsk', 60.5, 55.3],
  ['Samara', 50.15, 53.2],
  ['Wallonia', 4.44, 50.41],
];

/** Oil fields: the region containing each point gets the oil trait. */
export const OIL: Array<[string, number, number]> = [
  ['Ploiești', 26.02, 44.94],
  ['Tatarstan (Almetyevsk)', 52.3, 54.9],
  ['Bashkortostan', 55.0, 54.4],
  ['Samara', 51.5, 53.0],
  ['Orenburg', 54.0, 52.0],
  ['Komi (Usinsk)', 57.5, 66.0],
  ['Grozny', 45.7, 43.3],
  ['Maykop', 40.1, 44.6],
  ['Emsland', 7.3, 52.6],
  ['Zala', 16.8, 46.6],
  ['Boryslav', 23.4, 49.3],
  ['Poltava', 34.5, 49.6],
];
