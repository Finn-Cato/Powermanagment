'use strict';
// Patch: replace NO helpEvFlowControlled with visual flow cards
// Uses actual Unicode chars to avoid JS \uXXXX escape interpretation issues.
const fs = require('fs');
let html = fs.readFileSync('settings/index.html', 'utf8');

// Anchor: find the NO locale version (second/last occurrence of this key)
const NO_KEY_START = "helpEvFlowControlled: '<b>Flyt-styrt lader:</b>";
const NEXT_KEY     = "helpEvPhases: '<b>Automatisk";

const idx = html.lastIndexOf(NO_KEY_START);
if (idx === -1) { console.error('NO key not found'); process.exit(1); }
const endIdx = html.indexOf(NEXT_KEY, idx);
if (endIdx === -1) { console.error('NEXT_KEY not found'); process.exit(1); }

// Build the replacement block using actual Unicode (no \uXXXX escape sequences)
// so it renders correctly and avoids all JS-string-escape issues.
const flowCard = (title, when, then1, then2) => {
  const thenHtml = then2
    ? `<div style="font-size:11px;line-height:1.5;border-left:2px solid #22c55e;padding:2px 0 2px 8px;margin-bottom:2px;"><span style="font-size:9px;color:#22c55e;font-weight:700;text-transform:uppercase;letter-spacing:.6px;">SÅ 1 </span>${then1}</div><div style="color:#555;padding-left:14px;">↓</div><div style="font-size:11px;line-height:1.5;border-left:2px solid #2a84d4;padding:2px 0 2px 8px;"><span style="font-size:9px;color:#2a84d4;font-weight:700;text-transform:uppercase;letter-spacing:.6px;">SÅ 2 </span>${then2}</div>`
    : `<div style="font-size:11px;line-height:1.5;border-left:2px solid ${then1.startsWith('Zaptec:') ? '#2a84d4' : '#22c55e'};padding:2px 0 2px 8px;"><span style="font-size:9px;color:${then1.startsWith('Zaptec:') ? '#2a84d4' : '#22c55e'};font-weight:700;text-transform:uppercase;letter-spacing:.6px;">SÅ </span>${then1}</div>`;
  return `<div style="background:rgba(255,255,255,0.04);border-radius:8px;padding:8px 10px;"><div style="font-size:10px;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:.8px;margin-bottom:5px;">${title}</div><div style="font-size:11px;line-height:1.5;border-left:2px solid #e07820;padding:2px 0 2px 8px;"><span style="font-size:9px;color:#e07820;font-weight:700;text-transform:uppercase;letter-spacing:.6px;">NÅR </span><b>${when}</b></div><div style="color:#555;padding-left:14px;">↓</div>${thenHtml}</div>`;
};

const TOKEN = '<span style="background:rgba(224,120,32,0.25);color:#e07820;border-radius:10px;padding:0 7px;font-size:10px;font-weight:600;">Ladestrøm</span>';

const f1 = flowCard(
  'Flow 1 \u2014 Endre ladestrøm',
  'Ladestrøm bør endres',
  `Zaptec: Sett installasjonsstrøm \u2014 faser: ${TOKEN}`,
  null
);
const f2 = flowCard(
  'Flow 2 \u2014 Pause',
  'Ladingen bør stoppes',
  'Zaptec-enhet: Ladeknapp \u2192 <b>Av</b>',
  null
);
const f3 = flowCard(
  'Flow 3 \u2014 Gjenoppta',
  'Ladingen bør startes',
  'Zaptec-enhet: Ladeknapp \u2192 <b>På</b>',
  `Zaptec: Sett installasjonsstrøm \u2014 faser: ${TOKEN}`
);

const TOKEN2 = '<span style="background:rgba(224,120,32,0.25);color:#e07820;border-radius:10px;padding:0 6px;font-weight:600;">Ladestrøm</span>';
const newBlock =
  `helpEvFlowControlled: '<b>Flyt-styrt lader \u2014 Zaptec Go:</b><br>Aktiver for Zaptec Go. Homeys rettighetssystem blokkerer flyt-kall mellom apper \u2014 bruk disse 3 flowene for å videresende Power Guards kommandoer:<div style="margin-top:10px;display:flex;flex-direction:column;gap:8px;">${f1}${f2}${f3}</div><div style="margin-top:8px;font-size:11px;color:#888;">💡 Trykk på ampereverdien i Zaptec-aksjonen og velg ${TOKEN2}-taggen fra Power Guard.</div>',\n      `;

html = html.substring(0, idx) + newBlock + html.substring(endIdx);
fs.writeFileSync('settings/index.html', html, 'utf8');
console.log('NO replacement done OK, new file size:', html.length);
