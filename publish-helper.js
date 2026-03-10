#!/usr/bin/env node
// Auto-answers the interactive prompts in `homey app publish`
const { spawn } = require('child_process');

const CHANGELOG = `UI: Settings and System moved into Overview tab as sub-tabs (Overview / Settings / System) — reduces main tab bar clutter. Smart tab and Heaters tab are now mutually exclusive: Smart tab visible only when Smart Price Control is ON, Heaters tab visible only when OFF. Active Mode card hidden on Overview when Smart Price Control is OFF. Thermostat temperature control fixed: dual-format setCapabilityValue handles homey-api version differences. _applyMode now accepts optional filterDeviceId — changing a single device pref only re-applies that device, preventing EV chargers from being triggered on every thermostat click. All controlFloorHeater errors now surfaced in Log tab.`;

const proc = spawn('homey', ['app', 'publish'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: true,
  cwd: process.cwd(),
});

let buf = '';
let versionAnswered = false;
let changelogAnswered = false;

proc.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  buf += text;

  if (!versionAnswered && (buf.includes('version number') || buf.includes('update your app'))) {
    versionAnswered = true;
    setTimeout(() => {
      proc.stdin.write('n\n');
    }, 200);
  }

  if (versionAnswered && !changelogAnswered && (buf.includes("What's new") || buf.includes('Changelog') || buf.includes('changelog'))) {
    changelogAnswered = true;
    setTimeout(() => {
      proc.stdin.write(CHANGELOG + '\n');
      setTimeout(() => {
        proc.stdin.end();
      }, 500);
    }, 300);
  }
});

proc.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
});

proc.on('close', (code) => {
  console.log('\n[publish-helper] exited with code', code);
  process.exit(code || 0);
});

proc.on('error', (err) => {
  console.error('[publish-helper] error:', err.message);
  process.exit(1);
});
