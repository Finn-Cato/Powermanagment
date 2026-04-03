const { AthomCloudAPI } = require('./node_modules/homey-api');
const fs = require('fs'), path = require('path');
const https = require('https');

const settings = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA,'athom-cli','settings.json'),'utf8'));
const tokenObj = settings.homeyApi.token;
const token = new AthomCloudAPI.Token(tokenObj);
const cloud = new AthomCloudAPI({ clientId: '5a8d4ca6eb9f7a2c8b3d7e1f', clientSecret: 'dummy', token });

const origRequest = https.request;
let sessionToken = null;
https.request = function(urlOrOpts, optsOrCb, cb) {
  const hostname = typeof urlOrOpts === 'object' ? (urlOrOpts.hostname || '') : String(urlOrOpts);
  if (hostname.includes('677c11860')) {
    const headers = (typeof urlOrOpts === 'object' ? urlOrOpts.headers : {}) || {};
    const auth = headers['Authorization'] || headers['authorization'];
    if (auth && !sessionToken) sessionToken = String(auth);
  }
  return origRequest.call(this, urlOrOpts, optsOrCb, cb);
};

async function main() {
  const user = await cloud.getAuthenticatedUser();
  const homey = await user.getHomeyById('677c11860c83982538723d67');
  const homeyApi = await homey.authenticate();
  const baseUrl = await homeyApi.baseUrl;
  await homeyApi.apps.getApp({ id: 'no.powerguard' });
  await new Promise(r => setTimeout(r, 300));

  const [status, debuglog, appInfo] = await Promise.all([
    fetch(baseUrl + '/api/app/no.powerguard/status', { headers: { Authorization: sessionToken } }).then(r => r.json()),
    fetch(baseUrl + '/api/app/no.powerguard/debuglog', { headers: { Authorization: sessionToken } }).then(r => r.json()),
    homeyApi.apps.getApp({ id: 'no.powerguard' }),
  ]);

  console.log('=== APP VERSION ===');
  console.log('version:', appInfo.version, '| enabled:', appInfo.enabled, '| crashed:', appInfo.crashed);

  console.log('\n=== STATUS ===');
  console.log('power:', status.currentPowerW, 'W / limit:', status.limitW, 'W');
  console.log('mitigated:', JSON.stringify(status.mitigatedDevices, null, 2));
  console.log('evChargers:', JSON.stringify(status.evChargers, null, 2));
  console.log('\n=== MITIGATION LOG ===');
  (status.log || []).forEach(l => console.log(l));

  console.log('\n=== FULL DEBUG LOG ===');
  const lines = (debuglog.log || '').split('\n');
  console.log('(total lines:', lines.length, ')');
  lines.forEach(l => console.log(l));
}

main().catch(e => console.error(e.message || e));
