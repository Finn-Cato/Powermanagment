#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'settings', 'index.html');
let html = fs.readFileSync(file, 'utf8');

// ── EN fixes (line ~1065) ────────────────────────────────────────────────────
// Flow 1: "Set installation current — phases:" → "Set available current to — P1/P2/P3:"
html = html.replace(
  'Zaptec: Set installation current \u2014 phases: <span style="background:rgba(224,120,32,0.25);color:#e07820;border-radius:10px;padding:0 7px;font-size:10px;font-weight:600;">Current (A)</span></div></div><div style="background:rgba(255,255,255,0.04);border-radius:8px;padding:8px 10px;"><div style="font-size:10px;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:.8px;margin-bottom:5px;">Flow 2',
  'Zaptec: Set available current to \u2014 P1/P2/P3: <span style="background:rgba(224,120,32,0.25);color:#e07820;border-radius:10px;padding:0 7px;font-size:10px;font-weight:600;">Current (A)</span></div></div><div style="background:rgba(255,255,255,0.04);border-radius:8px;padding:8px 10px;"><div style="font-size:10px;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:.8px;margin-bottom:5px;">Flow 2'
);
// Flow 2: "Zaptec device: Charging button → Off" → "Zaptec: Stop charging"
html = html.replace(
  'THEN </span>Zaptec device: Charging button \u2192 <b>Off</b>',
  'THEN </span>Zaptec: Stop charging'
);
// Flow 3 step 1: "Zaptec device: Charging button → On" → "Zaptec: Start charging"
html = html.replace(
  'THEN 1 </span>Zaptec device: Charging button \u2192 <b>On</b>',
  'THEN 1 </span>Zaptec: Start charging'
);
// Flow 3 step 2: "Set installation current — phases:" → "Set available current to — P1/P2/P3:"
html = html.replace(
  'THEN 2 </span>Zaptec: Set installation current \u2014 phases: <span style="background:rgba(224,120,32,0.25);color:#e07820;border-radius:10px;padding:0 7px;font-size:10px;font-weight:600;">Current (A)</span>',
  'THEN 2 </span>Zaptec: Set available current to \u2014 P1/P2/P3: <span style="background:rgba(224,120,32,0.25);color:#e07820;border-radius:10px;padding:0 7px;font-size:10px;font-weight:600;">Current (A)</span>'
);
// EN tip at bottom
html = html.replace(
  'Tap each ampere field in Zaptec\\\'s action and select the <span style="background:rgba(224,120,32,0.25);color:#e07820;border-radius:10px;padding:0 6px;font-weight:600;">Current (A)</span> tag from Power Guard.',
  'Tap each current field in Zaptec\\\'s action and select the <span style="background:rgba(224,120,32,0.25);color:#e07820;border-radius:10px;padding:0 6px;font-weight:600;">Current (A)</span> tag from Power Guard. For 1-phase chargers set P2 and P3 to 0.'
);

// ── NO fixes (line ~1417) ────────────────────────────────────────────────────
// Flow 1: "Sett installasjonsstrøm — faser:" → "Sett tilgjengelig strøm til — Strøm P1/P2/P3:"
html = html.replace(
  'Zaptec: Sett installasjonsstr\u00f8m \u2014 faser: <span style="background:rgba(224,120,32,0.25);color:#e07820;border-radius:10px;padding:0 7px;font-size:10px;font-weight:600;">Ladestr\u00f8m</span></div></div><div style="background:rgba(255,255,255,0.04);border-radius:8px;padding:8px 10px;"><div style="font-size:10px;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:.8px;margin-bottom:5px;">Flow 2',
  'Zaptec: Sett tilgjengelig str\u00f8m til \u2014 Str\u00f8m P1/P2/P3: <span style="background:rgba(224,120,32,0.25);color:#e07820;border-radius:10px;padding:0 7px;font-size:10px;font-weight:600;">Ladestr\u00f8m</span></div></div><div style="background:rgba(255,255,255,0.04);border-radius:8px;padding:8px 10px;"><div style="font-size:10px;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:.8px;margin-bottom:5px;">Flow 2'
);
// Flow 2: "Zaptec-enhet: Ladeknapp → Av" → "Zaptec: Stopp lading"
html = html.replace(
  'S\u00c5 </span>Zaptec-enhet: Ladeknapp \u2192 <b>Av</b>',
  'S\u00c5 </span>Zaptec: Stopp lading'
);
// Flow 3 step 1: "Zaptec-enhet: Ladeknapp → På" → "Zaptec: Start lading"
html = html.replace(
  'S\u00c5 1 </span>Zaptec-enhet: Ladeknapp \u2192 <b>P\u00e5</b>',
  'S\u00c5 1 </span>Zaptec: Start lading'
);
// Flow 3 step 2: "Sett installasjonsstrøm — faser:" → "Sett tilgjengelig strøm til — Strøm P1/P2/P3:"
html = html.replace(
  'S\u00c5 2 </span>Zaptec: Sett installasjonsstr\u00f8m \u2014 faser: <span style="background:rgba(224,120,32,0.25);color:#e07820;border-radius:10px;padding:0 7px;font-size:10px;font-weight:600;">Ladestr\u00f8m</span>',
  'S\u00c5 2 </span>Zaptec: Sett tilgjengelig str\u00f8m til \u2014 Str\u00f8m P1/P2/P3: <span style="background:rgba(224,120,32,0.25);color:#e07820;border-radius:10px;padding:0 7px;font-size:10px;font-weight:600;">Ladestr\u00f8m</span>'
);
// NO tip at bottom
html = html.replace(
  'Trykk p\u00e5 ampereverdien i Zaptec-aksjonen og velg <span style="background:rgba(224,120,32,0.25);color:#e07820;border-radius:10px;padding:0 6px;font-weight:600;">Ladestr\u00f8m</span>-taggen fra Power Guard.',
  'Trykk p\u00e5 str\u00f8mfeltet i Zaptec-aksjonen og velg <span style="background:rgba(224,120,32,0.25);color:#e07820;border-radius:10px;padding:0 6px;font-weight:600;">Ladestr\u00f8m</span>-taggen fra Power Guard. For 1-fase lader, sett P2 og P3 til 0.'
);

fs.writeFileSync(file, html, 'utf8');
console.log('Done. Verifying...');

// Quick verify
['Set available current to', 'Stop charging', 'Start charging',
 'Sett tilgjengelig str\u00f8m til', 'Stopp lading', 'Start lading'].forEach(s => {
  console.log(html.includes(s) ? `  OK: "${s}"` : `  MISSING: "${s}"`);
});
['Set installation current', 'Charging button', 'Sett installasjonsstr\u00f8m', 'Ladeknapp'].forEach(s => {
  const n = (html.match(new RegExp(s, 'g')) || []).length;
  if (n > 0) console.log(`  WARN: "${s}" still appears ${n} times`);
});
