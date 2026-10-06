// Hardware presets and source naming shared by the emulators and the file formats.
window.BMD = window.BMD || {};

BMD.esc = function (s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
};

// Counts are typical values for each model. They are editable in ATEM Setup, and
// importing a file saved from the real switcher sets the product string exactly.
BMD.ATEM_MODELS = [
  { product: 'ATEM Mini',                     inputs: 4,  mes: 1, usks: 1, dsks: 1, auxes: 1,  mediaPlayers: 1, superSource: false },
  { product: 'ATEM Mini Pro',                 inputs: 4,  mes: 1, usks: 1, dsks: 1, auxes: 1,  mediaPlayers: 1, superSource: false },
  { product: 'ATEM Mini Pro ISO',             inputs: 4,  mes: 1, usks: 1, dsks: 1, auxes: 1,  mediaPlayers: 1, superSource: false },
  { product: 'ATEM Mini Extreme',             inputs: 8,  mes: 1, usks: 4, dsks: 2, auxes: 3,  mediaPlayers: 2, superSource: true },
  { product: 'ATEM Mini Extreme ISO',         inputs: 8,  mes: 1, usks: 4, dsks: 2, auxes: 3,  mediaPlayers: 2, superSource: true },
  { product: 'ATEM Television Studio HD',     inputs: 8,  mes: 1, usks: 1, dsks: 2, auxes: 1,  mediaPlayers: 2, superSource: false },
  { product: 'ATEM Television Studio HD8',    inputs: 8,  mes: 1, usks: 4, dsks: 2, auxes: 2,  mediaPlayers: 2, superSource: false },
  { product: 'ATEM Television Studio HD8 ISO',inputs: 8,  mes: 1, usks: 4, dsks: 2, auxes: 2,  mediaPlayers: 2, superSource: false },
  { product: 'ATEM 1 M/E Constellation HD',   inputs: 10, mes: 1, usks: 4, dsks: 2, auxes: 6,  mediaPlayers: 2, superSource: false },
  { product: 'ATEM 2 M/E Constellation HD',   inputs: 20, mes: 2, usks: 4, dsks: 2, auxes: 12, mediaPlayers: 4, superSource: true },
  { product: 'ATEM 4 M/E Constellation HD',   inputs: 40, mes: 4, usks: 4, dsks: 4, auxes: 24, mediaPlayers: 4, superSource: true },
  { product: 'ATEM 1 M/E Production Studio 4K', inputs: 10, mes: 1, usks: 4, dsks: 2, auxes: 3, mediaPlayers: 2, superSource: false },
  { product: 'ATEM 2 M/E Production Studio 4K', inputs: 20, mes: 2, usks: 4, dsks: 2, auxes: 6, mediaPlayers: 2, superSource: true },
];

BMD.VIDEOHUB_MODELS = [
  { model: 'Micro Videohub 16x16',        inputs: 16,  outputs: 16 },
  { model: 'Smart Videohub 12x12',        inputs: 12,  outputs: 12 },
  { model: 'Smart Videohub 20x20',        inputs: 20,  outputs: 20 },
  { model: 'Smart Videohub 40x40',        inputs: 40,  outputs: 40 },
  { model: 'Smart Videohub CleanSwitch 12x12', inputs: 12, outputs: 12 },
  { model: 'Videohub 10x10 12G',          inputs: 10,  outputs: 10 },
  { model: 'Videohub 20x20 12G',          inputs: 20,  outputs: 20 },
  { model: 'Videohub 40x40 12G',          inputs: 40,  outputs: 40 },
  { model: 'Videohub 80x80 12G',          inputs: 80,  outputs: 80 },
  { model: 'Videohub 120x120 12G',        inputs: 120, outputs: 120 },
  { model: 'Universal Videohub 72',       inputs: 72,  outputs: 72 },
  { model: 'Universal Videohub 288',      inputs: 288, outputs: 288 },
];

BMD.FRAME_RATES = [23.98, 24, 25, 29.97, 30, 50, 59.94, 60];
BMD.MACRO_SLOTS = 100;

// Every source the switcher buses can select. `key` is the name ATEM macros use,
// `id` is the numeric BMDSwitcherInputId used in the Settings/Inputs section.
BMD.atemSources = function (cfg) {
  const s = [{ key: 'Black', id: 0, long: 'Black', short: 'BLK', internal: true }];
  for (let i = 1; i <= cfg.inputs; i++) {
    s.push({ key: 'Camera' + i, id: i, long: 'Camera ' + i, short: 'CAM' + i });
  }
  s.push({ key: 'ColorBars', id: 1000, long: 'Color Bars', short: 'BARS', internal: true });
  s.push({ key: 'Color1', id: 2001, long: 'Color 1', short: 'COL1', internal: true });
  s.push({ key: 'Color2', id: 2002, long: 'Color 2', short: 'COL2', internal: true });
  for (let m = 1; m <= cfg.mediaPlayers; m++) {
    s.push({ key: 'MediaPlayer' + m, id: 3000 + m * 10, long: 'Media Player ' + m, short: 'MP' + m, internal: true, mp: m - 1 });
  }
  if (cfg.superSource) s.push({ key: 'SuperSource', id: 6000, long: 'Super Source', short: 'SSRC', internal: true });
  return s;
};

// Aux outputs can also take the M/E 1 outputs and clean feeds.
BMD.atemAuxSources = function (cfg) {
  return BMD.atemSources(cfg).concat([
    { key: 'CleanFeed1', id: 7001, long: 'Clean Feed 1', short: 'CFD1', internal: true },
    { key: 'CleanFeed2', id: 7002, long: 'Clean Feed 2', short: 'CFD2', internal: true },
    { key: 'Preview', id: 10011, long: 'Preview', short: 'PVW', internal: true },
    { key: 'Program', id: 10010, long: 'Program', short: 'PGM', internal: true },
  ]);
};

BMD.defaultProject = function () {
  const m = BMD.ATEM_MODELS[1];
  const vh = BMD.VIDEOHUB_MODELS[1];
  return {
    format: 'bmd-show',
    version: 1,
    name: 'Untitled Show',
    atem: {
      product: m.product,
      inputs: m.inputs, mes: m.mes, usks: m.usks, dsks: m.dsks, auxes: m.auxes,
      mediaPlayers: m.mediaPlayers, superSource: m.superSource,
      fps: 30,
      labels: {},           // { [numericId]: { long, short } } overrides only
      macros: new Array(BMD.MACRO_SLOTS).fill(null),
      template: null,       // XML text saved from the real switcher, if imported
      templateName: null,
    },
    videohub: BMD.newVideohub(vh.model, vh.inputs, vh.outputs),
  };
};

BMD.newVideohub = function (model, inputs, outputs) {
  return {
    model,
    inputs,
    outputs,
    inputLabels: Array.from({ length: inputs }, (_, i) => 'Input ' + (i + 1)),
    outputLabels: Array.from({ length: outputs }, (_, i) => 'Output ' + (i + 1)),
    routing: Array.from({ length: outputs }, (_, i) => i % inputs),
    presets: [],
  };
};
