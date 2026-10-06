// Reads and writes the XML files that ATEM Software Control produces with
// File > Save As and loads with File > Restore.
window.BMD = window.BMD || {};

BMD.AtemXml = (function () {
  function parseDoc(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const err = doc.getElementsByTagName('parsererror')[0];
    if (err) throw new Error('Not valid XML: ' + err.textContent.trim().split('\n')[0]);
    if (doc.documentElement.tagName !== 'Profile') {
      throw new Error('This is not an ATEM settings file (expected a <Profile> root element).');
    }
    return doc;
  }

  function child(el, tag) {
    for (const c of el.children) if (c.tagName === tag) return c;
    return null;
  }

  function ensureChild(doc, parent, tag, before) {
    let el = child(parent, tag);
    if (!el) {
      el = doc.createElement(tag);
      const ref = before ? child(parent, before) : null;
      parent.insertBefore(el, ref);
    }
    return el;
  }

  function inputsEl(doc) {
    const settings = child(doc.documentElement, 'Settings');
    return settings ? child(settings, 'Inputs') : null;
  }

  // Returns everything the emulator understands. Ops keep every attribute in
  // order, so macros with ops the emulator can't simulate still round-trip intact.
  function parse(text) {
    const doc = parseDoc(text);
    const root = doc.documentElement;
    const result = {
      product: root.getAttribute('product') || '',
      labels: {},
      macros: new Array(BMD.MACRO_SLOTS).fill(null),
      externalInputs: 0,
      mixEffectBlocks: 0,
    };

    const inputs = inputsEl(doc);
    if (inputs) {
      for (const el of inputs.children) {
        if (el.tagName !== 'Input') continue;
        const id = parseInt(el.getAttribute('id'), 10);
        if (isNaN(id)) continue;
        result.labels[id] = {
          long: el.getAttribute('longName') || '',
          short: el.getAttribute('shortName') || '',
        };
        if (id >= 1 && id < 1000) result.externalInputs = Math.max(result.externalInputs, id);
      }
    }

    const meBlocks = child(root, 'MixEffectBlocks');
    if (meBlocks) result.mixEffectBlocks = meBlocks.getElementsByTagName('MixEffectBlock').length;

    const pool = child(root, 'MacroPool');
    if (pool) {
      for (const m of pool.children) {
        if (m.tagName !== 'Macro') continue;
        const index = parseInt(m.getAttribute('index'), 10);
        if (isNaN(index) || index < 0 || index >= BMD.MACRO_SLOTS) continue;
        const ops = [];
        for (const o of m.children) {
          if (o.tagName !== 'Op') continue;
          const attrs = {};
          for (const a of o.attributes) if (a.name !== 'id') attrs[a.name] = a.value;
          ops.push({ id: o.getAttribute('id'), attrs });
        }
        result.macros[index] = {
          name: m.getAttribute('name') || '',
          description: m.getAttribute('description') || '',
          ops,
        };
      }
    }
    return result;
  }

  const SKELETON = (product) =>
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<Profile majorVersion="1" minorVersion="5" product="${esc(product)}">` +
    '<Settings><Inputs/></Settings><MacroPool/><MacroControl loop="False"/></Profile>';

  function build(atem) {
    const fromTemplate = !!atem.template;
    const doc = parseDoc(fromTemplate ? atem.template : SKELETON(atem.product));
    const root = doc.documentElement;
    const sources = BMD.atemAuxSources(atem);
    const byId = new Map(sources.map((s) => [s.id, s]));
    const labelFor = (s) => Object.assign({ long: s.long, short: s.short }, atem.labels[s.id] || {});

    // Labels: in a template, update the inputs that already exist and leave every
    // other attribute alone. From scratch, write the external inputs plus any
    // internal source the user renamed.
    const settings = ensureChild(doc, root, 'Settings');
    const inputs = ensureChild(doc, settings, 'Inputs');
    if (fromTemplate) {
      for (const el of inputs.children) {
        const s = byId.get(parseInt(el.getAttribute('id'), 10));
        if (!s) continue;
        const l = labelFor(s);
        el.setAttribute('shortName', l.short);
        el.setAttribute('longName', l.long);
      }
    } else {
      for (const s of sources) {
        if (s.internal && !atem.labels[s.id]) continue;
        const l = labelFor(s);
        const el = doc.createElement('Input');
        el.setAttribute('id', String(s.id));
        el.setAttribute('shortName', l.short);
        el.setAttribute('longName', l.long);
        inputs.appendChild(el);
      }
    }

    // Macros: replace the whole pool with the project's macros.
    const pool = ensureChild(doc, root, 'MacroPool', 'MacroControl');
    while (pool.firstChild) pool.removeChild(pool.firstChild);
    atem.macros.forEach((m, index) => {
      if (!m) return;
      const mel = doc.createElement('Macro');
      mel.setAttribute('index', String(index));
      mel.setAttribute('name', m.name || '');
      mel.setAttribute('description', m.description || '');
      for (const op of m.ops) {
        const oel = doc.createElement('Op');
        oel.setAttribute('id', op.id);
        for (const [k, v] of Object.entries(op.attrs)) oel.setAttribute(k, String(v));
        mel.appendChild(oel);
      }
      pool.appendChild(mel);
    });

    return '<?xml version="1.0" encoding="UTF-8"?>\n' + serialize(root, 0);
  }

  // Pretty-printer so freshly added nodes are indented like the rest of the file.
  function serialize(el, depth) {
    const pad = '    '.repeat(depth);
    let out = pad + '<' + el.tagName;
    for (const a of el.attributes) out += ` ${a.name}="${esc(a.value)}"`;
    const kids = [];
    for (const n of el.childNodes) {
      if (n.nodeType === 1) kids.push(n);
      else if (n.nodeType === 3 && n.nodeValue.trim()) kids.push(n);
    }
    if (!kids.length) return out + '/>\n';
    if (kids.length === 1 && kids[0].nodeType === 3) return out + '>' + escText(kids[0].nodeValue.trim()) + '</' + el.tagName + '>\n';
    out += '>\n';
    for (const k of kids) {
      out += k.nodeType === 1 ? serialize(k, depth + 1) : '    '.repeat(depth + 1) + escText(k.nodeValue.trim()) + '\n';
    }
    return out + pad + '</' + el.tagName + '>\n';
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escText(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  return { parse, build };
})();
