#!/usr/bin/env node
'use strict';
const fs = require('fs'), path = require('path');
const file = path.join(__dirname, 'settings', 'index.html');
let html = fs.readFileSync(file, 'utf8');

// Fix unescaped apostrophe in EN tip: "Zaptec's" → "Zaptec\'s"
html = html.replace(
  "Tap a current field in Zaptec's action",
  "Tap a current field in Zaptec\\'s action"
);

fs.writeFileSync(file, html, 'utf8');
console.log('Fixed:', html.includes("Zaptec\\'s") ? 'OK' : 'MISSING');
console.log('Verify no raw apostrophe left:', !html.includes("Zaptec's action") ? 'OK' : 'STILL BROKEN');
