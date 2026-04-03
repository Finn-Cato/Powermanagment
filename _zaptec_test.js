// Verify Zaptec Go via PG's internal zaptecTest endpoint
// Run AFTER customer has updated to v0.8.65
const { AthomCloudAPI } = require('./node_modules/homey-api');
const fs = require('fs'), path = require('path'), https = require('https');

const DEVICE_ID = '19b8b36c-7aa4-4e40-a18d-3c50b4faaa86';
const HOMEY_ID  = '677c11860c83982538723d67';

const settings = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA,'athom-cli','settings.json'),'utf8'));
const token = new AthomCloudAPI.Token(settings.homeyApi.token);
const cloud = new AthomCloudAPI({ clientId: '5a8d4ca6eb9f7a2c8b3d7e1f', clientSecret: 'dummy', token });

let sessionToken = null;
const origReq = https.request;
https.request = function(u, o, c) {
  const host = typeof u === 'object' ? (u.hostname||'') : String(u);
  if (host.includes(HOMEY_ID.slice(0,10))) {
    const h = (typeof u === 'object' ? u.headers : {}) || {};
    const a = h['Authorization'] || h['authorization'];
    if (a && !sessionToken) sessionToken = String(a);
  }
  return origReq.call(this, u, o, c);
};

async function main() {
  const user = await cloud.getAuthenticatedUser();
  const homey = await user.getHomeyById(HOMEY_ID);
  const api = await homey.authenticate();
  const baseUrl = await api.baseUrl;
  await api.apps.getApp({ id: 'no.powerguard' });
  await new Promise(r => setTimeout(r, 300));

  const version = (await api.apps.getApp({ id: 'no.powerguard' })).version;
  console.log('PG version:', version);

  // Check Zaptec app version
  try {
    const zaptecApp = await api.apps.getApp({ id: 'com.zaptec' });
    console.log('Zaptec app version:', zaptecApp.version, '| enabled:', zaptecApp.enabled);
  } catch(e) { console.log('Zaptec app: not found -', e.message); }

  // Dump ALL flow actions to see what's available
  const allActions = await api.flow.getFlowCardActions();
  const allArr = Object.values(allActions);
  console.log(`\nTotal flow actions: ${allArr.length}`);
  const zaptecActions = allArr.filter(a => (a.uri||'').toLowerCase().includes('zaptec'));
  console.log(`Zaptec flow actions (${zaptecActions.length}):`, zaptecActions.map(a => `${a.uri}/${a.id}`));
  if (zaptecActions.length === 0) {
    console.log('Sample of all URIs:', [...new Set(allArr.map(a => a.uri))].slice(0, 20));
  }

  // Try calling runFlowCardAction directly and capture exact error message
  console.log('\n=== Direkte flow-kall test ===');
  const device = await api.devices.getDevice({ id: DEVICE_ID });
  for (const actionId of ['installation_current_control', 'home_installation_current_control']) {
    try {
      await api.flow.runFlowCardAction({
        uri:  'homey:app:com.zaptec',
        id:   actionId,
        args: { device: { id: DEVICE_ID, name: device.name }, current1: 6, current2: 6, current3: 6 }
      });
      console.log(`  ${actionId}: SUKSES!`);
    } catch(e) {
      console.log(`  ${actionId}: "${e.message}"`);
    }
  }

  if (version < '0.8.65') { console.error('Trenger v0.8.65+'); return; }

  console.log('\n=== Test 6A ===');
  const r6 = await fetch(`${baseUrl}/api/app/no.powerguard/zaptec-test?deviceId=${DEVICE_ID}&amps=6`,
    { headers: { Authorization: sessionToken } }).then(r => r.json());
  console.log(JSON.stringify(r6, null, 2));

  await new Promise(r => setTimeout(r, 5000));

  console.log('\n=== Test 7A ===');
  const r7 = await fetch(`${baseUrl}/api/app/no.powerguard/zaptec-test?deviceId=${DEVICE_ID}&amps=7`,
    { headers: { Authorization: sessionToken } }).then(r => r.json());
  console.log(JSON.stringify(r7, null, 2));

  await new Promise(r => setTimeout(r, 5000));

  console.log('\n=== Test tilbake 6A ===');
  const r6b = await fetch(`${baseUrl}/api/app/no.powerguard/zaptec-test?deviceId=${DEVICE_ID}&amps=6`,
    { headers: { Authorization: sessionToken } }).then(r => r.json());
  console.log(JSON.stringify(r6b, null, 2));

  console.log('\n=== KONKLUSJON ===');
  const confirms = [r6, r7, r6b].filter(r => r.confirmed?.startsWith('Changed')).length;
  console.log(`${confirms}/3 kommandoer bekreftet (available_installation_current endret seg)`);
}

main().catch(e => console.error('Error:', e.message || e));
