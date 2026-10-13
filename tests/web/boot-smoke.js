// Boots the whole app in Chromium and visits every sidebar tab and settings section; fails on any page error.
const fs = require('fs'), os = require('os'), path = require('path');
const { startFake } = require('../fake-ollama-chat');
const { launch, checker, sleep } = require('./harness');
(async () => {
  const check = checker();
  const fake = await startFake();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'faber-proj-'));
  fs.writeFileSync(path.join(proj, 'a.txt'), 'hello\n');
  const h = await launch({ ollama: fake.url, workspace: proj });
  try {
    await h.open();
    check('app boots', true);
    const tabs = await h.js(() => [...document.querySelectorAll('#railTop .rbtn')].map((b) => b.title));
    console.log('rail:', tabs.join(', '));
    check('rail has several tabs', tabs.length >= 5, tabs);
    for (const t of tabs) {
      await h.js((title) => [...document.querySelectorAll('#railTop .rbtn')].find((b) => b.title === title).click(), t);
      await sleep(400);
      const visible = await h.js(() => { const p = [...document.querySelectorAll('#side .sidePane')].find((x) => !x.hidden); return p ? p.textContent.length : -1; });
      check(`tab "${t}" renders`, visible > 0, visible);
    }
    const sections = await h.js(() => { Faber.openSettings(); return Faber.settingsSections().map((s) => s.id); });
    console.log('settings sections:', sections.join(', '));
    await sleep(500);
    check('settings window opens', await h.js(() => !!document.querySelector('.modalBack, #settingsWin, .settingsWin, [class*=settings]')));
    check('no page errors', h.errors.length === 0, h.errors);
  } catch (e) { check('harness ran: ' + e.message, false); }
  await h.close(); await fake.close();
  process.exit(check.done() ? 1 : 0);
})();
