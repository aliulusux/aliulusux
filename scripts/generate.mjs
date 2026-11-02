// Draws the profile's cards as animated SVG files, in the look of an old green
// command prompt, from public GitHub data and the totals in data/private.json.
//
//   GITHUB_TOKEN=... node scripts/generate.mjs
//
// GitHub runs no script and no page styles in a README, but an SVG shown as an
// image keeps the styles and animations inside it, so everything lives there.
// data/private.json holds totals only, sent by the private repository itself:
// this repository has no access to it, and never learns its name.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const LOGIN = process.env.PROFILE_LOGIN ?? 'aliulusux';
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) throw new Error('GITHUB_TOKEN is required');

const C = {
  bg: '#030a05',
  bar: '#0b1a0f',
  green: '#39ff7a',
  mid: '#22c55e',
  dim: '#15803d',
  faint: '#0f3d21',
  white: '#d6ffe3',
};
const MONO = `Consolas,'Lucida Console',ui-monospace,SFMono-Regular,Menlo,'Liberation Mono',monospace`;

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
    const month = Number(week[0].date.slice(5, 7)) - 1;
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
  const hidden = existsSync('data/private.json')
    ? JSON.parse(readFileSync('data/private.json', 'utf8'))
    : { private_repos: 0, commits: 0, days: {}, languages: {} };

  const user = await rest(`users/${LOGIN}`);
  const repos = (await rest(`users/${LOGIN}/repos?per_page=100&type=owner&sort=pushed`))
    .filter((r) => !r.fork && !r.private && r.name !== LOGIN);

  const bytes = { ...hidden.languages };
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
            weeks { contributionDays { contributionCount date } }
          }
        }
      }
    }`,
    { login: LOGIN },
  );
  // Each day's public contributions, and the private repository's commits.
  const weeks = graph.contributionsCollection.contributionCalendar.weeks.map((w) =>
    w.contributionDays.map((d) => ({
      date: d.date,
      n: d.contributionCount + (hidden.days[d.date] ?? 0),
    })),
  );
  const days = weeks.flat();

  let streak = 0;
  let longest = 0;
  for (const d of days) {
    streak = d.n > 0 ? streak + 1 : 0;
    longest = Math.max(longest, streak);
  }

  return {
    login: LOGIN,
    name: user.name ?? LOGIN,
    followers: user.followers,
    publicRepos: repos.length,
    privateRepos: hidden.private_repos,
    privateCommits: hidden.commits,
    stars: repos.reduce((n, r) => n + r.stargazers_count, 0),
    since: user.created_at.slice(0, 4),
    repos: repos.slice(0, 4),
    languages,
    contributions: days.reduce((sum, d) => sum + d.n, 0),
    weeks,
    months: monthsOf(weeks),
    activeDays: days.filter((d) => d.n > 0).length,
    longestStreak: longest,
    busiest: days.reduce((m, d) => Math.max(m, d.n), 0),
  };
}

// ── Drawing helpers ─────────────────────────────────────────────────────────

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const round = (v) => Math.round(v * 10) / 10;

const CHAR = 0.56;
let clips = 0;

/// A line of text that types itself out from [delay], one character at a time.
function typed(text, x, y, delay, { size = 17, fill = C.green, weight = 400 } = {}) {
  const id = `c${clips++}`;
  const width = round(text.length * size * CHAR + 6);
  const time = round(Math.min(1.1, 0.05 + text.length * 0.022));
  return `<clipPath id="${id}"><rect class="type" style="--w:${width}px;animation-duration:${time}s;animation-delay:${delay}s;animation-timing-function:steps(${Math.max(1, text.length)})" x="${x - 2}" y="${y - size - 2}" width="${width}" height="${size + 10}"/></clipPath>
<text clip-path="url(#${id})" x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" xml:space="preserve">${esc(text)}</text>`;
}

/// The prompt, then a command typing itself after it.
const prompt = (command, x, y, delay) =>
  typed(`C:\\Users\\${LOGIN}>${command}`, x, y, delay, { fill: C.white });

/// A window of the old command prompt: its title bar, the phosphor's scan lines
/// and glow, and a band of light rolling slowly down the glass.
function win(W, H, title, label, style, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">
<style>
text{font-family:${MONO}}
.type{width:0;animation-name:type;animation-fill-mode:forwards}@keyframes type{from{width:0}to{width:var(--w)}}
.show{opacity:0;animation:show .01s linear forwards}@keyframes show{to{opacity:1}}
.cur{animation:cur 1.05s steps(2,jump-none) infinite}@keyframes cur{to{opacity:0}}
.crt{animation:crt 7s linear infinite}@keyframes crt{0%,96%,100%{opacity:1}97%{opacity:.86}98.5%{opacity:.97}}
.roll{animation:roll 9s linear infinite}@keyframes roll{from{transform:translateY(-90px)}to{transform:translateY(${H + 30}px)}}
${style}
@media (prefers-reduced-motion:reduce){*{animation:none!important;opacity:1!important;transform:none!important}.type{width:var(--w)}}
</style>
<defs>
<pattern id="scan" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="2" fill="#000" fill-opacity=".28"/></pattern>
<linearGradient id="band" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${C.green}" stop-opacity="0"/><stop offset=".5" stop-color="${C.green}" stop-opacity=".07"/><stop offset="1" stop-color="${C.green}" stop-opacity="0"/></linearGradient>
<radialGradient id="glass" cx=".5" cy=".5" r=".75"><stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".6"/></radialGradient>
<filter id="glow" x="-5%" y="-20%" width="110%" height="140%"><feGaussianBlur stdDeviation="3.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<clipPath id="frame"><rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="10"/></clipPath>
</defs>
<g clip-path="url(#frame)">
<rect width="${W}" height="${H}" fill="${C.bg}"/>
<g class="crt">${body}</g>
<rect class="roll" y="0" width="${W}" height="90" fill="url(#band)"/>
<rect width="${W}" height="${H}" fill="url(#scan)"/>
<rect width="${W}" height="${H}" fill="url(#glass)"/>
<rect width="${W}" height="34" fill="${C.bar}"/>
<rect x="12" y="11" width="12" height="12" fill="none" stroke="${C.mid}"/><path d="M15 15h6M15 18h3" stroke="${C.mid}"/>
<text x="34" y="22" font-size="13" fill="${C.mid}">${esc(title)}</text>
<path d="M${W - 88} 21h10" stroke="${C.mid}" stroke-width="1.5"/>
<rect x="${W - 60}" y="12" width="10" height="10" fill="none" stroke="${C.mid}" stroke-width="1.5"/>
<path d="M${W - 30} 12l10 10M${W - 20} 12l-10 10" stroke="${C.mid}" stroke-width="1.5"/>
<line x1="0" x2="${W}" y1="34" y2="34" stroke="${C.dim}"/>
</g>
<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="10" fill="none" stroke="${C.dim}" stroke-width="1.5"/>
</svg>
`;
}

const cursor = (x, y, delay) =>
  `<g class="show" style="animation-delay:${delay}s"><rect class="cur" x="${x}" y="${y - 14}" width="10" height="17" fill="${C.green}"/></g>`;

// ── Boot, and the name in big letters ───────────────────────────────────────

const PIXELS = {
  A: ['01110', '10001', '11111', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '11111'],
  L: ['10000', '10000', '10000', '10000', '11111'],
  S: ['01111', '10000', '01110', '00001', '11110'],
  U: ['10001', '10001', '10001', '10001', '01110'],
  ' ': ['000', '000', '000', '000', '000'],
};

/// Letters drawn from squares, so that no font can break them apart.
function banner(text, x, y, cell, delay) {
  let cx = x;
  let squares = '';
  for (const letter of text.toUpperCase()) {
    const rows = PIXELS[letter] ?? PIXELS[' '];
    rows.forEach((row, ry) => {
      [...row].forEach((on, rx) => {
        if (on === '1') {
          squares += `<rect x="${cx + rx * cell}" y="${y + ry * cell}" width="${cell - 1}" height="${cell - 1}"/>`;
        }
      });
    });
    cx += (rows[0].length + 1) * cell;
  }
  return `<g class="show" style="animation-delay:${delay}s" fill="${C.green}" filter="url(#glow)">${squares}</g>`;
}

function boot(p) {
  const W = 1000;
  const H = 330;
  let at = 0.1;
  const next = (gap) => (at = round(at + gap));
  const body = [
    typed('ULUSU-DOS [Version 26.11]', 28, 66, at, { fill: C.mid }),
    typed(`Memory test ........ OK      GitHub link ........ OK      Member since ${p.since}`, 28, 90, next(0.4), {
      fill: C.mid,
      size: 15,
    }),
    prompt('banner.exe', 28, 128, next(0.8)),
    banner(p.name, 30, 146, 12, next(0.5)),
    prompt('echo %STATUS%', 28, 256, next(0.3)),
    typed('Building | Learning | Shipping', 28, 282, next(0.5), { weight: 700 }),
    prompt('', 28, 312, next(0.8)),
    cursor(28 + `C:\\Users\\${p.login}>`.length * 17 * CHAR + 4, 312, at + 0.1),
  ].join('\n');
  return win(W, H, `C:\\Users\\${p.login}\\cmd.exe`, `${p.name} (@${p.login})`, '', body);
}

// ── systeminfo ──────────────────────────────────────────────────────────────

function systeminfo(p) {
  const W = 1000;
  const rows = [
    ['Host Name', p.name],
    ['Handle', `@${p.login}`],
    ['Registered', p.since],
    ['Languages', p.languages.slice(0, 3).map((l) => l.name).join(', ') || '-'],
    ['Public Repositories', p.publicRepos],
    ...(p.privateRepos ? [['Private Repositories', `${p.privateRepos} (classified)`]] : []),
    ...(p.privateCommits ? [['Private Commits', p.privateCommits]] : []),
    ['Contributions (1 yr)', p.contributions],
    ['Active Days', p.activeDays],
    ['Longest Streak', `${p.longestStreak} day${p.longestStreak === 1 ? '' : 's'}`],
    ['Stars', p.stars],
    ['Followers', p.followers],
    ['Network', `github.com/${p.login}`],
  ];
  const H = 104 + rows.length * 25 + 34;
  const lines = rows
    .map(([k, v], i) => {
      const y = 104 + i * 25;
      const delay = round(0.5 + i * 0.09);
      return `<g class="show" style="animation-delay:${delay}s"><text x="28" y="${y}" font-size="16" fill="${C.mid}" xml:space="preserve">${esc(`${k}:`.padEnd(24))}</text><text x="310" y="${y}" font-size="16" fill="${C.white}">${esc(v)}</text></g>`;
    })
    .join('\n');
  const end = H - 22;
  const body = [
    prompt('systeminfo', 28, 70, 0.1),
    lines,
    prompt('', 28, end, round(0.6 + rows.length * 0.09)),
    cursor(28 + `C:\\Users\\${p.login}>`.length * 17 * CHAR + 4, end, round(0.7 + rows.length * 0.09)),
  ].join('\n');
  return win(W, H, 'systeminfo', `System information for ${p.name}`, '', body);
}

// ── Contributions, as dots ──────────────────────────────────────────────────

function mix(c1, c2, f) {
  const n = (c, i) => parseInt(c.slice(1 + i * 2, 3 + i * 2), 16);
  const hex = [0, 1, 2].map((i) => Math.round(n(c1, i) + (n(c2, i) - n(c1, i)) * f).toString(16).padStart(2, '0'));
  return `#${hex.join('')}`;
}

function contributions(p) {
  const W = 1000;
  const H = 318;
  const ox = 70;
  const oy = 158;
  const step = (W - ox - 34) / 54;
  const peak = Math.max(1, p.busiest);
  const circle = (x, y, r) => `M${round(x - r)} ${y}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0`;
  const shade = (f) => mix(C.dim, C.green, f);

  let empty = '';
  let lit = '';
  let last = null;
  p.weeks.forEach((days, w) => {
    // The year's first week can begin part way through: keep each day on its row.
    const skip = w === 0 ? 7 - days.length : 0;
    days.forEach((day, index) => {
      const x = round(ox + w * step + step / 2);
      const y = round(oy + (index + skip) * step);
      last = { x, y };
      if (day.n === 0) {
        empty += circle(x, y, 4.2);
        return;
      }
      const f = Math.log(1 + day.n) / Math.log(1 + peak);
      const r = round(4.6 + f * 2);
      const delay = round(0.5 + w * 0.014 + index * 0.02);
      lit += `<g class="dot" style="animation-delay:${delay}s"><circle class="halo" style="animation-delay:${round(delay * 2.3)}s" cx="${x}" cy="${y}" r="${round(r + 4.5)}" fill="${shade(f)}"/><circle cx="${x}" cy="${y}" r="${r}" fill="${shade(f)}"/></g>`;
    });
  });
  const months = p.months
    .map(({ w, label }) => `<text x="${round(ox + w * step + 1)}" y="${oy - 18}" font-size="12" fill="${C.mid}">${label}</text>`)
    .join('');
  const weekdays = [['Mon', 1], ['Wed', 3], ['Fri', 5]]
    .map(([label, row]) => `<text x="${ox - 10}" y="${round(oy + row * step + 4)}" text-anchor="end" font-size="11" fill="${C.mid}">${label}</text>`)
    .join('');
  const stat = (x, value, label, n) => `<g class="show" style="animation-delay:${round(0.3 + n * 0.12)}s"><text x="${x}" y="108" font-size="26" font-weight="700" fill="${C.green}" filter="url(#glow)">${esc(value)}</text><text x="${x + String(value).length * 15 + 10}" y="108" font-size="13" fill="${C.mid}">${esc(label)}</text></g>`;
  const style = `.dot{transform-box:fill-box;transform-origin:center;animation:dot .4s steps(4) both}@keyframes dot{from{transform:scale(0);opacity:0}}
.halo{opacity:.18;animation:halo 3.4s ease-in-out infinite}@keyframes halo{50%{opacity:.42}}
.now{transform-box:fill-box;transform-origin:center;animation:now 2s ease-out infinite}@keyframes now{from{transform:scale(.5);opacity:.9}to{transform:scale(1.8);opacity:0}}`;
  const body = `${prompt('git log --graph --since="1 year ago"', 28, 70, 0.1)}
${stat(28, p.contributions, 'contributions', 0)}
${stat(280, p.activeDays, 'active days', 1)}
${stat(460, p.longestStreak, 'day streak', 2)}
${stat(640, p.busiest, 'on the busiest day', 3)}
${months}${weekdays}
<path d="${empty}" fill="${C.faint}"/>
${lit}
${last ? `<circle class="now" cx="${last.x}" cy="${last.y}" r="8" fill="none" stroke="${C.green}" stroke-width="1.5"/>` : ''}`;
  return win(W, H, 'git log', `${p.contributions} contributions in the last year`, style, body);
}

// ── Languages, as progress bars ─────────────────────────────────────────────

function languages(p) {
  const W = 1000;
  const H = 96 + p.languages.length * 28 + 8;
  const CELLS = 46;
  const lines = p.languages
    .map((l, i) => {
      const y = 104 + i * 28;
      const delay = round(0.4 + i * 0.16);
      const lit = Math.max(1, Math.round(l.share * CELLS));
      let cells = '';
      for (let c = 0; c < CELLS; c++) {
        const x = 226 + c * 13;
        cells +=
          c < lit
            ? `<rect class="cell" style="animation-delay:${round(delay + c * 0.012)}s" x="${x}" y="${y - 14}" width="10" height="16" fill="${C.green}"/>`
            : `<rect x="${x}" y="${y - 14}" width="10" height="16" fill="${C.faint}"/>`;
      }
      return `<g class="show" style="animation-delay:${delay}s"><text x="28" y="${y}" font-size="16" fill="${C.white}">${esc(l.name)}</text></g>${cells}<g class="show" style="animation-delay:${delay}s"><text x="${W - 28}" y="${y}" text-anchor="end" font-size="15" fill="${C.mid}">${(l.share * 100).toFixed(1)}%</text></g>`;
    })
    .join('\n');
  const style = `.cell{opacity:0;animation:show .01s linear forwards}`;
  return win(W, H, 'languages', 'Languages', style, `${prompt('languages --all', 28, 70, 0.1)}\n${lines}`);
}

// ── A project ───────────────────────────────────────────────────────────────

function project(repo, i) {
  const W = 490;
  const H = 142;
  const about = repo.description ?? 'Public project on GitHub.';
  const body = `${typed(`<DIR>  ${repo.name}`, 18, 74, round(0.2 + i * 0.2), { size: 19, weight: 700 })}
<g class="show" style="animation-delay:${round(0.5 + i * 0.2)}s">
<text x="18" y="100" font-size="14" fill="${C.mid}">${esc(about.length > 54 ? `${about.slice(0, 51)}...` : about)}</text>
<text x="18" y="124" font-size="13" fill="${C.white}">${esc(repo.language ?? 'Code')}</text>
<text x="${W - 18}" y="124" text-anchor="end" font-size="13" fill="${C.mid}">* ${repo.stargazers_count}</text>
</g>`;
  return win(W, H, `dir \\${repo.name}`, `${repo.name} repository`, '', body);
}

// ── The foot of the page ────────────────────────────────────────────────────

function footer() {
  const W = 1000;
  const H = 112;
  const body = `${prompt('exit', 28, 68, 0.1)}
${typed('Thanks for stopping by.', 28, 94, 0.7, { weight: 700 })}
${cursor(28 + 23 * 17 * CHAR + 8, 94, 1.3)}`;
  return win(W, H, 'exit', 'Thanks for stopping by', '', body);
}

// ── Everything ──────────────────────────────────────────────────────────────

const p = await loadProfile();

// The old looks' files go too: nothing here is drawn from them any more.
rmSync('assets', { recursive: true, force: true });
rmSync('THEMES.md', { force: true });
mkdirSync('assets', { recursive: true });
writeFileSync('assets/boot.svg', boot(p));
writeFileSync('assets/systeminfo.svg', systeminfo(p));
writeFileSync('assets/contributions.svg', contributions(p));
writeFileSync('assets/languages.svg', languages(p));
writeFileSync('assets/footer.svg', footer());
p.repos.forEach((repo, i) => writeFileSync(`assets/project-${i + 1}.svg`, project(repo, i)));

const links = p.repos
  .map(
    (r, i) =>
      `<a href="https://github.com/${p.login}/${r.name}"><img src="assets/project-${i + 1}.svg" width="49%" alt="${esc(r.name)}"></a>`,
  )
  .join('\n');
writeFileSync(
  'README.md',
  `<div align="center">

<a href="https://github.com/${p.login}"><img src="assets/boot.svg" width="100%" alt="${esc(p.name)}"></a>

<img src="assets/systeminfo.svg" width="100%" alt="System information">

<img src="assets/contributions.svg" width="100%" alt="${p.contributions} contributions in the last year">

<img src="assets/languages.svg" width="100%" alt="Languages">

${links}

<img src="assets/footer.svg" width="100%" alt="Thanks for stopping by">

</div>
`,
);

console.log(`${p.login}: ${p.publicRepos} public, ${p.privateRepos} private, ${p.contributions} contributions`);
