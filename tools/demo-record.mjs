/**
 * End-to-end walkthrough of 0G Flow, recorded as a video.
 *
 * Everything happens against production on 0G Aristotle mainnet. Nothing is
 * mocked and nothing is replayed:
 *
 *   - the conformance scenes make real calls to a real agent and write to
 *     0G Storage, which is why they take the better part of a minute;
 *   - the terminal scene spawns the real `npx @0gflow/verify` and streams that
 *     process's actual stdout into the page as it arrives. The panel is a
 *     terminal emulator, not a transcript — if the verifier failed, the
 *     failure would be what you see.
 *
 * A demo of a verifiability product that used fixtures would be self-defeating.
 *
 * Paced for narration: each scene holds long enough to be talked over at a
 * normal speaking rate.
 */

import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const SITE = 'https://explorer-production-25c8.up.railway.app';
const AGENTS = 'https://agents-production-1dcf.up.railway.app/agents';
const RUN = '0xd57a33da3eb401e06f18feaf23d6eccf07f56b6b01ed3e2823f44505a535edea';
const SPEC = `artifacts/runs/${RUN}.json`;
const REPO = 'C:\\Users\\aryan\\Desktop\\0G4G';

const SIZE = { width: 1280, height: 720 };

const hold = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Scrolls in small steps so the recording pans rather than jumping.
 *
 * `distance` is a fraction of whatever is actually scrollable, not a pixel
 * count. Fixed pixel distances overshot every short page and left the camera
 * parked at the bottom for the length of a hold — several seconds of a frame
 * that was not moving and had nothing new in it.
 */
async function glide(page, fraction, steps = 26) {
  const room = await page.evaluate(
    () => document.documentElement.scrollHeight - window.innerHeight,
  );
  const distance = Math.max(0, room) * fraction;
  if (distance < 8) {
    await hold(steps * 42);
    return;
  }
  for (let i = 0; i < steps; i += 1) {
    await page.mouse.wheel(0, distance / steps);
    await hold(42);
  }
}

/**
 * Brings a section into view by its heading.
 *
 * Preferred over `glide` wherever the narration names a specific part of the
 * page, because it lands on the thing being talked about however the layout
 * moves. Silent when the heading is absent — a missing section should not
 * abort a recording that is otherwise fine.
 */
async function to(page, heading) {
  const found = await page.evaluate((text) => {
    const match = [...document.querySelectorAll('h2, h3, .section-title, .label')].find((n) =>
      n.textContent?.toLowerCase().includes(text.toLowerCase()),
    );
    if (match === undefined) return false;
    const top = match.getBoundingClientRect().top + window.scrollY - 90;
    window.scrollTo({ top, behavior: 'smooth' });
    return true;
  }, heading);
  await hold(1100);
  return found;
}

/** Types into a field at human speed, so the viewer can read it appear. */
async function type(page, selector, text) {
  await page.click(selector);
  await page.fill(selector, '');
  await page.type(selector, text, { delay: 22 });
}

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: SIZE,
  recordVideo: { dir: 'out-full', size: SIZE },
  deviceScaleFactor: 1,
});
const page = await context.newPage();

import { mkdirSync } from 'node:fs';
mkdirSync('shots', { recursive: true });
/** Saves a still of the current frame, so the recording can be checked without ffmpeg. */
const shot = (name) => page.screenshot({ path: `shots/${name}.png` });

const t0 = Date.now();
const scene = (n, what) => {
  const s = Math.round((Date.now() - t0) / 1000);
  console.log(`  [${String(n).padStart(2)}] ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}  ${what}`);
};

// --- 1. The landing page -----------------------------------------------------
scene(1, 'landing — the claim');
await page.goto(`${SITE}/#/`, { waitUntil: 'networkidle' });
await hold(4500);
await glide(page, 0.34);
await hold(3600);
await glide(page, 0.33);
await hold(3600);
await glide(page, 0.33);
await hold(4000); // the contract addresses in the footer
await shot('01-landing-footer');

// --- 2. The directory --------------------------------------------------------
scene(2, 'agents listed on mainnet');
await page.goto(`${SITE}/#/agents`, { waitUntil: 'networkidle' });
await hold(4200);
await glide(page, 0.7);
await shot('02-agents');
await hold(4200);

// --- 3. One agent, in full ---------------------------------------------------
scene(3, 'a single agent — identity, signer, schema, track record');
await page.goto(`${SITE}/#/agent/5`, { waitUntil: 'networkidle' });
await hold(4500);
await glide(page, 0.45);
await hold(4200);
await glide(page, 0.4);
await shot('03-agent');
await hold(3600);

// --- 4. The jobs list --------------------------------------------------------
scene(4, 'jobs run on mainnet');
await page.goto(`${SITE}/#/runs`, { waitUntil: 'networkidle' });
await hold(3800);
await glide(page, 0.5);
await hold(2600);

// --- 5. A job, and its evidence ----------------------------------------------
scene(5, 'one run, step by step');
await page.goto(`${SITE}/#/run/${RUN}`, { waitUntil: 'networkidle' });
await hold(4500); // the header stats
await to(page, 'Steps');
await shot('05-steps');
await hold(6000); // the per-step hashes and browser-computed receipts
await to(page, 'could not check');
await shot('05-not-checked');
await hold(6000); // the honest part
await to(page, 'Identifiers');
await hold(3500);

// --- 6. Check it in the browser ----------------------------------------------
scene(6, 'verify page — the browser redoes the maths');
await page.goto(`${SITE}/#/verify`, { waitUntil: 'networkidle' });
await hold(3500);
await type(page, 'input[placeholder="0x…"]', RUN);
await hold(800);
await page.click('button[type="submit"]');
await page.waitForSelector('.panel.ok, .panel.bad, .panel.warn', { timeout: 60_000 }).catch(() => {});
await shot('06-verdict');
await hold(6000);

// --- 7. Publishing: an agent that fails ---------------------------------------
// The refusal comes first deliberately. A gate you only ever see open is not
// evidence of a gate.
scene(7, 'publish — an agent that fails the checks is refused');
await page.goto(`${SITE}/#/publish`, { waitUntil: 'networkidle' });
await hold(3500);
await type(page, 'input[type="url"]', `${AGENTS}/always-fails`);
await hold(900);
await page.click('button[type="submit"]');
await page.waitForSelector('text=NOT CONFORMANT', { timeout: 180_000 });
await hold(2500);
await to(page, 'Conformance');
await shot('07-refused');
await hold(6500); // let the failed checks be read

// --- 8. Publishing: an agent that passes --------------------------------------
scene(8, 'publish — a real conformance pass, ten live checks');
await page.goto(`${SITE}/#/publish`, { waitUntil: 'networkidle' });
await hold(2500);
await type(page, 'input[type="url"]', `${AGENTS}/publish`);
await hold(900);
await page.click('button[type="submit"]');
await page.waitForSelector('text=CONFORMANT', { timeout: 180_000 });
await hold(2500);
await to(page, 'Conformance');
await shot('08-conformant');
await hold(5500);
await glide(page, 0.45); // down into the listing form
await shot('08-listing-form');
await hold(5000);

// --- 9. The part that matters: verify without the website ---------------------
scene(9, 'terminal — the real verifier, live');
await page.goto(`${SITE}/#/verify`, { waitUntil: 'networkidle' });
await hold(1200);
await openTerminal(page);
await hold(2500);

await runInTerminal(
  page,
  `ZG_NETWORK=aristotle npx @0gflow/verify ${RUN.slice(0, 10)}…`,
  ['@0gflow/verify', RUN],
);
await shot('09-incomplete');
await hold(6000);

await runInTerminal(
  page,
  `ZG_NETWORK=aristotle npx @0gflow/verify ${RUN.slice(0, 10)}… --spec flow.json`,
  ['@0gflow/verify', RUN, '--spec', SPEC],
);
await shot('09-verified');
await hold(8000);

// --- 10. Close ----------------------------------------------------------------
scene(10, 'close');
// Via about:blank. Going straight from #/verify to #/ is a hash-only change,
// which does not reload the document — so the terminal this scene injected
// stayed on screen and the closing shot was five seconds of the previous one.
await page.goto('about:blank');
await page.goto(`${SITE}/#/`, { waitUntil: 'networkidle' });
await hold(2500);
await shot('10-close');
await hold(3500);

await context.close();
await browser.close();
console.log('\ndone — video in ./out-full');

/* -------------------------------------------------------------------------- */

/**
 * Replaces the page with a terminal panel.
 *
 * Styled to match the site so the cut does not jar, but it is a real console:
 * `runInTerminal` writes a child process's stdout into it as the bytes arrive.
 */
async function openTerminal(page) {
  await page.evaluate(() => {
    document.body.innerHTML = `
      <div id="term" style="
        position:fixed;inset:0;background:#08090b;color:#d7dae0;
        font:13.5px/1.65 'Geist Mono','SF Mono',Consolas,monospace;
        padding:34px 40px;overflow:hidden;white-space:pre-wrap;
        letter-spacing:.01em;">
        <div style="color:#b75fff;margin-bottom:18px;font-size:12px;letter-spacing:.14em">
          ANY MACHINE · NO ACCOUNT · READS 0G DIRECTLY
        </div><div id="out"></div></div>`;
    document.body.style.margin = '0';
  });
}

/** Strips ANSI so colour codes do not print as literal escapes. */
function clean(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '').replace(/\r/g, '');
}

/**
 * Runs the verifier for real and streams its output into the terminal panel.
 *
 * `label` is what the prompt line shows — the command elided to fit 1280px.
 * `args` is what actually runs. They must mean the same thing; if they ever
 * drift, the video is lying, so keep them next to each other at the call site.
 */
async function runInTerminal(page, label, args) {
  await page.evaluate((cmd) => {
    const out = document.getElementById('out');
    const line = document.createElement('div');
    line.style.margin = '14px 0 6px';
    line.innerHTML = `<span style="color:#b75fff">$</span> <span style="color:#fff">${cmd}</span>`;
    out.appendChild(line);
  }, label);
  await hold(900);

  const child = spawn('npx', ['-y', ...args], {
    cwd: REPO,
    env: { ...process.env, ZG_NETWORK: 'aristotle', FORCE_COLOR: '0', NO_COLOR: '1' },
    shell: true,
  });

  const write = async (chunk) => {
    const text = clean(chunk.toString('utf8'));
    // npm's own chatter is not part of the demonstration.
    if (/npm (notice|warn)/.test(text) && !text.includes('Run ')) return;
    await page.evaluate((t) => {
      const out = document.getElementById('out');
      out.appendChild(document.createTextNode(t));
      const term = document.getElementById('term');
      term.scrollTop = term.scrollHeight;
    }, text);
  };

  child.stdout.on('data', (c) => void write(c));
  child.stderr.on('data', (c) => void write(c));

  await new Promise((resolve) => child.on('close', resolve));
}
