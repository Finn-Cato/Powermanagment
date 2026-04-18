const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const c = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'AppData', 'Roaming', 'athom-cli', 'settings.json'), 'utf8'));
const k = Object.keys(c.homeyApi).find(k => k.startsWith('homey-'));
const token = c.homeyApi[k].token;

const req = http.request({
  host: '192.168.10.173',
  port: 80,
  path: '/api/app/no.powerguard/all',
  method: 'GET',
  headers: { Authorization: 'Bearer ' + token }
}, function(res) {
  let b = '';
  res.on('data', function(d) { b += d; });
  res.on('end', function() {
    const d = JSON.parse(b);
    const log = (d.appLog || []).slice(-50);
    log.forEach(function(l) {
      process.stdout.write(l.time + ' [' + l.category + '] ' + l.message + '\n');
    });
    process.stdout.write('\n=== mitigated ===\n' + JSON.stringify(d.mitigatedDevices, null, 2) + '\n');
    process.stdout.write('power:' + d.currentPowerW + 'W  limit:' + d.limitW + 'W\n');

    // EV charger state
    if (d.evChargers) {
      process.stdout.write('\n=== EV chargers ===\n' + JSON.stringify(d.evChargers, null, 2) + '\n');
    }
    process.exit(0);
  });
});
req.on('error', function(e) { process.stdout.write('ERR=' + e.message + '\n'); process.exit(1); });
req.setTimeout(10000, function() { process.stdout.write('TIMEOUT\n'); req.destroy(); process.exit(1); });
req.end();
