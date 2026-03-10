#!/usr/bin/env node
// Auto-answers the interactive prompts in `homey app publish`
const { spawn } = require('child_process');

const CHANGELOG = `EV charger anti-hunt fix: charger no longer oscillates up/down around the power limit. Increases are now rate-limited (max +2A per 60s), decreases remain fast (15s). Safety buffer increased from 200W to 400W to absorb household fluctuation.`;

const proc = spawn('homey', ['app', 'publish'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: true,
  cwd: process.cwd(),
});

let buf = '';
let uncommittedAnswered = false;
let versionAnswered = false;
let changelogAnswered = false;

proc.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  buf += text;

  if (!uncommittedAnswered && buf.includes('uncommitted changes')) {
    uncommittedAnswered = true;
    setTimeout(() => { proc.stdin.write('y\n'); }, 200);
  }

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
