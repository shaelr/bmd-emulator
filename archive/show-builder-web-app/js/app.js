// App shell: project persistence, tabs, dialogs and file helpers.
window.BMD = window.BMD || {};

(function () {
  const STORE_KEY = 'bmd-show-builder:project';
  const TAB_KEY = 'bmd-show-builder:tab';
  const esc = BMD.esc;

  // Fills in anything missing so older or hand-edited project files still load.
  function normalize(p) {
    const d = BMD.defaultProject();
    if (!p || p.format !== 'bmd-show') throw new Error('Not a show project file.');
    const atem = Object.assign({}, d.atem, p.atem);
    atem.labels = atem.labels || {};
    const macros = new Array(BMD.MACRO_SLOTS).fill(null);
    (atem.macros || []).forEach((m, i) => { if (m && i < BMD.MACRO_SLOTS) macros[i] = { name: m.name || '', description: m.description || '', ops: m.ops || [] }; });
    atem.macros = macros;
    const vhIn = Object.assign({}, d.videohub, p.videohub);
    const vh = BMD.newVideohub(vhIn.model, vhIn.inputs, vhIn.outputs);
    for (const k of ['inputLabels', 'outputLabels', 'routing']) {
      if (Array.isArray(vhIn[k])) vhIn[k].forEach((v, i) => { if (i < vh[k].length && v !== null && v !== undefined) vh[k][i] = v; });
    }
    vh.presets = (vhIn.presets || []).map((pr) => ({
      name: pr.name || 'Preset',
      routing: Array.from({ length: vh.outputs }, (_, o) => (pr.routing && pr.routing[o] !== undefined ? pr.routing[o] : null)),
    }));
    return { format: 'bmd-show', version: 1, name: p.name || d.name, atem, videohub: vh };
  }

  let saveTimer = 0;
  const app = {
    project: null,

    save() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(app.project)); }
        catch (e) { app.toast('Autosave failed. Use Save project to keep your work.', 'error'); }
      }, 250);
    },

    setProject(p) {
      app.project = p;
      document.getElementById('projectName').value = p.name;
      app.save();
      BMD.Atem.reload();
      BMD.Videohub.reload();
    },

    fileBase() {
      return (app.project.name || 'Show').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Show';
    },

    toast(msg, kind = '') {
      const el = document.createElement('div');
      el.className = 'toast ' + kind;
      el.textContent = msg;
      document.getElementById('toasts').appendChild(el);
      setTimeout(() => el.classList.add('out'), kind === 'error' ? 7000 : 4500);
      setTimeout(() => el.remove(), kind === 'error' ? 7600 : 5100);
    },

    download(name, text, mime) {
      const url = URL.createObjectURL(new Blob([text], { type: mime + ';charset=utf-8' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: name });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },

    pickFile(accept) {
      return new Promise((resolve) => {
        const input = Object.assign(document.createElement('input'), { type: 'file', accept });
        input.addEventListener('change', async () => {
          const f = input.files[0];
          resolve(f ? { name: f.name, text: await f.text() } : null);
        });
        input.click();
      });
    },

    // Resolves to { value, el } so callers can read form fields from the dialog.
    dialog({ title, body, buttons, wide, onOpen }) {
      const dlg = document.getElementById('dialog');
      dlg.className = wide ? 'wide' : '';
      dlg.innerHTML = `<form method="dialog">
        <h2>${esc(title)}</h2><div class="dlg-body">${body}</div>
        <div class="dlg-foot">${buttons.map((b, i) => `<button value="${i}" class="${b.primary ? 'primary' : ''}">${esc(b.label)}</button>`).join('')}</div></form>`;
      if (onOpen) onOpen(dlg);
      dlg.returnValue = '';
      dlg.showModal();
      return new Promise((resolve) => {
        dlg.addEventListener('close', () => {
          const b = buttons[parseInt(dlg.returnValue, 10)];
          resolve({ value: b ? b.value : buttons[0].value, el: dlg });
        }, { once: true });
      });
    },

    confirm(message, okLabel = 'OK') {
      return app.dialog({
        title: 'Are you sure?',
        body: `<p>${esc(message)}</p>`,
        buttons: [{ label: 'Cancel', value: false }, { label: okLabel, value: true, primary: true }],
      }).then((r) => r.value);
    },
  };

  function showTab(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.tabpanel').forEach((p) => { p.hidden = p.id !== 'tab-' + name; });
    try { localStorage.setItem(TAB_KEY, name); } catch (e) { /* not important */ }
  }

  function init() {
    let project;
    try { project = normalize(JSON.parse(localStorage.getItem(STORE_KEY))); }
    catch (e) { project = BMD.defaultProject(); }
    app.project = project;

    const nameIn = document.getElementById('projectName');
    nameIn.value = project.name;
    nameIn.addEventListener('input', () => { app.project.name = nameIn.value; app.save(); });

    document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
    let tab = 'atem';
    try { tab = localStorage.getItem(TAB_KEY) || 'atem'; } catch (e) { /* default */ }
    showTab(tab);

    document.getElementById('btnNew').addEventListener('click', async () => {
      if (await app.confirm('Start a new show? Save the current project first if you want to keep it.', 'New show')) {
        app.setProject(BMD.defaultProject());
      }
    });
    document.getElementById('btnOpen').addEventListener('click', async () => {
      const f = await app.pickFile('.json,application/json');
      if (!f) return;
      try {
        app.setProject(normalize(JSON.parse(f.text)));
        app.toast(`Opened ${f.name}.`, 'ok');
      } catch (e) {
        app.toast('Could not open project: ' + e.message, 'error');
      }
    });
    document.getElementById('btnSave').addEventListener('click', () => {
      app.download(`${app.fileBase()}.bmdshow.json`, JSON.stringify(app.project, null, 2), 'application/json');
    });

    BMD.Atem.mount(app, document.getElementById('tab-atem'));
    BMD.Videohub.mount(app, document.getElementById('tab-videohub'));
  }

  BMD.app = app;
  document.addEventListener('DOMContentLoaded', init);
})();
