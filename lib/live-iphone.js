// A real iPhone or iPad for `looktap live`, on a worker thread of its own: its screen as screenshots through the
// XCUITest runner, and the page's gestures sent back through it.
//
// A thread of its own because the first contact can build and install the runner (xcodebuild, a minute, run
// synchronously), and the server's thread has other devices' frames to pass on meanwhile.
//
// iOS gives the Mac no video of a phone's screen except over a cable to QuickTime's capture device, so this is a
// picture every few hundred milliseconds, over USB or Wi-Fi alike. And the runner takes whole gestures, not a finger
// that moves: the page's drag is sent as one swipe when the mouse is released.
import { parentPort, workerData } from 'node:worker_threads';

import { IosDevice, lastTeam } from './iosdevice.js';
import { runAction } from './live-actions.js';
import { sleep } from './util.js';

/**
 Between two screenshots (ms). The runner does one thing at a time, in the order asked, so an agent's command waits
 for one screenshot at most (about 0.2 s) however short this is: it only keeps the phone from doing nothing else.
 */
const GAP_MS = 30;
/**
 After a failure (a locked phone, a runner that can't be built), before the next try (ms): 4 s, then twice as long each
 time up to a minute. A failed start can be a whole xcodebuild, and one of those every few seconds helps nobody.
 */
const RETRY_MS = 4000, RETRY_MAX_MS = 60000;
export const retryAfter = (failures) => Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** Math.max(0, failures - 1));

/**
 A press and release on the page → what to ask of the runner. `from`, `to`: where the finger went down and came up,
 as shares of the screen · `ms`: how long it was down · `screen`: its size in points.
 A finger that barely moved is a tap, or held past half a second a long press; anything else a swipe of that length.
 */
export function gesture(from, to, ms, screen) {
  const at = (p) => [Math.round(p.x * screen.w), Math.round(p.y * screen.h)];
  const [x1, y1] = at(from), [x2, y2] = at(to);
  if (Math.hypot(x2 - x1, y2 - y1) < 10) return ms >= 500 ? { op: 'longpress', args: [x1, y1, Math.min(5000, Math.round(ms))] } : { op: 'tapxy', args: [x1, y1] };
  return { op: 'swipe', args: [x1, y1, x2, y2, Math.max(100, Math.min(1500, Math.round(ms)))] };
}

/**
 Why a phone has no picture, in a line someone can act on: the page shows it on the phone's screen. xcodebuild's
 own wording (the project's path, the target, the profile's name) is left out.
 */
export function brief(message) {
  const text = String(message || '').split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
  if (/No Accounts/.test(text)) return 'Xcode has no Apple account. Sign in at Xcode → Settings → Accounts.';
  if (/doesn't include this iPhone/.test(text)) return "This phone isn't registered with the signing team. Run once: LOOKTAP_TEAM=<its team> looktap -d <this phone> app";
  if (/No profiles|provisioning profile|No signing certificate/i.test(text)) return "Xcode couldn't sign looktap's runner for this phone. Check your team in Xcode → Settings → Accounts.";
  if (/Certificate is not trusted/i.test(text)) return 'On the phone, trust the developer app: Settings → General → VPN & Device Management.';
  if (/paused on the iPhone/i.test(text)) return 'Paused on the phone: turn Allow control back on in the looktap runner app.';
  if (/locked/i.test(text)) return 'Unlock the phone.';
  if (/out of reach|not connected|unavailable|did not answer|timed out/i.test(text)) return "The phone isn't answering. Unlock it, on a cable or the same Wi-Fi.";
  const first = text.replace(/\S*\.xcodeproj: error: /g, '').split(/(?<=[.:]) /)[0];
  return first.length > 90 ? `${first.slice(0, 89)}…` : first;
}

if (parentPort) {
  // The team that last worked for this phone, before the one configured for all of them: a phone registered with
  // another team can't be signed for with that one.
  const d = new IosDevice(workerData.id, { team: lastTeam(workerData.id) || workerData.team });
  // Its touches are the person's at the page: drawn there with the pointer only, no glow (that's an agent's).
  d.noteVia = 'live';
  const todo = [];
  let watching = false, screen = null, wake = null, failures = 0;
  const post = (m, transfer) => parentPort.postMessage(m, transfer);
  parentPort.on('message', (m) => {
    if (m.type === 'watch') {
      // Asked to watch again: at once, not after what is left of an old retry's wait.
      if (m.on && !watching) (failures = 0), wake?.();
      watching = m.on;
      if (!m.on) wake?.();
      return;
    }
    todo.push(m);
    wake?.();
  });

  const shot = async () => {
    const r = await d.call('shot', { scale: 0.4, jpeg: 0.5 }, { timeout: 30000 });
    if (r.w && r.h) screen = { w: r.w, h: r.h };
    // An older runner (built before the jpeg option) answers with a PNG and no size: still a picture.
    const body = new Uint8Array(r.body);
    post({ type: 'frame', body }, [body.buffer]);
    // What the runner said of itself when it answered (when its build stops working, paused or not): for the page.
    // ...and the screen's size in points: an agent's touches can come in points (lib/iosdevice.js touchedShares).
    const info = d.runnerInfo && { ...d.runnerInfo, ...(screen && { screen }) };
    const runner = JSON.stringify(info || null);
    if (runner !== told) (told = runner), post({ type: 'runner', runner: info });
  };
  let told = 'null';

  const act = async (m) => {
    try {
      if (m.type === 'gesture') {
        if (!screen) await shot();
        if (!screen) throw new Error("the phone's runner is an older build: run any looktap command on it once, which rebuilds it");
        const g = gesture(m.from, m.to, m.ms, screen);
        await d[g.op](...g.args);
      } else if (m.type === 'shot') {
        const body = new Uint8Array(await d.picture(1));
        return post({ type: 'done', n: m.n, body }, [body.buffer]);
      } else if (m.type === 'action') return post({ type: 'done', n: m.n, said: await runAction(d, m.name, m.value) });
      else if (m.type === 'key') await d.keys([m.key]);
      else if (m.type === 'text') await d.type(m.text);
      else if (m.type === 'button' && m.name === 'home') await d.home();
      post({ type: 'done', n: m.n });
    } catch (e) {
      post({ type: 'done', n: m.n, error: brief(e.message || e) });
    }
  };

  (async () => {
    for (;;) {
      while (todo.length) await act(todo.shift());
      if (!watching) {
        await new Promise((r) => (wake = r));
        wake = null;
        continue;
      }
      try {
        await shot();
        failures = 0;
        await sleep(GAP_MS);
      } catch (e) {
        post({ type: 'error', text: brief(e.message || e) });
        // The wait ends early for something to do (a tap from the page): that isn't made to wait out a retry.
        await Promise.race([sleep(retryAfter(++failures)), new Promise((r) => (wake = r))]);
        wake = null;
      }
    }
  })();
}
