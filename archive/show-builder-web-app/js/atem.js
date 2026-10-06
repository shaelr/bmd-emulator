// ATEM switcher emulator, macro recorder and macro player.
window.BMD = window.BMD || {};

BMD.Atem = (function () {
  let app, root;
  let rt;                 // live emulator state (not saved in the project)
  let meSel = 0;          // M/E shown on the panel
  let slot = 0;           // selected macro slot
  let selOp = -1;         // selected op in the macro editor
  let recording = false;
  let player = null;      // { slot, index, waiting, stopped, wake }
  let rafId = 0;

  const esc = BMD.esc;
  const $ = (sel) => root.querySelector(sel);
  const cfg = () => app.project.atem;
  const int = (v, d = 0) => { const n = parseInt(v, 10); return isNaN(n) ? d : n; };
  const bool = (v) => String(v).toLowerCase() === 'true';
  const B = (b) => (b ? 'True' : 'False');
  const framesToMs = (f) => (f / cfg().fps) * 1000;
  const STYLES = ['Mix', 'Dip', 'Wipe'];

  function srcByKey(key) { return BMD.atemAuxSources(cfg()).find((s) => s.key === key); }
  function labelOf(key) {
    const s = srcByKey(key);
    if (!s) return { long: key || '?', short: key || '?' };
    const o = cfg().labels[s.id] || {};
    return { long: o.long || s.long, short: o.short || s.short };
  }

  // ---------------------------------------------------------------- runtime

  function resetRuntime() {
    const c = cfg();
    rt = {
      me: Array.from({ length: c.mes }, () => ({
        pgm: 'Camera1', pvw: c.inputs > 1 ? 'Camera2' : 'Black',
        style: 'Mix', rate: { Mix: 30, Dip: 30, Wipe: 30 }, trans: null,
        ftb: { on: false, rate: 30, anim: null },
        usk: new Array(c.usks).fill(false),
      })),
      dsk: Array.from({ length: c.dsks }, () => ({ onAir: false, tie: false, rate: 30, anim: null })),
      aux: new Array(c.auxes).fill('Program'),
      mp: new Array(c.mediaPlayers).fill(0),
    };
    meSel = Math.min(meSel, c.mes - 1);
  }

  function anim(from, to, frames) {
    return { from, to, start: performance.now(), dur: framesToMs(frames) };
  }

  function swapBuses(m) { const p = m.pgm; m.pgm = m.pvw; m.pvw = p; }

  // Applies one macro op to the emulator. Returns false for ops it can't simulate.
  function apply(op) {
    const a = op.attrs || {};
    const mi = int(a.mixEffectBlockIndex);
    const m = rt.me[mi];
    switch (op.id) {
      case 'ProgramInput': if (m) m.pgm = a.input; break;
      case 'PreviewInput': if (m) m.pvw = a.input; break;
      case 'CutTransition':
        if (m && !m.trans) {
          swapBuses(m);
          if (mi === 0) rt.dsk.forEach((d) => { if (d.tie) { d.onAir = !d.onAir; d.anim = null; } });
        }
        break;
      case 'AutoTransition':
        if (m && !m.trans) {
          const frames = m.rate[m.style] ?? 30;
          m.trans = Object.assign(anim(0, 1, frames), { style: m.style });
          if (mi === 0) rt.dsk.forEach((d) => { if (d.tie) d.anim = anim(d.onAir ? 1 : 0, d.onAir ? 0 : 1, frames); });
        }
        break;
      case 'TransitionStyle': if (m) m.style = a.style; break;
      case 'TransitionMixRate': if (m) m.rate.Mix = int(a.rate, 30); break;
      case 'TransitionDipRate': if (m) m.rate.Dip = int(a.rate, 30); break;
      case 'TransitionWipeRate': if (m) m.rate.Wipe = int(a.rate, 30); break;
      case 'FadeToBlackAuto':
        if (m && !m.ftb.anim) m.ftb.anim = anim(m.ftb.on ? 1 : 0, m.ftb.on ? 0 : 1, m.ftb.rate);
        break;
      case 'KeyOnAir': if (m) m.usk[int(a.keyIndex)] = bool(a.onAir); break;
      case 'DownstreamKeyOnAir': {
        const d = rt.dsk[int(a.keyIndex)];
        if (d) { d.onAir = bool(a.onAir); d.anim = null; }
        break;
      }
      case 'DownstreamKeyTie': { const d = rt.dsk[int(a.keyIndex)]; if (d) d.tie = bool(a.tie); break; }
      case 'DownstreamKeyAutoTransition': {
        const d = rt.dsk[int(a.keyIndex)];
        if (d && !d.anim) d.anim = anim(d.onAir ? 1 : 0, d.onAir ? 0 : 1, d.rate);
        break;
      }
      case 'AuxiliaryInput': if (int(a.auxiliaryIndex) < rt.aux.length) rt.aux[int(a.auxiliaryIndex)] = a.input; break;
      case 'MediaPlayerSourceStillIndex': if (int(a.mediaPlayer) < rt.mp.length) rt.mp[int(a.mediaPlayer)] = int(a.index); break;
      default: return false;
    }
    kick();
    return true;
  }

  // Advances running transitions; returns true while anything is still moving.
  function step(now) {
    let active = false;
    const done = (an) => now - an.start >= an.dur;
    rt.me.forEach((m) => {
      if (m.trans) { if (done(m.trans)) { m.trans = null; swapBuses(m); } else active = true; }
      if (m.ftb.anim) { if (done(m.ftb.anim)) { m.ftb.on = m.ftb.anim.to === 1; m.ftb.anim = null; } else active = true; }
    });
    rt.dsk.forEach((d) => {
      if (d.anim) { if (done(d.anim)) { d.onAir = d.anim.to === 1; d.anim = null; } else active = true; }
    });
    return active;
  }

  function progress(an, now) {
    if (!an) return null;
    return an.dur <= 0 ? 1 : Math.min(1, Math.max(0, (now - an.start) / an.dur));
  }
  function level(an, steady, now) {
    if (!an) return steady ? 1 : 0;
    const p = progress(an, now);
    return an.from + (an.to - an.from) * p;
  }

  function kick() { if (!rafId) rafId = requestAnimationFrame(loop); }
  function loop(now) {
    rafId = 0;
    const active = step(now);
    renderLive(now);
    if (active) kick();
  }

  // ---------------------------------------------------------------- user actions

  function exec(op) {
    if (recording) recordOp(op);
    apply(op);
    renderLive(performance.now());
  }

  const meAttr = () => ({ mixEffectBlockIndex: String(meSel) });
  const actions = {
    pgm: (key) => exec({ id: 'ProgramInput', attrs: { ...meAttr(), input: key } }),
    pvw: (key) => exec({ id: 'PreviewInput', attrs: { ...meAttr(), input: key } }),
    cut: () => exec({ id: 'CutTransition', attrs: meAttr() }),
    auto: () => exec({ id: 'AutoTransition', attrs: meAttr() }),
    ftb: () => exec({ id: 'FadeToBlackAuto', attrs: meAttr() }),
    style: (style) => exec({ id: 'TransitionStyle', attrs: { ...meAttr(), style } }),
    rate: (style, rate) => exec({ id: `Transition${style}Rate`, attrs: { ...meAttr(), rate: String(rate) } }),
    usk: (k) => exec({ id: 'KeyOnAir', attrs: { ...meAttr(), keyIndex: String(k), onAir: B(!rt.me[meSel].usk[k]) } }),
    dskTie: (k) => exec({ id: 'DownstreamKeyTie', attrs: { keyIndex: String(k), tie: B(!rt.dsk[k].tie) } }),
    dskOnAir: (k) => exec({ id: 'DownstreamKeyOnAir', attrs: { keyIndex: String(k), onAir: B(!rt.dsk[k].onAir) } }),
    dskAuto: (k) => exec({ id: 'DownstreamKeyAutoTransition', attrs: { keyIndex: String(k) } }),
    aux: (i, key) => exec({ id: 'AuxiliaryInput', attrs: { auxiliaryIndex: String(i), input: key } }),
    still: (i, idx) => exec({ id: 'MediaPlayerSourceStillIndex', attrs: { mediaPlayer: String(i), index: String(idx) } }),
  };

  // ---------------------------------------------------------------- macros

  function macro() { return cfg().macros[slot]; }

  function ensureMacro() {
    if (!cfg().macros[slot]) cfg().macros[slot] = { name: `Macro ${slot + 1}`, description: '', ops: [] };
    return cfg().macros[slot];
  }

  function insertOp(op) {
    const m = ensureMacro();
    const at = selOp >= 0 && selOp < m.ops.length ? selOp + 1 : m.ops.length;
    m.ops.splice(at, 0, { id: op.id, attrs: { ...op.attrs } });
    selOp = at;
    app.save();
    renderSlots();
    renderMacroEditor();
    const row = root.querySelector(`.op[data-i="${at}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }
  function recordOp(op) { insertOp(op); }

  function startRecording() {
    stopPlayer();
    ensureMacro();
    recording = true;
    renderSlots();
    renderMacroEditor();
  }
  function stopRecording() { recording = false; renderSlots(); renderMacroEditor(); }

  function selectSlot(i) {
    if (recording && i !== slot) stopRecording();
    slot = i;
    selOp = -1;
    renderSlots();
    renderMacroEditor();
  }

  async function run(i) {
    const m = cfg().macros[i];
    if (!m || !m.ops.length) return;
    if (recording) stopRecording();
    stopPlayer();
    const p = { slot: i, index: -1, waiting: false, stopped: false, wake: null };
    player = p;
    renderSlots();
    renderMacroEditor();
    const sleep = (ms) => new Promise((res) => {
      const t = setTimeout(res, ms);
      p.wake = () => { clearTimeout(t); res(); };
    });
    const userWait = () => new Promise((res) => { p.waiting = true; p.wake = res; renderPlayerStatus(); });
    for (let k = 0; k < m.ops.length && !p.stopped; k++) {
      p.index = k;
      markRunningOp();
      const op = m.ops[k];
      if (op.id === 'MacroSleep') await sleep(framesToMs(int(op.attrs.frames)));
      else if (op.id === 'MacroUserWait') { await userWait(); p.waiting = false; }
      else { apply(op); renderLive(performance.now()); }
    }
    if (player === p) player = null;
    renderSlots();
    renderMacroEditor();
  }
  function stopPlayer() {
    if (!player) return;
    player.stopped = true;
    if (player.wake) player.wake();
    player = null;
  }
  function continuePlayer() {
    if (player && player.waiting) { player.waiting = false; player.wake(); renderPlayerStatus(); }
  }

  function describe(op) {
    const a = op.attrs || {};
    const me = a.mixEffectBlockIndex !== undefined && cfg().mes > 1 ? `M/E ${int(a.mixEffectBlockIndex) + 1} · ` : '';
    const src = (k) => esc(labelOf(k).short);
    const onoff = (v) => (bool(v) ? '<b>ON</b>' : 'OFF');
    switch (op.id) {
      case 'ProgramInput': return `${me}<span class="k pgm">PGM</span> ${src(a.input)}`;
      case 'PreviewInput': return `${me}<span class="k pvw">PVW</span> ${src(a.input)}`;
      case 'CutTransition': return `${me}<span class="k">CUT</span>`;
      case 'AutoTransition': return `${me}<span class="k">AUTO</span>`;
      case 'TransitionStyle': return `${me}Transition style: ${esc(a.style)}`;
      case 'TransitionMixRate': return `${me}Mix rate: ${esc(a.rate)} frames`;
      case 'TransitionDipRate': return `${me}Dip rate: ${esc(a.rate)} frames`;
      case 'TransitionWipeRate': return `${me}Wipe rate: ${esc(a.rate)} frames`;
      case 'FadeToBlackAuto': return `${me}<span class="k">FTB</span>`;
      case 'KeyOnAir': return `${me}Key ${int(a.keyIndex) + 1} on air: ${onoff(a.onAir)}`;
      case 'DownstreamKeyOnAir': return `DSK ${int(a.keyIndex) + 1} on air: ${onoff(a.onAir)}`;
      case 'DownstreamKeyTie': return `DSK ${int(a.keyIndex) + 1} tie: ${onoff(a.tie)}`;
      case 'DownstreamKeyAutoTransition': return `DSK ${int(a.keyIndex) + 1} <span class="k">AUTO</span>`;
      case 'AuxiliaryInput': return `Aux ${int(a.auxiliaryIndex) + 1} → ${src(a.input)}`;
      case 'MediaPlayerSourceStillIndex': return `Media player ${int(a.mediaPlayer) + 1} → still ${int(a.index) + 1}`;
      case 'MacroSleep': return `<span class="k wait">PAUSE</span> ${int(a.frames)} frames <span class="dim">(${(int(a.frames) / cfg().fps).toFixed(2)} s)</span>`;
      case 'MacroUserWait': return '<span class="k wait">WAIT</span> for operator to continue';
      default:
        return `<span class="dim" title="Kept unchanged in the export, but not simulated here">${esc(op.id)} ` +
          Object.entries(a).map(([k, v]) => `${esc(k)}=${esc(v)}`).join(' ') + '</span>';
    }
  }

  function macroDuration(m) {
    return m.ops.reduce((t, o) => t + (o.id === 'MacroSleep' ? int(o.attrs.frames) : 0), 0) / cfg().fps;
  }

  // ---------------------------------------------------------------- rendering

  function visual(key) {
    if (key === 'Black') return { bg: '#000' };
    if (key === 'ColorBars') {
      const c = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
      return { bg: `linear-gradient(90deg, ${c.map((x, i) => `${x} ${(i * 100) / 7}% ${((i + 1) * 100) / 7}%`).join(', ')})` };
    }
    if (key === 'Color1') return { bg: '#3a2a7a' };
    if (key === 'Color2') return { bg: '#7a4a1a' };
    if (/^MediaPlayer\d+$/.test(key)) {
      const n = int(key.slice(11)) - 1;
      return { bg: 'repeating-linear-gradient(135deg, #2b3550 0 14px, #232b42 14px 28px)', extra: `Still ${(rt.mp[n] ?? 0) + 1}` };
    }
    if (key === 'SuperSource') return { bg: 'linear-gradient(90deg,#2d4f6b 0 49.5%,#111 49.5% 50.5%,#5a2d6b 50.5%)' };
    const cam = /^Camera(\d+)$/.exec(key || '');
    if (cam) return { bg: `hsl(${((int(cam[1]) - 1) * 47) % 360} 38% 30%)` };
    return { bg: '#222' };
  }

  function paintLayer(el, key) {
    const v = visual(key);
    el.style.background = v.bg;
    el.querySelector('.cap').textContent = key === 'Black' ? '' : labelOf(key).long;
    el.querySelector('.sub').textContent = v.extra || '';
  }

  function renderLive(now) {
    if (!root || !rt) return;
    const m = rt.me[meSel];
    if (!m) return;

    // Preview monitor
    paintLayer($('#monPvw .la'), m.pvw);

    // Program monitor: base layer, incoming layer, dip, keys, FTB
    const pgm = $('#monPgm');
    paintLayer(pgm.querySelector('.la'), m.pgm);
    const lb = pgm.querySelector('.lb');
    const dip = pgm.querySelector('.dip');
    const p = progress(m.trans, now);
    if (p !== null) {
      paintLayer(lb, m.pvw);
      const st = m.trans.style;
      lb.style.opacity = st === 'Mix' ? p : st === 'Dip' ? (p < 0.5 ? 0 : 1) : 1;
      lb.style.clipPath = st === 'Wipe' ? `inset(0 ${(1 - p) * 100}% 0 0)` : 'none';
      dip.style.opacity = st === 'Dip' ? 1 - Math.abs(2 * p - 1) : 0;
    } else {
      lb.style.opacity = 0;
      dip.style.opacity = 0;
    }
    pgm.querySelector('.usks').innerHTML = m.usk.map((on, i) => (on ? `<span>KEY ${i + 1}</span>` : '')).join('');
    pgm.querySelector('.dsks').innerHTML = meSel === 0
      ? rt.dsk.map((d, i) => {
          const o = level(d.anim, d.onAir, now);
          return o > 0 ? `<div class="dsk" style="opacity:${o};bottom:${8 + i * 18}%">DSK ${i + 1} · lower third</div>` : '';
        }).join('')
      : '';
    pgm.querySelector('.ftb').style.opacity = level(m.ftb.anim, m.ftb.on, now);

    // Bus buttons
    root.querySelectorAll('#busPgm button').forEach((b) => b.classList.toggle('on', b.dataset.key === m.pgm));
    root.querySelectorAll('#busPvw button').forEach((b) => b.classList.toggle('on', b.dataset.key === m.pvw));

    // Transition panel
    root.querySelectorAll('[data-style]').forEach((b) => b.classList.toggle('on', b.dataset.style === m.style));
    const rateIn = $('#rateIn');
    if (document.activeElement !== rateIn) rateIn.value = m.rate[m.style] ?? 30;
    $('#rateLbl').textContent = `${m.style} rate`;
    $('#tbar').style.width = `${(p ?? 0) * 100}%`;
    $('#btnAuto').classList.toggle('on', p !== null);
    const ftbLvl = level(m.ftb.anim, m.ftb.on, now);
    $('#btnFtb').classList.toggle('on', ftbLvl > 0);
    $('#btnFtb').classList.toggle('flash', m.ftb.on && !m.ftb.anim);

    // Keyers
    m.usk.forEach((on, i) => { const b = $(`[data-usk="${i}"]`); if (b) b.classList.toggle('on', on); });
    rt.dsk.forEach((d, i) => {
      const lvl = level(d.anim, d.onAir, now);
      $(`[data-dsk-tie="${i}"]`).classList.toggle('on', d.tie);
      $(`[data-dsk-air="${i}"]`).classList.toggle('on', lvl > 0);
      $(`[data-dsk-auto="${i}"]`).classList.toggle('on', !!d.anim);
    });

    // Aux + media players
    rt.aux.forEach((k, i) => { const s = $(`[data-aux="${i}"]`); if (s && document.activeElement !== s) s.value = k; });
    rt.mp.forEach((v, i) => { const s = $(`[data-mp="${i}"]`); if (s && document.activeElement !== s) s.value = v + 1; });
  }

  function monitorHtml(id, title, cls) {
    const layer = (c) => `<div class="layer ${c}"><div class="cap"></div><div class="sub"></div></div>`;
    return `<div class="monitor-wrap"><div class="monitor-title ${cls}">${title}</div>
      <div class="monitor" id="${id}">${layer('la')}${layer('lb')}<div class="dip"></div>
      <div class="usks"></div><div class="dsks"></div><div class="ftb"></div></div></div>`;
  }

  function renderShell() {
    const c = cfg();
    const busSources = BMD.atemSources(c);
    const auxSources = BMD.atemAuxSources(c);
    const busBtns = busSources.map((s) => `<button data-key="${s.key}" title="${esc(labelOf(s.key).long)}">${esc(labelOf(s.key).short)}</button>`).join('');
    const auxOpts = auxSources.map((s) => `<option value="${s.key}">${esc(labelOf(s.key).long)}</option>`).join('');

    root.innerHTML = `
      <div class="toolbar">
        <div class="product"><span class="dim">Switcher</span> <b>${esc(c.product)}</b>
          ${c.template ? `<span class="tag ok" title="Exports are merged into this file, so all other switcher settings are kept">Template: ${esc(c.templateName || 'imported file')}</span>`
                       : '<span class="tag warn" title="Import an XML saved from your switcher for the most reliable restore">No template</span>'}
        </div>
        ${c.mes > 1 ? `<label>M/E <select id="meSel">${rt.me.map((_, i) => `<option value="${i}"${i === meSel ? ' selected' : ''}>M/E ${i + 1}</option>`).join('')}</select></label>` : ''}
        <button id="btnSetup">Setup &amp; labels…</button>
        <button id="btnReset" title="Put the emulator back to its starting state (macros are not changed)">Reset emulator</button>
        <div class="spacer"></div>
        <button id="btnImportXml">Import ATEM XML…</button>
        <button id="btnExportXml" class="primary">Export ATEM XML</button>
      </div>
      <div class="atem-layout">
        <div class="atem-main">
          <div class="monitors">${monitorHtml('monPvw', 'Preview', 'pvw')}${monitorHtml('monPgm', 'Program', 'pgm')}</div>
          <div class="buses">
            <div class="bus-label pgm">PROGRAM</div><div class="bus" id="busPgm">${busBtns}</div>
            <div class="bus-label pvw">PREVIEW</div><div class="bus" id="busPvw">${busBtns}</div>
          </div>
          <div class="panels">
            <div class="panel">
              <h4>Transition</h4>
              <div class="row">${STYLES.map((s) => `<button data-style="${s}">${s.toUpperCase()}</button>`).join('')}</div>
              <div class="row"><label><span id="rateLbl">Mix rate</span> <input id="rateIn" type="number" min="1" max="250"> frames</label></div>
              <div class="row big"><button id="btnCut" class="cut">CUT</button><button id="btnAuto" class="auto">AUTO</button></div>
              <div class="tbar"><div id="tbar"></div></div>
              <div class="row"><button id="btnFtb" class="ftb-btn">FTB</button>
                <label>rate <input id="ftbRate" type="number" min="1" max="250" value="${rt.me[meSel].ftb.rate}"></label></div>
            </div>
            <div class="panel">
              <h4>Upstream keys</h4>
              <div class="row">${rt.me[meSel].usk.map((_, i) => `<button data-usk="${i}" class="air">KEY ${i + 1}<small>ON AIR</small></button>`).join('') || '<span class="dim">None</span>'}</div>
              <h4>Downstream keys</h4>
              ${rt.dsk.map((d, i) => `<div class="row dskrow"><span class="dsklbl">DSK ${i + 1}</span>
                <button data-dsk-tie="${i}" class="tie">TIE</button>
                <button data-dsk-air="${i}" class="air">ON AIR</button>
                <button data-dsk-auto="${i}">AUTO</button>
                <label title="Emulator only. Set the DSK rate on the switcher itself.">rate <input data-dsk-rate="${i}" type="number" min="1" max="250" value="${d.rate}"></label></div>`).join('') || '<span class="dim">None</span>'}
            </div>
            <div class="panel">
              <h4>Aux outputs</h4>
              ${rt.aux.map((_, i) => `<div class="row"><label>Aux ${i + 1} <select data-aux="${i}">${auxOpts}</select></label></div>`).join('') || '<span class="dim">None</span>'}
              <h4>Media players</h4>
              ${rt.mp.map((_, i) => `<div class="row"><label>MP ${i + 1} still # <input data-mp="${i}" type="number" min="1" max="64"></label></div>`).join('') || '<span class="dim">None</span>'}
              <p class="hint">Shortcuts: <kbd>1</kbd>–<kbd>9</kbd> preview camera, <kbd>Space</kbd> cut, <kbd>Enter</kbd> auto.</p>
            </div>
          </div>
        </div>
        <aside class="macros">
          <div class="macros-head"><h3>Macros</h3><span class="dim">click to select · double-click to run</span></div>
          <div class="slots" id="slots"></div>
          <div id="macroEditor" class="macro-editor"></div>
        </aside>
      </div>`;
    renderSlots();
    renderMacroEditor();
    renderLive(performance.now());
  }

  function renderSlots() {
    const el = $('#slots');
    if (!el) return;
    el.innerHTML = cfg().macros.map((m, i) => {
      const cls = ['slot'];
      if (m) cls.push('filled');
      if (i === slot) cls.push('sel');
      if (recording && i === slot) cls.push('rec');
      if (player && player.slot === i) cls.push('running');
      return `<button class="${cls.join(' ')}" data-slot="${i}" title="${m ? esc(m.name) : 'Empty'}"><span>${i + 1}</span>${m ? esc(m.name) : ''}</button>`;
    }).join('');
  }

  function renderMacroEditor() {
    const el = $('#macroEditor');
    if (!el) return;
    const m = macro();
    const running = player && player.slot === slot;
    const head = `<div class="me-title">Slot ${slot + 1}${recording ? ' <span class="rec-dot">● RECORDING</span>' : ''}${running ? ' <span class="run-dot">▶ RUNNING</span>' : ''}</div>`;
    if (!m) {
      el.innerHTML = `${head}<p class="dim">Empty slot.</p>
        <div class="row"><button data-m="rec" class="rec">● Record</button><button data-m="create">Create empty</button></div>
        <p class="hint">While recording, everything you do on the switcher is added to the macro. Add pauses between steps, just as on the real switcher.</p>`;
      return;
    }
    const ops = m.ops.map((op, i) => {
      const cls = ['op'];
      if (i === selOp) cls.push('sel');
      if (running && player.index === i) cls.push('now');
      return `<li class="${cls.join(' ')}" data-i="${i}"><span class="n">${i + 1}</span><span class="d">${describe(op)}</span></li>`;
    }).join('');
    el.innerHTML = `${head}
      <label class="field">Name <input data-m="name" maxlength="20" value="${esc(m.name)}"></label>
      <label class="field">Description <input data-m="desc" maxlength="100" value="${esc(m.description)}"></label>
      <div class="row">
        ${recording ? '<button data-m="stoprec" class="rec on">■ Stop recording</button>' : '<button data-m="rec" class="rec">● Record</button>'}
        ${running ? '<button data-m="stop">■ Stop</button>' : `<button data-m="run" ${m.ops.length ? '' : 'disabled'}>▶ Run</button>`}
        <div class="spacer"></div>
        <button data-m="dup" title="Copy to the next empty slot">Duplicate</button>
        <button data-m="delete" class="danger">Delete</button>
      </div>
      <div id="playerStatus"></div>
      <div class="row insert">
        <span class="dim">Insert${selOp >= 0 ? ` after step ${selOp + 1}` : ' at end'}:</span>
        <input id="pauseFrames" type="number" min="1" value="${cfg().fps}" title="frames">
        <button data-m="pause">+ Pause</button>
        <button data-m="userwait">+ Wait for operator</button>
      </div>
      <ol class="ops">${ops || '<li class="dim empty">No steps yet. Press Record and use the switcher.</li>'}</ol>
      ${selOp >= 0 && m.ops[selOp] ? opEditor(m.ops[selOp]) : ''}
      <div class="me-foot dim">${m.ops.length} steps · about ${macroDuration(m).toFixed(1)} s of pauses at ${cfg().fps} fps</div>`;
    renderPlayerStatus();
  }

  function opEditor(op) {
    const auxOpts = (val) => BMD.atemAuxSources(cfg()).map((s) => `<option value="${s.key}"${s.key === val ? ' selected' : ''}>${esc(labelOf(s.key).long)}</option>`).join('');
    const fields = Object.entries(op.attrs).map(([k, v]) => {
      let input;
      if (k === 'input') input = `<select data-attr="${k}">${auxOpts(v)}${srcByKey(v) ? '' : `<option selected>${esc(v)}</option>`}</select>`;
      else if (k === 'onAir' || k === 'tie' || /^(True|False)$/.test(v)) input = `<select data-attr="${k}"><option${v === 'True' ? ' selected' : ''}>True</option><option${v === 'False' ? ' selected' : ''}>False</option></select>`;
      else if (k === 'style') input = `<select data-attr="${k}">${['Mix', 'Dip', 'Wipe', 'DVE', 'Stinger'].map((s) => `<option${s === v ? ' selected' : ''}>${s}</option>`).join('')}</select>`;
      else input = `<input data-attr="${k}" value="${esc(v)}">`;
      return `<label class="field">${esc(k)} ${input}</label>`;
    }).join('');
    return `<div class="op-editor">
      <div class="row"><b>Step ${selOp + 1}</b> <code>${esc(op.id)}</code><div class="spacer"></div>
        <button data-m="up" title="Move up">↑</button><button data-m="down" title="Move down">↓</button>
        <button data-m="delop" class="danger" title="Delete step">✕</button></div>
      ${fields}</div>`;
  }

  function renderPlayerStatus() {
    const el = $('#playerStatus');
    if (!el) return;
    el.innerHTML = player && player.waiting && player.slot === slot
      ? '<div class="waiting">Waiting for operator… <button data-m="continue" class="primary">Continue ▶</button></div>'
      : '';
  }

  function markRunningOp() {
    root.querySelectorAll('.op.now').forEach((e) => e.classList.remove('now'));
    if (!player || player.slot !== slot) return;
    const row = root.querySelector(`.op[data-i="${player.index}"]`);
    if (row) { row.classList.add('now'); row.scrollIntoView({ block: 'nearest' }); }
  }

  // ---------------------------------------------------------------- events

  function onClick(e) {
    const t = e.target.closest('button, li.op');
    if (!t || t.disabled) return;
    if (t.closest('#busPgm')) return actions.pgm(t.dataset.key);
    if (t.closest('#busPvw')) return actions.pvw(t.dataset.key);
    if (t.dataset.style) return actions.style(t.dataset.style);
    if (t.dataset.usk !== undefined) return actions.usk(int(t.dataset.usk));
    if (t.dataset.dskTie !== undefined) return actions.dskTie(int(t.dataset.dskTie));
    if (t.dataset.dskAir !== undefined) return actions.dskOnAir(int(t.dataset.dskAir));
    if (t.dataset.dskAuto !== undefined) return actions.dskAuto(int(t.dataset.dskAuto));
    if (t.dataset.slot !== undefined) return selectSlot(int(t.dataset.slot));
    if (t.matches('li.op')) { selOp = int(t.dataset.i) === selOp ? -1 : int(t.dataset.i); return renderMacroEditor(); }
    switch (t.id) {
      case 'btnCut': return actions.cut();
      case 'btnAuto': return actions.auto();
      case 'btnFtb': return actions.ftb();
      case 'btnSetup': return openSetup();
      case 'btnReset': stopPlayer(); resetRuntime(); return renderShell();
      case 'btnImportXml': return importXml();
      case 'btnExportXml': return exportXml();
    }
    const m = macro();
    switch (t.dataset.m) {
      case 'rec': return startRecording();
      case 'stoprec': return stopRecording();
      case 'create': ensureMacro(); app.save(); renderSlots(); return renderMacroEditor();
      case 'run': return run(slot);
      case 'stop': stopPlayer(); renderSlots(); return renderMacroEditor();
      case 'continue': return continuePlayer();
      case 'pause': return insertOp({ id: 'MacroSleep', attrs: { frames: String(Math.max(1, int($('#pauseFrames').value, cfg().fps))) } });
      case 'userwait': return insertOp({ id: 'MacroUserWait', attrs: {} });
      case 'up': case 'down': {
        const j = selOp + (t.dataset.m === 'up' ? -1 : 1);
        if (j < 0 || j >= m.ops.length) return;
        [m.ops[selOp], m.ops[j]] = [m.ops[j], m.ops[selOp]];
        selOp = j;
        app.save();
        return renderMacroEditor();
      }
      case 'delop': m.ops.splice(selOp, 1); selOp = Math.min(selOp, m.ops.length - 1); app.save(); return renderMacroEditor();
      case 'dup': {
        const free = cfg().macros.findIndex((x, i) => !x && i > slot);
        const to = free >= 0 ? free : cfg().macros.findIndex((x) => !x);
        if (to < 0) return app.toast('All 100 macro slots are in use.', 'warn');
        cfg().macros[to] = JSON.parse(JSON.stringify(m));
        cfg().macros[to].name = (m.name + ' copy').slice(0, 20);
        app.save();
        app.toast(`Copied to slot ${to + 1}.`);
        return selectSlot(to);
      }
      case 'delete':
        return app.confirm(`Delete macro "${m.name}" from slot ${slot + 1}?`, 'Delete').then((ok) => {
          if (!ok) return;
          if (recording) recording = false;
          if (player && player.slot === slot) stopPlayer();
          cfg().macros[slot] = null;
          selOp = -1;
          app.save();
          renderSlots();
          renderMacroEditor();
        });
    }
  }

  function onDblClick(e) {
    const t = e.target.closest('[data-slot]');
    if (t) run(int(t.dataset.slot));
  }

  function onChange(e) {
    const t = e.target;
    if (t.id === 'meSel') { meSel = int(t.value); return renderShell(); }
    if (t.id === 'rateIn') {
      const st = STYLES.includes(rt.me[meSel].style) ? rt.me[meSel].style : 'Mix';
      return actions.rate(st, Math.min(250, Math.max(1, int(t.value, 30))));
    }
    if (t.id === 'ftbRate') { rt.me[meSel].ftb.rate = Math.min(250, Math.max(1, int(t.value, 30))); return; }
    if (t.dataset.dskRate !== undefined) { rt.dsk[int(t.dataset.dskRate)].rate = Math.min(250, Math.max(1, int(t.value, 30))); return; }
    if (t.dataset.aux !== undefined) return actions.aux(int(t.dataset.aux), t.value);
    if (t.dataset.mp !== undefined) return actions.still(int(t.dataset.mp), Math.max(0, int(t.value, 1) - 1));
    if (t.dataset.attr) {
      const op = macro().ops[selOp];
      op.attrs[t.dataset.attr] = t.value;
      app.save();
      return renderMacroEditor();
    }
  }

  function onInput(e) {
    const t = e.target;
    const m = macro();
    if (!m) return;
    if (t.dataset.m === 'name') { m.name = t.value; app.save(); renderSlots(); }
    if (t.dataset.m === 'desc') { m.description = t.value; app.save(); }
  }

  function onKey(e) {
    if (!root || root.hidden || root.closest('[hidden]')) return;
    if (e.target.closest('input, select, textarea, dialog') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^[1-9]$/.test(e.key) && int(e.key) <= cfg().inputs) { e.preventDefault(); actions.pvw('Camera' + e.key); }
    else if (e.key === ' ') { e.preventDefault(); actions.cut(); }
    else if (e.key === 'Enter') { e.preventDefault(); actions.auto(); }
  }

  // ---------------------------------------------------------------- setup + files

  function openSetup() {
    const c = cfg();
    const preset = BMD.ATEM_MODELS.findIndex((x) => x.product === c.product);
    const num = (k, lbl, min, max) => `<label class="field">${lbl} <input type="number" name="${k}" min="${min}" max="${max}" value="${c[k]}"></label>`;
    const labelRows = BMD.atemAuxSources(c).map((s) => {
      const l = labelOf(s.key);
      return `<tr><td class="dim">${s.id}</td><td>${esc(s.long)}</td>
        <td><input name="long-${s.id}" maxlength="20" value="${esc(l.long)}"></td>
        <td><input name="short-${s.id}" maxlength="4" value="${esc(l.short)}" class="short"></td></tr>`;
    }).join('');
    const body = `
      <div class="setup-grid">
        <div>
          <label class="field">Model
            <select name="preset">${BMD.ATEM_MODELS.map((x, i) => `<option value="${i}"${i === preset ? ' selected' : ''}>${esc(x.product)}</option>`).join('')}
              <option value="-1"${preset < 0 ? ' selected' : ''}>Custom…</option></select></label>
          <label class="field">Product name in file <input name="product" value="${esc(c.product)}" ${c.template ? 'disabled title="Taken from the imported template"' : ''}></label>
          ${num('inputs', 'External inputs', 1, 40)}
          ${num('mes', 'M/E rows', 1, 4)}
          ${num('usks', 'Upstream keys per M/E', 0, 4)}
          ${num('dsks', 'Downstream keys', 0, 4)}
          ${num('auxes', 'Aux outputs', 0, 24)}
          ${num('mediaPlayers', 'Media players', 0, 4)}
          <label class="field check"><input type="checkbox" name="superSource" ${c.superSource ? 'checked' : ''}> SuperSource</label>
          <label class="field">Frame rate (for pause lengths)
            <select name="fps">${BMD.FRAME_RATES.map((f) => `<option${f === c.fps ? ' selected' : ''}>${f}</option>`).join('')}</select></label>
          ${c.template ? `<p class="hint">Template: <b>${esc(c.templateName)}</b><br><label class="check"><input type="checkbox" name="dropTemplate"> Remove template (export from scratch)</label></p>` : ''}
          <p class="hint">The counts are typical for each model. Check them against your switcher.</p>
        </div>
        <div class="labels-wrap">
          <table class="labels"><thead><tr><th>ID</th><th>Source</th><th>Long name (20)</th><th>Short (4)</th></tr></thead>
          <tbody>${labelRows}</tbody></table>
        </div>
      </div>`;
    app.dialog({
      title: 'ATEM setup & input labels',
      body,
      wide: true,
      buttons: [{ label: 'Cancel', value: false }, { label: 'Apply', value: true, primary: true }],
      onOpen(dlg) {
        dlg.querySelector('[name=preset]').addEventListener('change', (ev) => {
          const p = BMD.ATEM_MODELS[int(ev.target.value, -1)];
          if (!p) return;
          for (const k of ['inputs', 'mes', 'usks', 'dsks', 'auxes', 'mediaPlayers']) dlg.querySelector(`[name=${k}]`).value = p[k];
          dlg.querySelector('[name=superSource]').checked = p.superSource;
          const prod = dlg.querySelector('[name=product]');
          if (!prod.disabled) prod.value = p.product;
        });
      },
    }).then(({ value, el }) => {
      if (!value) return;
      const f = (n) => el.querySelector(`[name="${n}"]`);
      const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, int(f(n).value, lo)));
      if (!c.template) c.product = f('product').value.trim() || c.product;
      c.inputs = clamp('inputs', 1, 40);
      c.mes = clamp('mes', 1, 4);
      c.usks = clamp('usks', 0, 4);
      c.dsks = clamp('dsks', 0, 4);
      c.auxes = clamp('auxes', 0, 24);
      c.mediaPlayers = clamp('mediaPlayers', 0, 4);
      c.superSource = f('superSource').checked;
      c.fps = parseFloat(f('fps').value);
      if (f('dropTemplate') && f('dropTemplate').checked) { c.template = null; c.templateName = null; }
      // Store only labels that differ from the defaults; keep labels for IDs not shown.
      for (const s of BMD.atemAuxSources(c)) {
        const lg = f(`long-${s.id}`), sh = f(`short-${s.id}`);
        if (!lg) continue;
        const long = lg.value.trim() || s.long, short = sh.value.trim() || s.short;
        if (long === s.long && short === s.short) delete c.labels[s.id];
        else c.labels[s.id] = { long, short };
      }
      app.save();
      stopPlayer();
      resetRuntime();
      renderShell();
    });
  }

  async function importXml() {
    const file = await app.pickFile('.xml,application/xml,text/xml');
    if (!file) return;
    let parsed;
    try { parsed = BMD.AtemXml.parse(file.text); } catch (err) { return app.toast(err.message, 'error'); }
    const c = cfg();
    const fileMacros = parsed.macros.filter(Boolean).length;
    const ourMacros = c.macros.filter(Boolean).length;
    let useFileMacros = true;
    if (fileMacros && ourMacros) {
      const { value } = await app.dialog({
        title: 'Macros',
        body: `<p>The file has <b>${fileMacros}</b> macro(s) and this project has <b>${ourMacros}</b>. Which should be kept?</p>`,
        buttons: [{ label: 'Cancel', value: null }, { label: 'Keep my macros', value: 'mine' }, { label: "Use the file's macros", value: 'file', primary: true }],
      });
      if (value === null) return;
      useFileMacros = value === 'file';
    } else if (!fileMacros) {
      useFileMacros = false;
    }

    const preset = BMD.ATEM_MODELS.find((x) => x.product === parsed.product);
    if (preset) Object.assign(c, { inputs: preset.inputs, mes: preset.mes, usks: preset.usks, dsks: preset.dsks, auxes: preset.auxes, mediaPlayers: preset.mediaPlayers, superSource: preset.superSource });
    else {
      if (parsed.externalInputs) c.inputs = Math.min(40, parsed.externalInputs);
      if (parsed.mixEffectBlocks) c.mes = Math.min(4, parsed.mixEffectBlocks);
    }
    if (parsed.product) c.product = parsed.product;
    c.template = file.text;
    c.templateName = file.name;
    c.labels = {};
    for (const s of BMD.atemAuxSources(c)) {
      const l = parsed.labels[s.id];
      if (l && (l.long !== s.long || l.short !== s.short)) c.labels[s.id] = { long: l.long || s.long, short: l.short || s.short };
    }
    if (useFileMacros) c.macros = parsed.macros;
    slot = 0;
    selOp = -1;
    recording = false;
    stopPlayer();
    app.save();
    resetRuntime();
    renderShell();
    app.toast(`Loaded ${file.name} (${parsed.product || 'unknown model'}). ${preset ? '' : 'Model not in the preset list. Check the counts in Setup.'}`, preset ? 'ok' : 'warn');
  }

  async function exportXml() {
    const c = cfg();
    if (!c.template) {
      const { value } = await app.dialog({
        title: 'Export without a template?',
        body: `<p>Restore is most reliable when you start from a file saved on your own switcher:</p>
          <ol><li>Open ATEM Software Control connected to the switcher</li>
          <li><b>File → Save As…</b> to save an XML</li>
          <li>Here, use <b>Import ATEM XML…</b> to load it as the template</li></ol>
          <p>Without one, this tool writes a minimal file containing only input labels and macros for
          “${esc(c.product)}”. ATEM Software Control may reject it if the product name or software version doesn't match.</p>`,
        buttons: [{ label: 'Cancel', value: false }, { label: 'Export anyway', value: true, primary: true }],
      });
      if (!value) return;
    }
    let xml;
    try { xml = BMD.AtemXml.build(c); } catch (err) { return app.toast(err.message, 'error'); }
    app.download(`${app.fileBase()} - ATEM.xml`, xml, 'application/xml');
    app.toast('Exported. In ATEM Software Control use File → Restore and tick Macros (and Inputs for labels).', 'ok');
  }

  // ---------------------------------------------------------------- public

  function mount(appRef, el) {
    app = appRef;
    root = el;
    root.addEventListener('click', onClick);
    root.addEventListener('dblclick', onDblClick);
    root.addEventListener('change', onChange);
    root.addEventListener('input', onInput);
    document.addEventListener('keydown', onKey);
    reload();
  }

  // Called when a different project is loaded.
  function reload() {
    stopPlayer();
    recording = false;
    slot = 0;
    selOp = -1;
    meSel = 0;
    resetRuntime();
    renderShell();
  }

  return { mount, reload };
})();
