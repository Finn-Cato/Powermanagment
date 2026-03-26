# Power Guard — Project Rules

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

### 3. Update the Help tab before publishing
- Before publishing, review the Help tab content in `settings/index.html` and make sure it reflects any feature changes included in this release.
- If the help text is outdated, update it first, then publish.

### 4. Pre-publish checklist (all automatic)
- [ ] Version bumped by exactly 0.0.1 in `app.json`
- [ ] `.homeychangelog.json` updated in both EN and NO based on git log
- [ ] Help tab in `settings/index.html` reviewed and updated if needed
- [ ] `homey app run` started and confirmed zero deprecation warnings
- [ ] Working folder confirmed as `C:\Github\Powermanagment`
- [ ] `homey app publish` run from that folder

---

## After every code change
Use `homey app install` (permanent, keeps settings) — NOT `homey app run` (temporary debug session only).

---

## Committing to GitHub
- Write clear commit messages describing *why* the change was made.
- Update `README.md` if any feature behaviour changes.

---

## General
- Never bump the version without also updating `.homeychangelog.json`.
- Never publish without checking the Help tab is up to date.
- The `.homeyignore` file must exclude all dev-only files (audit reports, internal docs, etc.).
- NEVER run `homey app publish` unless the user explicitly asks to publish to the App Store.
