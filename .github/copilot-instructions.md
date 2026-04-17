# Power Guard — Project Rules for Claude

## Working folder
Always work in `C:\Github\Powermanagment`. Never use `C:\Github – Backup_0.2.22\Powermanagment`.

---

## Publishing to Homey App Store

Do all of the following automatically — no need to ask the user for confirmation on these steps:

### 1. Version bump
- Increment the **patch version by exactly 0.0.1** every time — e.g. 0.8.20 → 0.8.21.
- Never skip versions. Never bump minor or major unless the user explicitly asks.
- Update the version in `app.json`.

### 2. Changelog
- Check `git log` since the last published version to find all commits made since the last Homey App Store upload.
- Use those commits to write the changelog entry — do not make it up.
- Add the entry to `.homeychangelog.json` in **both** `en` (English) and `no` (Norwegian Bokmål).
- Do this automatically without asking the user.
- **Changelog style: short bullet lines only.** Each change gets one short line, no long sentences. Example:
  - `Fix: EV charger no longer restarts after completed session`
  - `New: Timeline notification when charging is done`
  - `Fix: HAN poll no longer triggers mitigation engine`

### 3. Update the Help tab before publishing
- Before publishing, review the Help tab content in `settings/index.html` and make sure it reflects any feature changes included in this release.
- If the help text is outdated, update it first, then publish.

### 4. Pre-publish checklist (all automatic)
- [ ] Version bumped by exactly 0.0.1 in `app.json`
- [ ] `.homeychangelog.json` updated in both EN and NO based on git log
- [ ] Help tab in `settings/index.html` reviewed and updated if needed
- [ ] Working folder confirmed as `C:\Github\Powermanagment`
- [ ] `homey app publish` run from that folder — answer **No** if the CLI asks to bump version (already done), paste the changelog text when prompted

### 5. Full permissions
The user has granted full permission to publish without asking any questions. Never ask the user to confirm version numbers, changelog text, or any publish step. Just do it.

---

## Committing to GitHub

- Run `homey app run` and confirm no deprecation warnings before committing.
- Write clear commit messages describing *why* the change was made.
- Update `README.md` if any feature behaviour changes.

---

## Locked code sections in app.js

Some sections of `app.js` are considered stable and must not be changed without explicit user approval.

### Hard locked — NEVER touch without the user explicitly saying so

| Section | Line approx. | What it does |
|---------|-------------|--------------|
| **Section 1** | ~38 | Core infrastructure — startup, settings load, state init |
| **Section 2** | ~716 | HAN/power meter — spike filter, event handling, poll fallback |
| **Section 3** | ~1186 | Energy tracking — hourly accumulation, effekttariff calendar |
| **Section 4** | ~1391 | Mitigation engine — power limits, shed/restore logic |
| **Section 9** | ~3794 | Easee charger integration — API commands, confirmation, reliability |
| **Section 12** | ~4867 | Spot price engine — price fetching, charge window logic |

**Rule:** If a bug or feature request touches any of these sections, stop and tell the user which locked section is involved and why a change is needed. Do not proceed until the user explicitly says "yes, change Section X".

### Soft locked — requires explicit agreement before changing

| Section | Line approx. | What it does |
|---------|-------------|--------------|
| **Section 5** | ~2261 | EV charger general engine — `_adjustEVChargersForPower`, ramp/pause/resume logic |

**Rule:** Changes to Section 5 require the user to explicitly agree ("yes, let's change the charging logic") before any edits are made. Always explain what will change and why before touching it.

---

## General
- **EXPLAIN BEFORE CHANGING — THIS IS CRITICAL:** When the user asks a question or asks to investigate something, always explain the finding and proposed change in chat first. Never edit code as part of an investigation or analysis. Only make code changes after the user has confirmed with "ja" or equivalent explicit approval.
- Never bump the version without also updating `.homeychangelog.json`.
- Never publish without checking the Help tab is up to date.
- The `.homeyignore` file must exclude all dev-only files (audit reports, internal docs, etc.).
- NEVER run `homey app publish` unless the user explicitly asks to publish to the App Store.
- After every code change: use `homey app install` (permanent, keeps settings) — NOT `homey app run` (temporary debug session only).
- `CLAUDE.md` and `.github/copilot-instructions.md` must always be kept identical. If one is updated, update the other immediately to match.

---

## Koble til Homey og lese live app-status

**Homey IP:** `192.168.10.173`  
**Auth token:** hentes fra `C:\Users\FinnCatoAndersen\AppData\Roaming\athom-cli\settings.json` — nøkkelen starter med `homey-`  
**App ID:** `no.powerguard`  
**Hjelper-script:** `C:\Github\Powermanagment\fetch_pg.js` — kjør med `node fetch_pg.js` for rask logg-dump

**Hente full live-status (lader, power, mitigation, logg):**
```javascript
// Kjør fra C:\Github\Powermanagment:
node -e "
const http=require('http'),fs=require('fs'),path=require('path'),os=require('os');
const c=JSON.parse(fs.readFileSync(path.join(os.homedir(),'AppData','Roaming','athom-cli','settings.json'),'utf8'));
const k=Object.keys(c.homeyApi).find(k=>k.startsWith('homey-'));
const token=c.homeyApi[k].token;
const req=http.request({host:'192.168.10.173',port:80,path:'/api/app/no.powerguard/all',method:'GET',headers:{Authorization:'Bearer '+token}},r=>{
  let b='';r.on('data',d=>b+=d);r.on('end',()=>{
    const st=JSON.parse(b).status||{};
    console.log('Power:',st.currentPowerW+'W / '+st.limitW+'W  overLimit:'+st.overLimitCount);
    (st.evChargers||[]).forEach(ch=>console.log(ch.name+': '+ch.statusLabel+' | '+ch.powerW+'W | offered='+ch.offeredCurrent+'A'));
    (st.lastMitigationScan||[]).forEach(m=>console.log(m.name+': '+m.result));
    (st.log||[]).slice(-20).forEach(l=>console.log(l.time.slice(11,19)+' ['+l.category+'] '+l.message));
  });
});
req.on('error',e=>console.error(e.message));req.setTimeout(10000,()=>req.destroy());req.end();
"
```

**Viktige felt i `status`-objektet:**
- `evChargers[]` — lader-tilstand: `statusLabel`, `powerW`, `offeredCurrent`, `currentA`, `chargeNow`
- `currentPowerW` / `limitW` / `overLimitCount` — nåværende belastning
- `mitigatedDevices[]` — enheter PG kontrollerer akkurat nå
- `lastMitigationScan[]` — siste kjøring av mitigation-listen (årsak til skip/handling)
- `log[]` — app-logg (kategori: `charger`, `han`, `mitigation`, `system`, `energy`)

**Alle Homey-enheter med measure_power:**
```javascript
node -e "... path:'/api/manager/devices/device' ..."
// Se tidligere kjøringer i chat-historikk for full versjon
```
