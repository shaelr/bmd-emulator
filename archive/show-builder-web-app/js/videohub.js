// Videohub router emulator: labels, live routing and routing presets (salvos).
window.BMD = window.BMD || {};

BMD.Videohub = (function () {
  let app, root;
  let view = 'list';
  let sel = -1;           // selected preset
  const GRID_LIMIT = 6400;

  const esc = BMD.esc;
  const vh = () => app.project.videohub;
  const int = (v, d = 0) => { const n = parseInt(v, 10); return isNaN(n) ? d : n; };
  const inLbl = (i) => `${i + 1}: ${vh().inputLabels[i] ?? ''}`;

  function resize(inputs, outputs) {
    const h = vh();
    const fit = (arr, n, def) => { arr.length = Math.min(arr.length, n); for (let i = arr.length; i < n; i++) arr.push(def(i)); };
    fit(h.inputLabels, inputs, (i) => 'Input ' + (i + 1));
    fit(h.outputLabels, outputs, (i) => 'Output ' + (i + 1));
    fit(h.routing, outputs, (i) => i % inputs);
    h.routing = h.routing.map((r) => (r < inputs ? r : 0));
    for (const p of h.presets) {
      fit(p.routing, outputs, () => null);
      p.routing = p.routing.map((r) => (r === null || r < inputs ? r : null));
    }
    h.inputs = inputs;
    h.outputs = outputs;
  }

  function render() {
    const h = vh();
    const preset = h.presets[sel] || null;
    const modelIdx = BMD.VIDEOHUB_MODELS.findIndex((m) => m.model === h.model);
    root.innerHTML = `
      <div class="toolbar">
        <label>Model <select data-act="model">
          ${BMD.VIDEOHUB_MODELS.map((m, i) => `<option value="${i}"${i === modelIdx ? ' selected' : ''}>${esc(m.model)}</option>`).join('')}
          <option value="-1"${modelIdx < 0 ? ' selected' : ''}>Custom</option></select></label>
        <label>Inputs <input type="number" data-act="inputs" min="1" max="288" value="${h.inputs}"></label>
        <label>Outputs <input type="number" data-act="outputs" min="1" max="288" value="${h.outputs}"></label>
        <div class="seg">
          <button data-act="view-list" class="${view === 'list' ? 'on' : ''}">List</button>
          <button data-act="view-grid" class="${view === 'grid' ? 'on' : ''}">Grid</button>
        </div>
        <div class="spacer"></div>
        <button data-act="import">Import .txt…</button>
        <button data-act="export-labels">Export labels</button>
        <button data-act="export-all" class="primary">Export labels + routing</button>
      </div>
      <div class="vh-layout">
        <aside class="presets">
          <h3>Routing presets</h3>
          <p class="hint">Store the routing for each part of the show, then push the one you need to the hub.</p>
          <button data-act="preset-new" class="primary wide">+ Store current routing</button>
          <ol class="preset-list">
            ${h.presets.map((p, i) => `<li data-preset="${i}" class="${i === sel ? 'sel' : ''}"><span class="n">${i + 1}</span><span class="nm">${esc(p.name)}</span></li>`).join('') || '<li class="dim empty">No presets yet</li>'}
          </ol>
          ${preset ? `
            <div class="preset-edit">
              <label class="field">Name <input data-act="preset-name" value="${esc(preset.name)}"></label>
              <div class="row"><button data-act="preset-recall" class="primary">Recall</button>
                <button data-act="preset-update" title="Overwrite this preset with the current routing">Update</button></div>
              <div class="row"><button data-act="preset-export">Export .txt</button>
                <button data-act="preset-up">↑</button><button data-act="preset-down">↓</button>
                <button data-act="preset-delete" class="danger">Delete</button></div>
              <p class="hint">${diffCount(preset)} output(s) differ from the current routing. They're highlighted in the list.</p>
            </div>` : ''}
        </aside>
        <div class="vh-main">${view === 'grid' ? gridHtml(preset) : listHtml(preset)}</div>
      </div>`;
  }

  function diffCount(p) {
    return p.routing.filter((r, o) => r !== null && r !== vh().routing[o]).length;
  }

  function listHtml(preset) {
    const h = vh();
    const opts = (cur) => h.inputLabels.map((_, i) => `<option value="${i}"${i === cur ? ' selected' : ''}>${esc(inLbl(i))}</option>`).join('');
    const usage = new Array(h.inputs).fill(0);
    h.routing.forEach((r) => { if (r < h.inputs) usage[r]++; });
    const outRows = h.outputLabels.map((l, o) => {
      const pr = preset ? preset.routing[o] : null;
      const diff = preset && pr !== null && pr !== h.routing[o];
      return `<tr class="${diff ? 'diff' : ''}"><td class="n">${o + 1}</td>
        <td><input data-olabel="${o}" value="${esc(l)}"></td>
        <td><select data-route="${o}">${opts(h.routing[o])}</select></td>
        ${preset ? `<td class="pcol">${pr === null ? '<span class="dim">—</span>' : esc(inLbl(pr))}</td>` : ''}</tr>`;
    }).join('');
    const inRows = h.inputLabels.map((l, i) => `<tr><td class="n">${i + 1}</td><td><input data-ilabel="${i}" value="${esc(l)}"></td>
      <td class="dim">${usage[i] ? `→ ${usage[i]}` : ''}</td></tr>`).join('');
    return `<div class="vh-tables">
      <div><h4>Outputs</h4><table class="vh-table"><thead><tr><th>#</th><th>Output label</th><th>Source</th>${preset ? `<th>${esc(preset.name)}</th>` : ''}</tr></thead><tbody>${outRows}</tbody></table></div>
      <div><h4>Inputs</h4><table class="vh-table"><thead><tr><th>#</th><th>Input label</th><th>Used</th></tr></thead><tbody>${inRows}</tbody></table></div>
    </div>`;
  }

  function gridHtml(preset) {
    const h = vh();
    if (h.inputs * h.outputs > GRID_LIMIT) return '<p class="dim">This router is too large for the grid view. Use the list view.</p>';
    const head = h.inputLabels.map((l, i) => `<th class="vin" title="${esc(inLbl(i))}"><div>${i + 1} ${esc(l)}</div></th>`).join('');
    const rows = h.outputLabels.map((l, o) => {
      const cells = h.inputLabels.map((_, i) => {
        const cls = [];
        if (h.routing[o] === i) cls.push('on');
        if (preset && preset.routing[o] === i && h.routing[o] !== i) cls.push('preset');
        return `<td data-x="${o},${i}" class="${cls.join(' ')}"></td>`;
      }).join('');
      return `<tr><th class="vout" title="${esc(l)}">${o + 1} ${esc(l)}</th>${cells}</tr>`;
    }).join('');
    return `<div class="grid-wrap"><table class="xgrid"><thead><tr><th class="corner">out \\ in</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>
      <p class="hint">Click a crosspoint to route. ${preset ? 'Outlined squares show where the selected preset differs.' : ''}</p>`;
  }

  async function onClick(e) {
    const h = vh();
    const cell = e.target.closest('td[data-x]');
    if (cell) {
      const [o, i] = cell.dataset.x.split(',').map(Number);
      h.routing[o] = i;
      app.save();
      return render();
    }
    const li = e.target.closest('[data-preset]');
    if (li) { sel = int(li.dataset.preset) === sel ? -1 : int(li.dataset.preset); return render(); }
    const t = e.target.closest('button');
    if (!t) return;
    const p = h.presets[sel];
    switch (t.dataset.act) {
      case 'view-list': view = 'list'; return render();
      case 'view-grid': view = 'grid'; return render();
      case 'import': return importTxt();
      case 'export-labels':
        return exportTxt(`${app.fileBase()} - Videohub labels.txt`, { inputLabels: h.inputLabels, outputLabels: h.outputLabels });
      case 'export-all':
        return exportTxt(`${app.fileBase()} - Videohub.txt`, { inputLabels: h.inputLabels, outputLabels: h.outputLabels, routing: h.routing });
      case 'preset-new':
        h.presets.push({ name: `Preset ${h.presets.length + 1}`, routing: h.routing.slice() });
        sel = h.presets.length - 1;
        app.save();
        return render();
      case 'preset-recall':
        p.routing.forEach((r, o) => { if (r !== null) h.routing[o] = r; });
        app.save();
        app.toast(`Recalled "${p.name}".`);
        return render();
      case 'preset-update':
        p.routing = h.routing.slice();
        app.save();
        app.toast(`Updated "${p.name}".`);
        return render();
      case 'preset-export':
        return exportTxt(`${app.fileBase()} - Videohub - ${p.name}.txt`, { routing: p.routing });
      case 'preset-up': case 'preset-down': {
        const j = sel + (t.dataset.act === 'preset-up' ? -1 : 1);
        if (j < 0 || j >= h.presets.length) return;
        [h.presets[sel], h.presets[j]] = [h.presets[j], h.presets[sel]];
        sel = j;
        app.save();
        return render();
      }
      case 'preset-delete':
        if (!(await app.confirm(`Delete preset "${p.name}"?`, 'Delete'))) return;
        h.presets.splice(sel, 1);
        sel = -1;
        app.save();
        return render();
    }
  }

  function onChange(e) {
    const t = e.target;
    const h = vh();
    if (t.dataset.route !== undefined) { h.routing[int(t.dataset.route)] = int(t.value); app.save(); return render(); }
    if (t.dataset.ilabel !== undefined || t.dataset.olabel !== undefined || t.dataset.act === 'preset-name') return render();
    if (t.dataset.act === 'model') {
      const m = BMD.VIDEOHUB_MODELS[int(t.value, -1)];
      if (m) { h.model = m.model; resize(m.inputs, m.outputs); }
      else h.model = 'Custom';
      app.save();
      return render();
    }
    if (t.dataset.act === 'inputs' || t.dataset.act === 'outputs') {
      const n = Math.min(288, Math.max(1, int(t.value, 1)));
      resize(t.dataset.act === 'inputs' ? n : h.inputs, t.dataset.act === 'outputs' ? n : h.outputs);
      h.model = BMD.VIDEOHUB_MODELS.find((m) => m.inputs === h.inputs && m.outputs === h.outputs && m.model === h.model) ? h.model : 'Custom';
      app.save();
      return render();
    }
  }

  // Typing updates the project immediately; the change event re-renders dropdowns.
  function onInput(e) {
    const t = e.target;
    const h = vh();
    if (t.dataset.ilabel !== undefined) { h.inputLabels[int(t.dataset.ilabel)] = t.value; app.save(); }
    if (t.dataset.olabel !== undefined) { h.outputLabels[int(t.dataset.olabel)] = t.value; app.save(); }
    if (t.dataset.act === 'preset-name') {
      h.presets[sel].name = t.value;
      const li = root.querySelector(`[data-preset="${sel}"]`);
      if (li) li.querySelector('.nm').textContent = t.value;
      app.save();
    }
  }

  function exportTxt(name, parts) {
    const txt = BMD.VideohubTxt.build(parts);
    if (!txt) return app.toast('Nothing to export.', 'warn');
    app.download(name, txt, 'text/plain');
    app.toast('Exported. Send it to the hub with tools/videohub-push.mjs (see README).', 'ok');
  }

  async function importTxt() {
    const file = await app.pickFile('.txt,text/plain');
    if (!file) return;
    let r;
    try { r = BMD.VideohubTxt.parse(file.text); } catch (err) { return app.toast(err.message, 'error'); }
    const h = vh();
    const maxIdx = (o) => Object.keys(o).reduce((m, k) => Math.max(m, int(k) + 1), 0);
    const inputs = r.inputs || Math.max(h.inputs, maxIdx(r.inputLabels), Math.max(0, ...Object.values(r.routing)) + 1);
    const outputs = r.outputs || Math.max(h.outputs, maxIdx(r.outputLabels), maxIdx(r.routing));
    resize(inputs, outputs);
    if (r.model) {
      const known = BMD.VIDEOHUB_MODELS.find((m) => m.inputs === inputs && m.outputs === outputs && r.model.replace(/\s+/g, '').includes(m.model.replace(/\s+/g, '')));
      h.model = known ? known.model : 'Custom';
    }
    for (const [i, l] of Object.entries(r.inputLabels)) if (int(i) < h.inputs) h.inputLabels[int(i)] = l;
    for (const [o, l] of Object.entries(r.outputLabels)) if (int(o) < h.outputs) h.outputLabels[int(o)] = l;
    const routed = Object.entries(r.routing).filter(([o, i]) => int(o) < h.outputs && i < h.inputs);
    // A file holding only routing is treated as a preset; anything else updates the live state.
    const onlyRouting = !Object.keys(r.inputLabels).length && !Object.keys(r.outputLabels).length && routed.length;
    if (onlyRouting) {
      const routing = new Array(h.outputs).fill(null);
      for (const [o, i] of routed) routing[int(o)] = i;
      h.presets.push({ name: file.name.replace(/\.txt$/i, '').slice(0, 40), routing });
      sel = h.presets.length - 1;
      app.toast(`Imported ${routed.length} routes as a new preset.`, 'ok');
    } else {
      for (const [o, i] of routed) h.routing[int(o)] = i;
      app.toast(`Imported labels${routed.length ? ' and routing' : ''} from ${file.name}.`, 'ok');
    }
    app.save();
    render();
  }

  function mount(appRef, el) {
    app = appRef;
    root = el;
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('input', onInput);
    render();
  }

  function reload() { sel = -1; render(); }

  return { mount, reload };
})();
