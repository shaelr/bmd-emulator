// Reads and writes Videohub Ethernet Protocol text (TCP port 9990). An exported
// file is a series of request blocks that can be sent to a hub as-is.
window.BMD = window.BMD || {};

BMD.VideohubTxt = (function () {
  function blocks(text) {
    const out = [];
    let cur = null;
    for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
      const line = raw.replace(/\s+$/, '');
      if (!cur) {
        if (/^[A-Z][A-Z0-9 ]*:$/.test(line)) cur = { header: line.slice(0, -1), lines: [] };
        continue;
      }
      if (line === '') { out.push(cur); cur = null; continue; }
      cur.lines.push(raw.replace(/\r$/, ''));
    }
    if (cur) out.push(cur);
    return out;
  }

  // Also accepts a raw dump captured from a real hub (tools/videohub-push.mjs --dump).
  function parse(text) {
    const r = { model: null, inputs: null, outputs: null, inputLabels: {}, outputLabels: {}, routing: {} };
    let recognised = 0;
    for (const b of blocks(text)) {
      if (b.header === 'VIDEOHUB DEVICE') {
        recognised++;
        for (const l of b.lines) {
          const m = l.match(/^([^:]+):\s*(.*)$/);
          if (!m) continue;
          if (m[1] === 'Model name') r.model = m[2].trim();
          if (m[1] === 'Video inputs') r.inputs = parseInt(m[2], 10);
          if (m[1] === 'Video outputs') r.outputs = parseInt(m[2], 10);
        }
      } else if (b.header === 'INPUT LABELS' || b.header === 'OUTPUT LABELS') {
        recognised++;
        const target = b.header === 'INPUT LABELS' ? r.inputLabels : r.outputLabels;
        for (const l of b.lines) {
          const m = l.match(/^(\d+) ?(.*)$/);
          if (m) target[parseInt(m[1], 10)] = m[2];
        }
      } else if (b.header === 'VIDEO OUTPUT ROUTING') {
        recognised++;
        for (const l of b.lines) {
          const m = l.match(/^(\d+)\s+(\d+)/);
          if (m) r.routing[parseInt(m[1], 10)] = parseInt(m[2], 10);
        }
      }
    }
    if (!recognised) throw new Error('No Videohub protocol blocks found in this file.');
    return r;
  }

  function cleanLabel(s) {
    return String(s).replace(/[\r\n]+/g, ' ').trim();
  }

  // routing: array of input index (or null to leave that output untouched).
  function build({ inputLabels, outputLabels, routing }) {
    let out = '';
    if (inputLabels) {
      out += 'INPUT LABELS:\n' + inputLabels.map((l, i) => `${i} ${cleanLabel(l)}`).join('\n') + '\n\n';
    }
    if (outputLabels) {
      out += 'OUTPUT LABELS:\n' + outputLabels.map((l, i) => `${i} ${cleanLabel(l)}`).join('\n') + '\n\n';
    }
    if (routing) {
      const lines = [];
      routing.forEach((inp, o) => { if (inp !== null && inp !== undefined) lines.push(`${o} ${inp}`); });
      if (lines.length) out += 'VIDEO OUTPUT ROUTING:\n' + lines.join('\n') + '\n\n';
    }
    return out;
  }

  return { parse, build, blocks };
})();
