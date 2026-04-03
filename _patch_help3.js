#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'settings', 'index.html');
let html = fs.readFileSync(file, 'utf8');

// ── EN: fix token names and add tag-icon tip ─────────────────────────────────

// Flow 1 token: "Current (A)" is correct for Flow 1 (Ladestrøm bør endres → current_a titled "Current (A)")
// Flow 3 token: should be "Starting current (A)" not "Current (A)"
// Update Flow 3 THEN 2 token label
html = html.replace(
  'THEN 2 </span>Zaptec: Set available current to \u2014 P1/P2/P3: <span style="background:rgba(224,120,32,0.25);color:#e07820;border-radius:10px;padding:0 7px;font-size:10px;font-weight:600;">Current (A)</span>',
  'THEN 2 </span>Zaptec: Set available current to \u2014 P1/P2/P3: <span style="background:rgba(224,120,32,0.25);color:#e07820;border-radius:10px;padding:0 7px;font-size:10px;font-weight:600;">Starting current (A)</span>'
);

// EN tip: add tag-icon instruction and search tip
html = html.replace(
  'Tap each current field in Zaptec\\\'s action and select the <span style="background:rgba(224,120,32,0.25);color:#e07820;border-radius:10px;padding:0 6px;font-weight:600;">Current (A)</span> tag from Power Guard. For 1-phase chargers set P2 and P3 to 0.',
  'Tap a current field in Zaptec\'s action \u2014 it opens as a slider. Tap the \ud83c\udff7\ufe0f icon on the right to switch to token mode, then select the token from Power Guard (<b>Current (A)</b> in Flow\u00a01, <b>Starting current (A)</b> in Flow\u00a03). For 1-phase chargers set P2 and P3 to 0. Tip: if the WHEN cards are not visible when scrolling, search for them by name.'
);

// ── NO: fix token names and add tag-icon tip ─────────────────────────────────

// Flow 3 THEN 2 token: should be "Startstrøm (A)" not "Ladestrøm"
html = html.replace(
  'S\u00c5 2 </span>Zaptec: Sett tilgjengelig str\u00f8m til \u2014 Str\u00f8m P1/P2/P3: <span style="background:rgba(224,120,32,0.25);color:#e07820;border-radius:10px;padding:0 7px;font-size:10px;font-weight:600;">Ladestr\u00f8m</span>',
  'S\u00c5 2 </span>Zaptec: Sett tilgjengelig str\u00f8m til \u2014 Str\u00f8m P1/P2/P3: <span style="background:rgba(224,120,32,0.25);color:#e07820;border-radius:10px;padding:0 7px;font-size:10px;font-weight:600;">Startstr\u00f8m (A)</span>'
);

// Also update Flow 1 token to show the (A) suffix
html = html.replace(
  'S\u00c5 </span>Zaptec: Sett tilgjengelig str\u00f8m til \u2014 Str\u00f8m P1/P2/P3: <span style="background:rgba(224,120,32,0.25);color:#e07820;border-radius:10px;padding:0 7px;font-size:10px;font-weight:600;">Ladestr\u00f8m</span>',
  'S\u00c5 </span>Zaptec: Sett tilgjengelig str\u00f8m til \u2014 Str\u00f8m P1/P2/P3: <span style="background:rgba(224,120,32,0.25);color:#e07820;border-radius:10px;padding:0 7px;font-size:10px;font-weight:600;">Ladestr\u00f8m (A)</span>'
);

// NO tip: add tag-icon instruction and search tip
html = html.replace(
  'Trykk p\u00e5 str\u00f8mfeltet i Zaptec-aksjonen og velg <span style="background:rgba(224,120,32,0.25);color:#e07820;border-radius:10px;padding:0 6px;font-weight:600;">Ladestr\u00f8m</span>-taggen fra Power Guard. For 1-fase lader, sett P2 og P3 til 0.',
  'Trykk p\u00e5 et str\u00f8mfelt i Zaptec-aksjonen \u2014 det \u00e5pner seg som en skyveknapp. Trykk p\u00e5 \ud83c\udff7\ufe0f-ikonet til h\u00f8yre for \u00e5 bytte til token-modus, og velg token fra Power Guard (<b>Ladestr\u00f8m (A)</b> i Flow\u00a01, <b>Startstr\u00f8m (A)</b> i Flow\u00a03). For 1-fase lader sett P2 og P3 til 0. Tips: hvis NÅR-kortene ikke dukker opp ved scrolling, søk på dem direkte.'
);

fs.writeFileSync(file, html, 'utf8');
console.log('Done. Verifying...');

['Starting current (A)', 'Startstr\u00f8m (A)', 'Ladestr\u00f8m (A)', 'skyveknapp', 'slider'].forEach(s => {
  console.log(html.includes(s) ? `  OK: "${s}"` : `  MISSING: "${s}"`);
});
