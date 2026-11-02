// Draws the profile's cards as animated SVG files from public GitHub data.
//
//   GITHUB_TOKEN=... node scripts/generate.mjs
//
// GitHub runs no script and no page styles in a README, but an SVG shown as an
// image keeps the styles and animations inside it, so everything lives there:
// the photo goes in as base64 because such an image cannot load another file.
import { mkdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const LOGIN = process.env.PROFILE_LOGIN ?? 'aliulusux';
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) throw new Error('GITHUB_TOKEN is required');

const THEMES = {
  aurora: {
    bg0: '#0b0a1f', bg1: '#141033', panel: '#0f0d28', a: '#6c7cff', b: '#b56bff', c: '#ff5fd2',
    ink: '#f3f1ff', muted: '#9c97c4', line: '#34306a',
  },
  matrix: {
    bg0: '#04100a', bg1: '#071c12', panel: '#050f0a', a: '#16c172', b: '#39e27d', c: '#b6f09c',
    ink: '#d9ffe6', muted: '#6fb48c', line: '#14503a',
  },
  ember: {
    bg0: '#150909', bg1: '#2a0f0c', panel: '#190b0a', a: '#ff5c39', b: '#ff9a3d', c: '#ffd166',
    ink: '#fff3e6', muted: '#c49a86', line: '#5a2a20',
  },
};

const LANGUAGE_COLORS = {
  JavaScript: '#f1e05a', TypeScript: '#3178c6', CSS: '#663399', SCSS: '#c6538c', HTML: '#e34c26',
  Dart: '#00b4ab', Python: '#3572a5', Shell: '#89e051', Kotlin: '#a97bff', Swift: '#f05138',
};

const SANS = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
const MONO = `ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace`;

// ── Data ────────────────────────────────────────────────────────────────────

async function rest(path) {
  const res = await fetch(`https://api.github.com/${path}`, {
    headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

async function graphql(query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

/// Where each month begins along the calendar, for labelling it.
function monthsOf(weeks) {
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const out = [];
  let last = -1;
  weeks.forEach((week, w) => {
    const month = Number(week.contributionDays[0].date.slice(5, 7)) - 1;
    if (month !== last) {
      // The first, cut short by the year's edge, would run into the second.
      if (out.length === 1 && w < 3) out.pop();
      out.push({ w, label: names[month] });
      last = month;
    }
  });
  return out;
}

async function loadProfile() {
  const user = await rest(`users/${LOGIN}`);
  const repos = (await rest(`users/${LOGIN}/repos?per_page=100&type=owner&sort=pushed`))
    .filter((r) => !r.fork && !r.private && r.name !== LOGIN);

  const bytes = {};
  for (const repo of repos) {
    const languages = await rest(`repos/${LOGIN}/${repo.name}/languages`);
    for (const [name, n] of Object.entries(languages)) bytes[name] = (bytes[name] ?? 0) + n;
  }
  const total = Object.values(bytes).reduce((a, b) => a + b, 0) || 1;
  const languages = Object.entries(bytes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, n]) => ({ name, share: n / total }));

  const { user: graph } = await graphql(
    `query($login: String!) {
      user(login: $login) {
        contributionsCollection {
          contributionCalendar {
            totalContributions
            weeks { contributionDays { contributionCount date } }
          }
        }
      }
    }`,
    { login: LOGIN },
  );
  const calendar = graph.contributionsCollection.contributionCalendar;
  const weeks = calendar.weeks.map((w) => w.contributionDays.map((d) => d.contributionCount));
  const days = calendar.weeks.flatMap((w) => w.contributionDays);

  let streak = 0;
  let longest = 0;
  for (const d of days) {
    streak = d.contributionCount > 0 ? streak + 1 : 0;
    longest = Math.max(longest, streak);
  }

  return {
    login: LOGIN,
    name: user.name ?? LOGIN,
    avatar: user.avatar_url,
    followers: user.followers,
    publicRepos: repos.length,
    stars: repos.reduce((n, r) => n + r.stargazers_count, 0),
    since: user.created_at.slice(0, 4),
    repos: repos.slice(0, 4),
    languages,
    contributions: calendar.totalContributions,
    weeks,
    months: monthsOf(calendar.weeks),
    activeDays: days.filter((d) => d.contributionCount > 0).length,
    longestStreak: longest,
    busiest: days.reduce((m, d) => Math.max(m, d.contributionCount), 0),
  };
}

/// The photo twice over: small enough to embed, and as lines of characters.
async function loadPortrait(url) {
  const source = Buffer.from(await (await fetch(`${url}&s=400`)).arrayBuffer());
  const photo = await sharp(source).resize(200, 200).jpeg({ quality: 78 }).toBuffer();
  const COLS = 58;
  const ROWS = 29;
  const { data } = await sharp(source)
    .resize(COLS, ROWS, { fit: 'cover' })
    .grayscale()
    .normalise()
    .linear(1.35, -30)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ramp = ' .:-=+*#%@';
  const ascii = [];
  for (let y = 0; y < ROWS; y++) {
    let line = '';
    for (let x = 0; x < COLS; x++) {
      // Dark parts of the photo drawn densest: on a dark card the hair and the
      // outline of the head then stand out, and a light background falls away.
      const shade = 1 - data[y * COLS + x] / 256;
      line += ramp[Math.min(ramp.length - 1, Math.floor(shade ** 1.5 * ramp.length))];
    }
    ascii.push(line);
  }
  return { photo: `data:image/jpeg;base64,${photo.toString('base64')}`, ascii };
}

// ── Drawing helpers ─────────────────────────────────────────────────────────

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/// A card's outer shell; animations stop for anyone who asked for less motion.
const svg = (w, h, t, label, style, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">
<style>
text{font-family:${SANS}}
.mono{font-family:${MONO}}
${style}
@media (prefers-reduced-motion:reduce){*{animation:none!important;opacity:1!important;transform:none!important}}
</style>
<defs>
<linearGradient id="brand" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="${t.a}"/><stop offset=".5" stop-color="${t.b}"/><stop offset="1" stop-color="${t.c}"/></linearGradient>
<linearGradient id="edge" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="${t.a}" stop-opacity=".9"/><stop offset=".5" stop-color="${t.line}"/><stop offset="1" stop-color="${t.c}" stop-opacity=".7"/></linearGradient>
<clipPath id="card"><rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="22"/></clipPath>
</defs>
<g clip-path="url(#card)"><rect width="${w}" height="${h}" fill="${t.bg0}"/>${body}</g>
<rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="22" fill="none" stroke="url(#edge)" stroke-width="1.5"/>
</svg>
`;

/// Slow-drifting blurred light behind a card.
const blobs = (t, w, h) => `<defs><filter id="blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="50"/></filter></defs>
<g filter="url(#blur)" opacity=".75">
<circle class="d1" cx="${w * 0.14}" cy="${h * 0.15}" r="${h * 0.42}" fill="${t.a}"/>
<circle class="d2" cx="${w * 0.74}" cy="${h * 0.05}" r="${h * 0.36}" fill="${t.b}"/>
<circle class="d3" cx="${w * 0.56}" cy="${h * 1.05}" r="${h * 0.4}" fill="${t.c}"/>
</g>`;
const BLOB_STYLE = `.d1{animation:d1 14s ease-in-out infinite alternate}.d2{animation:d2 18s ease-in-out infinite alternate}.d3{animation:d3 16s ease-in-out infinite alternate}
@keyframes d1{to{transform:translate(90px,50px)}}@keyframes d2{to{transform:translate(-120px,60px)}}@keyframes d3{to{transform:translate(110px,-50px)}}`;

// ── Hero ────────────────────────────────────────────────────────────────────

function hero(p, photo, t) {
  const W = 1000;
  const H = 300;
  const phrases = ['Building things with JavaScript', 'Learning in public', 'Always shipping something new'];
  const cycle = phrases.length * 5;
  const typed = phrases
    .map((text, i) => {
      const width = text.length * 11.4;
      return `<g class="ph" style="animation-delay:${i * 5}s">
<clipPath id="ty${i}"><rect class="ty" style="--w:${width}px;animation-delay:${i * 5}s" x="290" y="168" height="32" width="${width}"/></clipPath>
<text clip-path="url(#ty${i})" x="290" y="190" font-size="20" class="mono" fill="${t.ink}" opacity=".88">${esc(text)}</text></g>`;
    })
    .join('');
  let chipX = 290;
  const chips = p.languages
    .slice(0, 4)
    .map((l, i) => {
      const w = l.name.length * 8.6 + 34;
      const chip = `<g class="chip" style="animation-delay:${0.5 + i * 0.14}s">
<rect x="${chipX}" y="218" width="${w}" height="34" rx="17" fill="${t.bg0}" fill-opacity=".55" stroke="${t.a}" stroke-opacity=".6"/>
<text x="${chipX + w / 2}" y="240" text-anchor="middle" font-size="14" font-weight="600" fill="${t.ink}">${esc(l.name)}</text></g>`;
      chipX += w + 10;
      return chip;
    })
    .join('');
  const stars = Array.from({ length: 26 }, (_, i) => {
    const x = (i * 379) % W;
    const y = (i * 137) % H;
    return `<circle class="tw" style="animation-delay:${(i * 0.37) % 4}s" cx="${x}" cy="${y}" r="${1 + (i % 3) * 0.5}" fill="#fff"/>`;
  }).join('');
  const style = `${BLOB_STYLE}
.tw{animation:tw 4s ease-in-out infinite}@keyframes tw{0%,100%{opacity:.08}50%{opacity:.85}}
.spin{transform-origin:150px 150px;animation:spin 7s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
.halo{transform-origin:150px 150px;animation:halo 3.6s ease-in-out infinite}@keyframes halo{50%{transform:scale(1.07);opacity:.35}}
.rise{animation:rise .9s cubic-bezier(.2,.9,.25,1.15) both}@keyframes rise{from{opacity:0;transform:translateY(16px)}}
.chip{animation:rise .7s cubic-bezier(.2,.9,.25,1.2) both}
.ph{opacity:0;animation:ph ${cycle}s linear infinite}@keyframes ph{0%,${(100 / phrases.length) * 0.94}%{opacity:1}${100 / phrases.length}%,100%{opacity:0}}
.ty{animation:ty ${cycle}s steps(32) infinite}@keyframes ty{0%{width:0}${(100 / phrases.length) * 0.45}%,100%{width:var(--w)}}
.star{transform-box:fill-box;transform-origin:center;animation:shoot 9s linear infinite}@keyframes shoot{0%{transform:translate(-120px,-40px);opacity:0}4%{opacity:1}14%{transform:translate(620px,190px);opacity:0}100%{opacity:0;transform:translate(620px,190px)}}`;
  return svg(W, H, t, `${p.name} (@${p.login})`, style, `
<rect width="${W}" height="${H}" fill="${t.bg1}"/>
${blobs(t, W, H)}
${stars}
<path class="star" d="M240 20 l-90 -28" stroke="#fff" stroke-width="2" stroke-linecap="round" opacity="0"/>
<rect x="22" y="22" width="${W - 44}" height="${H - 44}" rx="18" fill="${t.bg0}" fill-opacity=".42" stroke="#fff" stroke-opacity=".1"/>
<circle class="halo" cx="150" cy="150" r="104" fill="none" stroke="${t.b}" stroke-width="10" opacity=".65" style="filter:blur(10px)"/>
<circle class="spin" cx="150" cy="150" r="96" fill="none" stroke="url(#brand)" stroke-width="5" stroke-linecap="round" stroke-dasharray="210 92"/>
<clipPath id="face"><circle cx="150" cy="150" r="86"/></clipPath>
<image href="${photo}" x="64" y="64" width="172" height="172" clip-path="url(#face)" preserveAspectRatio="xMidYMid slice"/>
<g class="rise"><text x="290" y="82" font-size="16" letter-spacing="3" font-weight="700" fill="${t.c}" class="mono">@${esc(p.login)}</text></g>
<g class="rise" style="animation-delay:.12s"><text x="288" y="146" font-size="62" font-weight="800" letter-spacing="-1.5" fill="url(#brand)">${esc(p.name)}</text></g>
${typed}
${chips}`);
}

// ── Terminal ────────────────────────────────────────────────────────────────

function terminal(p, ascii, t) {
  const W = 1000;
  const H = 480;
  const rows = [
    ['Subject', p.name],
    ['Handle', `@${p.login}`],
    ['Status', 'Building | Learning | Shipping'],
    ['Languages', p.languages.slice(0, 3).map((l) => l.name).join(', ') || '-'],
    ['Repositories', p.publicRepos],
    ['Contributions', `${p.contributions} this year`],
    ['Active days', p.activeDays],
    ['Longest streak', `${p.longestStreak} day${p.longestStreak === 1 ? '' : 's'}`],
    ['Stars', p.stars],
    ['Followers', p.followers],
    ['On GitHub since', p.since],
    ['Contact', `github.com/${p.login}`],
  ];
  const lines = rows
    .map(([k, v], i) => {
      const y = 112 + i * 27;
      return `<g class="row" style="animation-delay:${0.5 + i * 0.13}s">
<text x="520" y="${y}" font-size="14" font-weight="700" fill="${t.b}" class="mono">${esc(k)}</text>
<line x1="660" x2="724" y1="${y - 4}" y2="${y - 4}" stroke="${t.line}" stroke-width="2" stroke-dasharray="2 5"/>
<text x="736" y="${y}" font-size="14" fill="${t.ink}" class="mono">${esc(v)}</text></g>`;
    })
    .join('');
  const art = ascii
    .map(
      (line, i) =>
        `<text class="mono art" style="animation-delay:${i * 0.045}s" x="42" y="${106 + i * 11.6}" font-size="11" textLength="402" lengthAdjust="spacingAndGlyphs" fill="url(#brand)" xml:space="preserve">${esc(line)}</text>`,
    )
    .join('');
  const style = `.art{animation:art .5s ease-out both}@keyframes art{from{opacity:0}}
.row{animation:row .5s ease-out both}@keyframes row{from{opacity:0;transform:translateX(-10px)}}
.scan{animation:scan 5s linear infinite}@keyframes scan{from{transform:translateY(0)}to{transform:translateY(362px)}}
.pulse{animation:pulse 1.6s ease-in-out infinite}@keyframes pulse{50%{opacity:.25}}
.cur{animation:cur 1s steps(2) infinite}@keyframes cur{to{opacity:0}}`;
  const grid = `<defs><pattern id="grid" width="18" height="18" patternUnits="userSpaceOnUse"><path d="M18 0H0V18" fill="none" stroke="${t.a}" stroke-opacity=".08"/></pattern>
<linearGradient id="beam" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${t.b}" stop-opacity="0"/><stop offset="1" stop-color="${t.b}" stop-opacity=".35"/></linearGradient></defs>`;
  return svg(W, H, t, `Profile scan of ${p.name}`, style, `${grid}
<rect width="${W}" height="${H}" fill="${t.panel}"/>
<rect width="${W}" height="48" fill="${t.bg1}"/>
<circle cx="28" cy="24" r="6" fill="#ff5f57"/><circle cx="48" cy="24" r="6" fill="#febc2e"/><circle cx="68" cy="24" r="6" fill="#28c840"/>
<text x="500" y="29" text-anchor="middle" font-size="13" fill="${t.muted}" class="mono">${esc(p.login)}@github ~ $ ./profile-scan --live</text>
<circle class="pulse" cx="918" cy="24" r="4" fill="${t.b}"/><text x="930" y="29" font-size="12" font-weight="700" letter-spacing="1.5" fill="${t.b}" class="mono">LIVE</text>
<rect x="24" y="68" width="440" height="388" rx="12" fill="url(#grid)" stroke="${t.line}"/>
<rect x="500" y="68" width="476" height="388" rx="12" fill="url(#grid)" stroke="${t.line}"/>
<text x="42" y="88" font-size="11" letter-spacing="2" fill="${t.muted}" class="mono">VISUAL.MAP</text>
<text x="520" y="88" font-size="11" letter-spacing="2" fill="${t.muted}" class="mono">SYSTEM.INFO</text>
${art}
<g clip-path="url(#ma)"><rect class="scan" x="25" y="60" width="438" height="34" fill="url(#beam)"/></g>
<clipPath id="ma"><rect x="24" y="94" width="440" height="362"/></clipPath>
${lines}
<rect class="cur" x="520" y="${112 + rows.length * 27 - 14}" width="9" height="16" fill="${t.b}"/>`);
}

// ── Contributions, as dots ──────────────────────────────────────────────────

function mix(c1, c2, f) {
  const n = (c, i) => parseInt(c.slice(1 + i * 2, 3 + i * 2), 16);
  const hex = [0, 1, 2].map((i) => Math.round(n(c1, i) + (n(c2, i) - n(c1, i)) * f).toString(16).padStart(2, '0'));
  return `#${hex.join('')}`;
}

function contributions(p, t) {
  const W = 1000;
  const H = 300;
  const ox = 70;
  const oy = 150;
  const step = (W - ox - 34) / 53;
  const round = (v) => Math.round(v * 10) / 10;
  const peak = Math.max(1, p.busiest);
  const circle = (x, y, r) => `M${round(x - r)} ${y}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0`;

  let empty = '';
  let lit = '';
  let every = '';
  let last = null;
  p.weeks.forEach((days, w) => {
    // The year's first week can begin part way through: keep each day on its row.
    const skip = w === 0 ? 7 - days.length : 0;
    days.forEach((n, index) => {
      const x = round(ox + w * step + step / 2);
      const y = round(oy + (index + skip) * step);
      every += circle(x, y, 5.4);
      last = { x, y };
      if (n === 0) {
        empty += circle(x, y, 4.4);
        return;
      }
      const f = Math.log(1 + n) / Math.log(1 + peak);
      const color = f < 0.5 ? mix(t.a, t.b, f * 2) : mix(t.b, t.c, (f - 0.5) * 2);
      const r = round(4.8 + f * 2);
      const delay = round(w * 0.016 + index * 0.03);
      lit += `<g class="dot" style="animation-delay:${delay}s"><circle class="glow" style="animation-delay:${round(delay * 2.3)}s" cx="${x}" cy="${y}" r="${round(r + 5)}" fill="${color}"/><circle cx="${x}" cy="${y}" r="${r}" fill="${color}"/></g>`;
    });
  });

  const months = p.months
    .map(({ w, label }) => `<text x="${round(ox + w * step + 1)}" y="${oy - 18}" font-size="12" fill="${t.muted}" class="mono">${label}</text>`)
    .join('');
  const weekdays = [['Mon', 1], ['Wed', 3], ['Fri', 5]]
    .map(([label, row]) => `<text x="${ox - 10}" y="${round(oy + row * step + 4)}" text-anchor="end" font-size="11" fill="${t.muted}" class="mono">${label}</text>`)
    .join('');
  const legend = [0, 0.33, 0.66, 1]
    .map((f, n) => `<circle cx="${W - 118 + n * 18}" cy="66" r="5" fill="${f === 0 ? t.a : f < 0.5 ? mix(t.a, t.b, f * 2) : mix(t.b, t.c, (f - 0.5) * 2)}"${f === 0 ? ' fill-opacity=".18"' : ''}/>`)
    .join('');
  const stat = (x, value, label, n) => `<g class="pop" style="animation-delay:${0.2 + n * 0.12}s"><text x="${x}" y="76" font-size="34" font-weight="800" fill="url(#brand)">${esc(value)}</text><text x="${x}" y="98" font-size="13" fill="${t.muted}">${esc(label)}</text></g>`;
  const style = `${BLOB_STYLE}
.dot{transform-box:fill-box;transform-origin:center;animation:dot .55s cubic-bezier(.2,.9,.25,1.5) both}@keyframes dot{from{transform:scale(0);opacity:0}}
.glow{opacity:.22;animation:glow 3.4s ease-in-out infinite}@keyframes glow{50%{opacity:.5}}
.pop{animation:pop .7s ease-out both}@keyframes pop{from{opacity:0;transform:translateY(10px)}}
.sweep{animation:sweep 6s ease-in-out infinite}@keyframes sweep{from{transform:translateX(-220px)}to{transform:translateX(${W}px)}}
.grid{animation:grid .9s ease-out both}@keyframes grid{from{opacity:0}}
.now{transform-box:fill-box;transform-origin:center;animation:now 2s ease-out infinite}@keyframes now{from{transform:scale(.5);opacity:.9}to{transform:scale(1.8);opacity:0}}`;
  return svg(W, H, t, `${p.contributions} contributions in the last year`, style, `
<defs>
<linearGradient id="beam" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="${t.b}" stop-opacity="0"/><stop offset=".5" stop-color="${t.c}" stop-opacity=".55"/><stop offset="1" stop-color="${t.b}" stop-opacity="0"/></linearGradient>
<mask id="dots" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><path d="${every}" fill="#fff"/></mask>
</defs>
<rect width="${W}" height="${H}" fill="${t.panel}"/>
${blobs(t, W, H).replace('opacity=".75"', 'opacity=".2"')}
<text x="36" y="36" font-size="12" letter-spacing="2.5" fill="${t.muted}" class="mono">CONTRIBUTIONS</text>
${stat(36, p.contributions, 'contributions this year', 0)}
${stat(290, p.activeDays, 'active days', 1)}
${stat(430, p.longestStreak, 'longest streak', 2)}
${stat(590, p.busiest, 'busiest day', 3)}
<text x="${W - 136}" y="70" text-anchor="end" font-size="11" fill="${t.muted}" class="mono">Less</text>${legend}<text x="${W - 50}" y="70" font-size="11" fill="${t.muted}" class="mono">More</text>
${months}${weekdays}
<path class="grid" d="${empty}" fill="${t.a}" fill-opacity=".16"/>
<g mask="url(#dots)"><rect class="sweep" x="0" y="${oy - 10}" width="220" height="${step * 7 + 10}" fill="url(#beam)"/></g>
${lit}
${last ? `<circle class="now" cx="${last.x}" cy="${last.y}" r="8" fill="none" stroke="${t.c}" stroke-width="1.5"/>` : ''}`);
}

// ── Languages ───────────────────────────────────────────────────────────────

function languages(p, t) {
  const W = 1000;
  const H = 176;
  const barW = W - 72;
  let x = 0;
  const parts = p.languages
    .map((l, i) => {
      const w = Math.max(3, l.share * barW);
      const part = `<rect class="part" style="animation-delay:${0.2 + i * 0.12}s" x="${36 + x}" y="58" width="${w}" height="16" fill="${LANGUAGE_COLORS[l.name] ?? mix(t.a, t.c, i / 5)}"/>`;
      x += w;
      return part;
    })
    .join('');
  const legend = p.languages
    .map((l, i) => {
      const lx = 36 + (i % 3) * 310;
      const ly = 106 + Math.floor(i / 3) * 30;
      return `<g class="fade" style="animation-delay:${0.5 + i * 0.1}s"><circle cx="${lx + 6}" cy="${ly - 5}" r="6" fill="${LANGUAGE_COLORS[l.name] ?? mix(t.a, t.c, i / 5)}"/><text x="${lx + 22}" y="${ly}" font-size="15" font-weight="600" fill="${t.ink}">${esc(l.name)}</text><text x="${lx + 240}" y="${ly}" text-anchor="end" font-size="14" fill="${t.muted}" class="mono">${(l.share * 100).toFixed(1)}%</text></g>`;
    })
    .join('');
  const style = `.part{transform-box:fill-box;transform-origin:0 50%;animation:part .8s ease-out both}@keyframes part{from{transform:scaleX(0)}}
.fade{animation:fade .6s ease-out both}@keyframes fade{from{opacity:0}}`;
  return svg(W, H, t, 'Languages in public repositories', style, `
<rect width="${W}" height="${H}" fill="${t.panel}"/>
<text x="36" y="38" font-size="12" letter-spacing="2.5" fill="${t.muted}" class="mono">LANGUAGES</text>
<clipPath id="pill"><rect x="36" y="58" width="${barW}" height="16" rx="8"/></clipPath>
<g clip-path="url(#pill)"><rect x="36" y="58" width="${barW}" height="16" fill="${t.line}"/>${parts}</g>
${legend}`);
}

// ── A project ───────────────────────────────────────────────────────────────

function wrap(text, max, lines) {
  const out = [''];
  for (const word of text.split(/\s+/)) {
    if ((out[out.length - 1] + ' ' + word).trim().length > max) {
      if (out.length === lines) {
        out[out.length - 1] = `${out[out.length - 1].slice(0, max - 1)}...`;
        break;
      }
      out.push(word);
    } else {
      out[out.length - 1] = (out[out.length - 1] + ' ' + word).trim();
    }
  }
  return out;
}

function project(repo, i, t) {
  const W = 490;
  const H = 170;
  const color = LANGUAGE_COLORS[repo.language] ?? t.b;
  const about = wrap(repo.description ?? 'Public project on GitHub.', 52, 2)
    .map((line, n) => `<text x="28" y="${88 + n * 22}" font-size="15" fill="${t.muted}">${esc(line)}</text>`)
    .join('');
  const style = `.in{animation:in .8s ${i * 0.12}s cubic-bezier(.2,.9,.25,1.1) both}@keyframes in{from{opacity:0;transform:translateY(12px)}}
.glow{animation:glow 6s ${i}s ease-in-out infinite alternate}@keyframes glow{from{transform:translateX(-60px);opacity:.25}to{transform:translateX(320px);opacity:.5}}`;
  return svg(W, H, t, `${repo.name} repository`, style, `
<rect width="${W}" height="${H}" fill="${t.panel}"/>
<defs><filter id="soft" x="-150%" y="-150%" width="400%" height="400%"><feGaussianBlur stdDeviation="34"/></filter></defs>
<circle class="glow" cx="120" cy="20" r="70" fill="${t.b}" filter="url(#soft)"/>
<g class="in">
<text x="28" y="54" font-size="24" font-weight="800" fill="url(#brand)">${esc(repo.name)}</text>
${about}
<circle cx="35" cy="140" r="6" fill="${color}"/><text x="50" y="145" font-size="13" fill="${t.ink}">${esc(repo.language ?? 'Code')}</text>
<text x="${W - 28}" y="145" text-anchor="end" font-size="13" fill="${t.muted}" class="mono">★ ${repo.stargazers_count}</text>
</g>`);
}

// ── The foot of the page ────────────────────────────────────────────────────

function footer(p, t) {
  const W = 1000;
  const H = 120;
  const wave = (y, a) => `M0 ${y}Q125 ${y - a} 250 ${y}T500 ${y}T750 ${y}T1000 ${y}T1250 ${y}T1500 ${y}T1750 ${y}T2000 ${y}V${H}H0Z`;
  const style = `.w1{animation:w 9s linear infinite}.w2{animation:w 14s linear infinite reverse}@keyframes w{to{transform:translateX(-1000px)}}`;
  return svg(W, H, t, 'Thanks for stopping by', style, `
<rect width="${W}" height="${H}" fill="${t.panel}"/>
<path class="w1" d="${wave(70, 26)}" fill="${t.a}" opacity=".35"/>
<path class="w2" d="${wave(84, 20)}" fill="${t.c}" opacity=".3"/>
<text x="500" y="46" text-anchor="middle" font-size="17" font-weight="600" fill="${t.ink}" class="mono">thanks for stopping by.</text>`);
}

// ── Everything ──────────────────────────────────────────────────────────────

const p = await loadProfile();
const { photo, ascii } = await loadPortrait(p.avatar);

for (const [name, t] of Object.entries(THEMES)) {
  const dir = `assets/${name}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/hero.svg`, hero(p, photo, t));
  writeFileSync(`${dir}/terminal.svg`, terminal(p, ascii, t));
  writeFileSync(`${dir}/contributions.svg`, contributions(p, t));
  writeFileSync(`${dir}/languages.svg`, languages(p, t));
  writeFileSync(`${dir}/footer.svg`, footer(p, t));
  p.repos.forEach((repo, i) => writeFileSync(`${dir}/project-${i + 1}.svg`, project(repo, i, t)));
}

// The projects change over time, so the page that links to them is written too.
const links = (theme) =>
  p.repos
    .map(
      (r, i) =>
        `<a href="https://github.com/${p.login}/${r.name}"><img src="assets/${theme}/project-${i + 1}.svg" width="49%" alt="${esc(r.name)}"></a>`,
    )
    .join('\n');
const page = (theme) => `<div align="center">

<a href="https://github.com/${p.login}"><img src="assets/${theme}/hero.svg" width="100%" alt="${esc(p.name)}"></a>

<img src="assets/${theme}/terminal.svg" width="100%" alt="Profile scan">

<img src="assets/${theme}/contributions.svg" width="100%" alt="${p.contributions} contributions in the last year">

<img src="assets/${theme}/languages.svg" width="100%" alt="Languages in public repositories">

${links(theme)}

<img src="assets/${theme}/footer.svg" width="100%" alt="Thanks for stopping by">

</div>
`;
const DEFAULT = process.env.PROFILE_THEME ?? 'aurora';
writeFileSync('README.md', page(DEFAULT));
writeFileSync(
  'THEMES.md',
  `# Themes\n\nThe profile uses **${DEFAULT}**. Set \`PROFILE_THEME\` in \`.github/workflows/update.yml\` to change it.\n\n${Object.keys(THEMES)
    .map((n) => `## ${n}\n\n<img src="assets/${n}/hero.svg" width="100%" alt="${n} hero">\n\n<img src="assets/${n}/terminal.svg" width="100%" alt="${n} terminal">\n\n<img src="assets/${n}/contributions.svg" width="100%" alt="${n} contributions">\n`)
    .join('\n')}`,
);

console.log(`${p.login}: ${p.publicRepos} repos, ${p.contributions} contributions, ${p.languages.length} languages`);
