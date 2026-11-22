'use strict';
// Animation scene kit: parametric SVG templates + a per-frame assembler (frameSVG). Pure string
// builders — no I/O — so they are fast to unit-test. The renderer rasterises these with sharp.
// Part of the "Option A" animated-video style (see docs/adr).

const H1 = 'Helvetica Neue, Helvetica, Arial', SER = 'Georgia, serif';
// On-screen channel brand burned into the intro/outro and thumbnail. One place to change on a rename.
const BRAND = (process.env.CHANNEL_BRAND || 'The Unknown Archive').toUpperCase();
const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
function wrap(str, max) { const w = String(str).split(' '); const L = []; let l = ''; for (const x of w) { if ((l + ' ' + x).trim().length > max) { L.push(l.trim()); l = x; } else l += ' ' + x; } if (l.trim()) L.push(l.trim()); return L; }

const PAL = { calm: { t: '#174c72', m: '#9b4f6a', b: '#f6a24a', sun: '#ffd98a', sea: '#0e5f80', hi: '#45d6e4', foam: '#eaf9ff' }, storm: { t: '#0c1030', m: '#241a4a', b: '#3a2f63', sun: '#2a2b5c', sea: '#0b3350', hi: '#2aa6c4', foam: '#cfe8f5' } };

function seaBackdrop(tAbs, storm) {
  const p = storm ? PAL.storm : PAL.calm;
  const dx1 = -(((tAbs / 1000) * (64 / 7)) % 64), dx2 = (((tAbs / 1000) * (64 / 11)) % 64), dxf = -(((tAbs / 1000) * (64 / 5)) % 64);
  const swell = -5 * Math.sin(2 * Math.PI * tAbs / (storm ? 1700 : 3200));
  const rainDY = ((tAbs % 450) / 450) * 32 - 16;
  let flash = 0; if (storm) { const q = tAbs % 6000; flash = (q >= 5600 && q < 5680) ? 0.7 : (q >= 5680 && q < 5760) ? 0.12 : (q >= 5760 && q < 5840) ? 0.55 : 0; }
  const wl = (y, dx, c, sw, op) => `<g transform="translate(${dx},${swell})"><path d="M-64 ${y} q22 -9 44 0 t44 0 t44 0 t44 0 t44 0 t44 0 t44 0 t44 0 t44 0 t44 0 t44 0" fill="none" stroke="${c}" stroke-width="${sw}" opacity="${op}"/></g>`;
  return { swell, svg: `<rect width="400" height="225" fill="url(#sky)"/><circle cx="300" cy="150" r="78" fill="url(#sung)" opacity="${storm ? 0.08 : 1}"/><rect x="0" y="150" width="400" height="75" fill="url(#seagrad)"/>${wl(160, dx1, p.hi, 3, .75)}${wl(172, -dx2, p.foam, 1.6, .5)}${wl(153, dxf, p.foam, 2, .85)}<g opacity="${storm ? .55 : 0}" stroke="#cfe3f5" stroke-width="1.1" transform="translate(0,${rainDY})">${[[40, 10], [90, 0], [140, 12], [300, 4], [340, 14], [250, 2], [70, 40], [360, 40], [180, 44]].map(([x, y]) => `<line x1="${x}" y1="${y}" x2="${x - 5}" y2="${y + 16}"/>`).join('')}</g>`, flashSvg: `<rect width="400" height="225" fill="#eaf4ff" opacity="${flash}"/>` };
}
function particles(tAbs) { let s = ''; for (let i = 0; i < 26; i++) { const bx = (i * 61 % 400); const y = (((i * 97 % 190) + 8) + (tAbs / 1000 * (6 + i % 5))) % 200 + 8; s += `<circle cx="${bx}" cy="${y}" r="${0.6 + (i % 3) * 0.5}" fill="#9fc2e0" opacity="${0.08 + (i % 4) * 0.05}"/>`; } return s; }

// Themed intro/outro backdrop so the opening/closing match the video's subject instead of
// always showing the sea. Returns { svg, flashSvg, swell? }. 'sea' keeps the original look.
function heroBackdrop(theme, tAbs) {
  if (theme === 'cosmic') {
    let stars = '';
    for (let i = 0; i < 64; i++) { const x = (i * 83 + 17) % 400, y = (i * 47 + 11) % 175; const tw = 0.3 + 0.7 * Math.abs(Math.sin(tAbs / 650 + i * 1.3)); stars += `<circle cx="${x}" cy="${y}" r="${0.4 + (i % 4) * 0.28}" fill="#e3ebff" opacity="${(0.2 + (i % 3) * 0.2) * tw}"/>`; }
    const drift = (tAbs / 1000) % 40;
    return { svg: `<defs><radialGradient id="cneb" cx="38%" cy="34%" r="62%"><stop offset="0" stop-color="#3b2a6e" stop-opacity=".7"/><stop offset="1" stop-color="#3b2a6e" stop-opacity="0"/></radialGradient><linearGradient id="csky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#05061a"/><stop offset="1" stop-color="#0b0a24"/></linearGradient></defs><rect width="400" height="225" fill="url(#csky)"/><ellipse cx="${150 - drift}" cy="88" rx="230" ry="120" fill="url(#cneb)"/>${stars}<circle cx="334" cy="182" r="48" fill="#17132f"/><circle cx="334" cy="182" r="48" fill="none" stroke="#6150a0" stroke-width="1" opacity=".45"/>`, flashSvg: '' };
  }
  if (theme === 'haunted') {
    let fog = '';
    for (let k = 0; k < 3; k++) { const dx = ((-(tAbs / 1000) * (9 + k * 6)) % 480 + 480) % 480; const y = 118 + k * 30; fog += `<ellipse cx="${dx - 40}" cy="${y}" rx="165" ry="26" fill="#9fb3c9" opacity="${0.06 + k * 0.02}"/><ellipse cx="${((dx + 240) % 480) - 40}" cy="${y + 8}" rx="140" ry="22" fill="#9fb3c9" opacity=".05"/>`; }
    return { svg: `<defs><linearGradient id="hsky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a0c14"/><stop offset=".6" stop-color="#121622"/><stop offset="1" stop-color="#05070c"/></linearGradient></defs><rect width="400" height="225" fill="url(#hsky)"/><circle cx="302" cy="52" r="21" fill="#dbe3ed" opacity=".85"/><circle cx="302" cy="52" r="33" fill="#dbe3ed" opacity=".08"/>${fog}<path d="M0 225 L0 182 Q40 150 70 178 Q92 150 120 176 L120 225 Z" fill="#04060a"/><path d="M400 225 L400 174 Q360 150 330 176 Q310 150 280 178 L280 225 Z" fill="#04060a"/>`, flashSvg: '' };
  }
  if (theme === 'archive') {
    return { svg: `<defs><linearGradient id="asky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#101a33"/><stop offset=".55" stop-color="#2a2740"/><stop offset="1" stop-color="#4a3826"/></linearGradient></defs><rect width="400" height="225" fill="url(#asky)"/><g opacity=".5">${particles(tAbs)}</g><g stroke="#c9a86a" stroke-width="0.5" opacity=".13">${[40, 80, 120, 160].map(y => `<line x1="24" y1="${y}" x2="376" y2="${y}"/>`).join('')}</g><circle cx="200" cy="112" r="70" fill="none" stroke="#c9a86a" stroke-width="0.8" opacity=".12"/><circle cx="200" cy="112" r="50" fill="none" stroke="#c9a86a" stroke-width="0.6" opacity=".1"/>`, flashSvg: '' };
  }
  return seaBackdrop(tAbs, true);
}
const freighter = (x, y, sc, sw) => `<g transform="translate(${x},${y + sw}) scale(${sc})"><path d="M-46 0 q-4 7 4 7 l78 0 q10 0 8 -7 Z" fill="#12171f"/><rect x="-44" y="-5" width="70" height="5" fill="#1b2430"/><rect x="18" y="-16" width="12" height="11" fill="#223040"/><line x1="24" y1="-16" x2="24" y2="-24" stroke="#223040" stroke-width="1.5"/></g>`;

const TEMPLATES = {
  opening({ title, subtitle, theme }, c) { const bd = heroBackdrop(theme || 'sea', c.tAbs); const L = wrap(title, 24), by = 95 - (L.length - 1) * 12; return bd.svg + ((theme || 'sea') === 'sea' ? freighter(300, 150, .7, bd.swell || 0) : '') + `<rect width="400" height="225" fill="#05080d" opacity=".5"/><text x="200" y="64" text-anchor="middle" font-family="${H1}" font-weight="bold" font-size="7" letter-spacing="2.5" fill="#ffcf33">${BRAND}</text>${L.map((l, i) => `<text x="200" y="${by + i * 15}" text-anchor="middle" font-family="${SER}" font-size="15" fill="#f4efe6">${xml(l)}</text>`).join('')}${subtitle ? `<text x="200" y="${by + L.length * 15 + 6}" text-anchor="middle" font-family="${H1}" font-size="8" letter-spacing="3" fill="#9fb0c4">${xml(String(subtitle).toUpperCase())}</text>` : ''}` + bd.flashSvg; },
  statement(p, c) { const th = p && p.theme; if (th === 'cosmic' || th === 'haunted' || th === 'archive') return heroBackdrop(th, c.tAbs).svg; return `<rect width="400" height="225" fill="url(#neu)"/>${particles(c.tAbs)}<rect width="400" height="225" fill="url(#vig)"/>`; },
  cosmos(_p, c) {
    let stars = '';
    for (let i = 0; i < 80; i++) { const x = (i * 71 + 13) % 400, y = (i * 53 + 7) % 225; const tw = 0.25 + 0.75 * Math.abs(Math.sin(c.tAbs / 600 + i * 1.7)); stars += `<circle cx="${x}" cy="${y}" r="${0.35 + (i % 4) * 0.3}" fill="#eaf0ff" opacity="${(0.2 + (i % 3) * 0.22) * tw}"/>`; }
    const drift = (c.tAbs / 1000) % 60, rot = (c.tAbs / 1000 * 4) % 360;
    return `<defs><radialGradient id="coB" cx="42%" cy="40%" r="75%"><stop offset="0" stop-color="#0b0c28"/><stop offset="1" stop-color="#03030c"/></radialGradient><radialGradient id="coN" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#4a3a86" stop-opacity=".6"/><stop offset=".6" stop-color="#2a2a66" stop-opacity=".25"/><stop offset="1" stop-color="#2a2a66" stop-opacity="0"/></radialGradient><radialGradient id="coP" cx="38%" cy="34%" r="70%"><stop offset="0" stop-color="#8fc0f0"/><stop offset=".55" stop-color="#3f74c0"/><stop offset="1" stop-color="#1d335f"/></radialGradient></defs>`
      + `<rect width="400" height="225" fill="url(#coB)"/><ellipse cx="${210 - drift * 0.4}" cy="92" rx="250" ry="135" fill="url(#coN)"/>${stars}`
      + `<g transform="translate(300,152)"><g transform="rotate(${rot.toFixed(2)})"><ellipse cx="0" cy="0" rx="54" ry="15" fill="none" stroke="#8778c0" stroke-width="1.4" opacity=".5"/></g><circle cx="0" cy="0" r="31" fill="url(#coP)"/><path d="M-31 0 a31 31 0 0 0 62 0 a31 20 0 0 1 -62 0" fill="#02040a" opacity=".32"/></g>`;
  },
  map({ shape, pin, route, labels }, c) {
    let marker = ''; if (route) { const t = clamp(c.tIn / c.beatMs, 0, 1); marker = freighter(lerp(route[0][0], route[1][0], t), lerp(route[0][1], route[1][1], t), .42, 0); }
    const pinSvg = pin ? `<circle cx="${pin[0]}" cy="${pin[1]}" r="3.4" fill="#ff8a6a"/><circle cx="${pin[0]}" cy="${pin[1]}" r="${5 + 3 * (0.5 + 0.5 * Math.sin(c.tAbs / 400))}" fill="none" stroke="#ff8a6a" stroke-width="1" opacity="0.6"/>` : '';
    const routeSvg = route ? `<line x1="${route[0][0]}" y1="${route[0][1]}" x2="${route[1][0]}" y2="${route[1][1]}" stroke="#ffcf33" stroke-width="1.2" stroke-dasharray="4 3" opacity=".8"/><circle cx="${route[0][0]}" cy="${route[0][1]}" r="3" fill="#8fe0ff"/><circle cx="${route[1][0]}" cy="${route[1][1]}" r="3" fill="#ff8a6a"/>` : '';
    return `<rect width="400" height="225" fill="#0a1a28"/><path d="${shape}" fill="#123a52" stroke="#1f5d7d" stroke-width="1.5"/>${routeSvg}${pinSvg}${(labels || []).map(l => `<text x="${l[0]}" y="${l[1]}" font-family="${H1}" font-weight="bold" font-size="8.5" fill="#dce8f2">${xml(l[2])}</text>`).join('')}${marker}`;
  },
  seaScene({ storm }, c) { const bd = seaBackdrop(c.tAbs, storm); return bd.svg + freighter(200, 150, 1, bd.swell) + bd.flashSvg; },
  stat({ number, label, theme }, c) { const pop = 1 + .04 * Math.max(0, Math.sin(2 * Math.PI * c.tIn / 1400)); const themed = (theme === 'cosmic' || theme === 'haunted' || theme === 'archive'); const bg = themed ? heroBackdrop(theme, c.tAbs).svg + `<ellipse cx="200" cy="120" rx="165" ry="54" fill="#05060f" opacity="0.4"/>` : `<rect width="400" height="225" fill="#0b0f16"/><rect width="400" height="225" fill="url(#vig)"/>`; return bg + `<text x="200" y="118" text-anchor="middle" font-family="${H1}" font-weight="bold" font-size="${50 * pop}" fill="#ffcf33">${xml(number)}</text><text x="200" y="150" text-anchor="middle" font-family="${H1}" font-weight="bold" font-size="11" letter-spacing="2.5" fill="#eef3fb">${xml(String(label).toUpperCase())}</text>`; },
  closing({ title, note, theme }, c) { const bd = heroBackdrop(theme || 'sea', c.tAbs); const L = wrap(title, 26), by = 100 - (L.length - 1) * 11; return bd.svg + `<rect width="400" height="225" fill="#05080d" opacity=".62"/><text x="200" y="70" text-anchor="middle" font-family="${H1}" font-weight="bold" font-size="7" letter-spacing="2.5" fill="#ffcf33">${BRAND}</text>${L.map((l, i) => `<text x="200" y="${by + i * 13}" text-anchor="middle" font-family="${SER}" font-size="13" fill="#eef3fb">${xml(l)}</text>`).join('')}${note ? `<text x="200" y="150" text-anchor="middle" font-family="${H1}" font-size="7.5" fill="#93a0b4">${xml(note)}</text>` : ''}`; },
  portrait({ name, role }, c) {
    const glow = 0.5 + 0.5 * Math.sin(c.tAbs / 1600);
    return `<rect width="400" height="225" fill="url(#neu)"/>${particles(c.tAbs)}`
      + `<circle cx="200" cy="90" r="84" fill="#1b3a5c" opacity="${0.4 + 0.22 * glow}"/><circle cx="200" cy="90" r="52" fill="#245076" opacity="${0.35 + 0.18 * glow}"/>`
      + `<g fill="#3a5c82" stroke="#8fb2d6" stroke-width="1.4"><circle cx="200" cy="74" r="18"/><path d="M167 134 q0 -33 33 -33 q33 0 33 33 Z"/></g>`
      + (name ? `<text x="200" y="164" text-anchor="middle" font-family="${SER}" font-size="16" fill="#f7f1e4">${xml(name)}</text>` : '')
      + (role ? `<text x="200" y="178" text-anchor="middle" font-family="${H1}" font-weight="bold" font-size="7.5" letter-spacing="2.5" fill="#ffcf33">${xml(String(role).toUpperCase())}</text>` : '');
  },
  timeline({ events }, c) {
    const ev = events || []; const n = ev.length; const x0 = 54, x1 = 346, y = 104;
    const prog = clamp(c.tIn / c.beatMs + 0.15, 0, 1);
    const pos = i => n <= 1 ? (x0 + x1) / 2 : x0 + (x1 - x0) * i / (n - 1);
    let s = `<rect width="400" height="225" fill="url(#neu)"/>${particles(c.tAbs)}<rect width="400" height="225" fill="url(#vig)"/>`;
    s += `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="#2a3a4e" stroke-width="2"/><line x1="${x0}" y1="${y}" x2="${lerp(x0, x1, prog)}" y2="${y}" stroke="#ffcf33" stroke-width="2"/>`;
    ev.forEach((e, i) => { if ((i / Math.max(1, n - 1)) > prog + 0.001) return; const x = pos(i), up = i % 2 === 0; s += `<circle cx="${x}" cy="${y}" r="3.4" fill="#ffcf33"/><text x="${x}" y="${up ? y - 14 : y + 22}" text-anchor="middle" font-family="${H1}" font-weight="bold" font-size="9" fill="#eef3fb">${xml(e.year)}</text>`; if (e.label) wrap(e.label, 16).forEach((l, k) => { s += `<text x="${x}" y="${(up ? y - 26 : y + 32) + k * 9}" text-anchor="middle" font-family="${H1}" font-size="6.6" fill="#9fb0c4">${xml(l)}</text>`; }); });
    return s;
  },
  skyEvent(_p, c) {
    const p = clamp(c.tIn / c.beatMs, 0, 1); const x = lerp(18, 374, p), y = lerp(32, 126, p), tx = x - 54, ty = y - 21;
    let stars = ''; for (let i = 0; i < 16; i++) { const sx = (i * 71) % 398 + 1, sy = (i * 47) % 108 + 8; stars += `<circle cx="${sx}" cy="${sy}" r="${0.6 + (i % 2) * 0.4}" fill="#cfe0f5" opacity="${0.3 + (i % 3) * 0.14}"/>`; }
    return `<rect width="400" height="225" fill="url(#dawn)"/>${stars}<ellipse cx="200" cy="150" rx="280" ry="42" fill="#f6a24a" opacity="0.16"/><path d="M${tx} ${ty} L${x} ${y}" stroke="url(#trail)" stroke-width="3.2" stroke-linecap="round" opacity="0.9"/><circle cx="${x}" cy="${y}" r="10" fill="url(#fbglow)"/><circle cx="${x}" cy="${y}" r="3.4" fill="#fff6d2"/><path d="M0 162 q100 -12 200 -4 q100 8 200 -2 L400 225 L0 225 Z" fill="#0a1017"/>`;
  },
  explosion(_p, c) {
    const p = clamp(c.tIn / c.beatMs, 0, 1); const R = lerp(6, 170, Math.min(1, p * 1.5)); const flashO = clamp(0.8 * (1 - c.tIn / 380), 0, 0.8);
    let rings = ''; for (let k = 0; k < 3; k++) { const rr = R * (0.55 + k * 0.26); rings += `<circle cx="200" cy="150" r="${rr}" fill="none" stroke="#ffd27a" stroke-width="${2 - k * 0.5}" opacity="${clamp(0.55 - p * 0.4, 0, 0.55)}"/>`; }
    let trees = ''; for (let i = 0; i < 14; i++) { const tx = 20 + i * 27, dir = tx < 200 ? -1 : 1, tilt = clamp((R - Math.abs(tx - 200)) / 30, 0, 1) * 8 * dir; trees += `<line x1="${tx}" y1="166" x2="${tx + tilt}" y2="${158 - (8 - Math.abs(tilt))}" stroke="#13341f" stroke-width="2"/>`; }
    return `<rect width="400" height="225" fill="url(#dawn)"/><path d="M0 160 q100 -10 200 -3 q100 7 200 -1 L400 225 L0 225 Z" fill="#0a1017"/>${trees}${rings}<circle cx="200" cy="150" r="${R * 0.62}" fill="url(#fbglow)"/><circle cx="200" cy="150" r="${R * 0.3}" fill="#fff6d2" opacity="0.9"/><rect width="400" height="225" fill="#fff3d0" opacity="${flashO}"/>`;
  },
  // Stage 3: a city skyline of lit buildings — for cities, companies, modern/urban topics.
  cityscape(_p, c) {
    const heights = [70, 110, 90, 130, 80, 120, 100, 140, 85, 115, 95]; let b = '', x = 8;
    heights.forEach((h, i) => {
      const w = 26 + (i % 3) * 8, top = 168 - h;
      b += `<rect x="${x}" y="${top}" width="${w}" height="${h}" fill="#141f2d"/>`;
      for (let wy = top + 7; wy < 160; wy += 12) for (let wx = x + 4; wx < x + w - 3; wx += 9) { const base = ((i * 7 + wx + wy) % 5 === 0) ? 1 : 0.22; const on = base >= 1 && ((Math.floor(c.tAbs / 700) + wx + wy) % 13 === 0) ? 0.25 : base; b += `<rect x="${wx}" y="${wy}" width="4" height="5" fill="#ffcf6a" opacity="${on}"/>`; }
      x += w + 6;
    });
    return `<rect width="400" height="225" fill="url(#neu)"/><ellipse cx="200" cy="175" rx="260" ry="54" fill="#2a3550" opacity="0.4"/>${b}<rect x="0" y="166" width="400" height="59" fill="#0a0f18"/>`;
  },
  // Stage 3: a written page with a wax seal — for laws, letters, writings, reports, discoveries.
  document(_p, c) {
    const sway = Math.sin(c.tAbs / 1800) * 1.2;
    let lines = ''; for (let i = 0; i < 9; i++) { const w = 78 - (i % 3) * 16; lines += `<rect x="160" y="${72 + i * 10}" width="${w}" height="3" rx="1.5" fill="#b9a784" opacity="0.85"/>`; }
    return `<rect width="400" height="225" fill="url(#neu)"/><rect width="400" height="225" fill="url(#vig)"/><g transform="rotate(${sway} 200 120)"><rect x="150" y="56" width="100" height="118" rx="3" fill="#efe3c6" stroke="#cdbd98" stroke-width="1.5"/>${lines}<circle cx="200" cy="158" r="7" fill="#b4472e" opacity="0.85"/></g>`;
  },
  // Stage 3: turning gears — for machines, engines, industry, invention.
  machine(_p, c) {
    const rot = c.tAbs / 20;
    const gear = (cx, cy, r, teeth, speed, col) => { const ang = rot * speed; let g = `<g transform="translate(${cx},${cy}) rotate(${ang})"><circle r="${r}" fill="${col}"/><circle r="${r * 0.32}" fill="#0a0f18"/>`; for (let i = 0; i < teeth; i++) g += `<rect x="-2.5" y="${-(r + 5)}" width="5" height="7" fill="${col}" transform="rotate(${i / teeth * 360})"/>`; for (let i = 0; i < 4; i++) g += `<rect x="-1.5" y="${-r * 0.88}" width="3" height="${r * 1.76}" fill="#0a0f18" opacity="0.5" transform="rotate(${i * 45})"/>`; return g + `</g>`; };
    return `<rect width="400" height="225" fill="url(#neu)"/><rect width="400" height="225" fill="url(#vig)"/>${gear(168, 118, 34, 12, 1, '#5a6b7e')}${gear(226, 100, 24, 9, -1.4, '#6f8296')}${gear(236, 150, 18, 7, 1.8, '#4a5a6c')}`;
  },
  // Stage 3: rolling hills under a sky — for land, nature, terrain, countryside.
  landscape(_p, c) {
    const drift = (c.tAbs / 1000 * 3) % 460;
    return `<rect width="400" height="225" fill="url(#sky)"/><circle cx="300" cy="66" r="20" fill="#ffd98a" opacity="0.9"/>`
      + `<g opacity="0.14" fill="#ffffff"><ellipse cx="${80 - drift + 460}" cy="46" rx="30" ry="8"/><ellipse cx="${210 - drift}" cy="38" rx="26" ry="7"/></g>`
      + `<path d="M0 150 q60 -30 120 -10 q80 26 160 -4 q70 -24 120 6 L400 225 L0 225 Z" fill="#3a5c3e"/>`
      + `<path d="M0 172 q80 -24 160 -6 q90 20 240 -8 L400 225 L0 225 Z" fill="#294a2e"/>`;
  },
  // Stage 3: rows of small figures — for people, population, society, crowds.
  crowd(_p, c) {
    let f = '';
    for (let r = 0; r < 4; r++) for (let i = 0; i < 14; i++) { const x = 16 + i * 27 + (r % 2) * 12, y = 120 + r * 22, sh = Math.sin((c.tAbs / 600) + i + r) * 0.6; const tone = ['#35557a', '#3a5c82', '#2f4f70'][(i + r) % 3]; f += `<g transform="translate(${x},${y + sh})"><circle cx="0" cy="-6" r="2.4" fill="#223040"/><path d="M-2.4 -4 q2.4 -2 4.8 0 l.6 7 h-6 Z" fill="${tone}"/></g>`; }
    return `<rect width="400" height="225" fill="url(#neu)"/><rect width="400" height="225" fill="url(#vig)"/>${f}`;
  }
};
const TEMPLATE_NAMES = Object.keys(TEMPLATES);

function defs(storm) {
  const p = storm ? PAL.storm : PAL.calm;
  return `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.t}"/><stop offset=".58" stop-color="${p.m}"/><stop offset="1" stop-color="${p.b}"/></linearGradient>`
    + `<radialGradient id="sung" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="${p.sun}" stop-opacity=".95"/><stop offset="1" stop-color="${p.sun}" stop-opacity="0"/></radialGradient>`
    + `<linearGradient id="seagrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.hi}"/><stop offset="1" stop-color="${p.sea}"/></linearGradient>`
    + `<linearGradient id="capband" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.72"/></linearGradient>`
    + `<radialGradient id="vig" cx="50%" cy="50%" r="75%"><stop offset="0" stop-color="#1a2435" stop-opacity="0.65"/><stop offset="1" stop-color="#05080d" stop-opacity="0.92"/></radialGradient>`
    + `<linearGradient id="neu" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#101826"/><stop offset="1" stop-color="#0a0f18"/></linearGradient>`
    + `<linearGradient id="dawn" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#101a33"/><stop offset=".55" stop-color="#3a2a4a"/><stop offset="1" stop-color="#d98a4a"/></linearGradient>`
    + `<radialGradient id="fbglow" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#fff6d2" stop-opacity="1"/><stop offset=".4" stop-color="#ffb347" stop-opacity=".8"/><stop offset="1" stop-color="#ff7a30" stop-opacity="0"/></radialGradient>`
    + `<linearGradient id="trail" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffb347" stop-opacity="0"/><stop offset="1" stop-color="#fff6d2" stop-opacity="0.9"/></linearGradient>`
    + `<radialGradient id="gvig" cx="50%" cy="50%" r="72%"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset=".65" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.3"/></radialGradient></defs>`;
}

function hashStr(s) { let h = 0; s = String(s); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
// A slow, subtle camera move per scene (push-in or pull-back + a touch of drift) so nothing is
// ever fully static. Always keeps the frame covered (z >= 1.012, drift < the overscan margin).
function cameraFor(beat, tIn, beatMs) {
  const p = clamp(beatMs ? tIn / beatMs : 0, 0, 1);
  const seed = hashStr((beat.cap || '') + beat.tpl);
  const z = (seed % 2) ? 1.03 + 0.13 * p : 1.16 - 0.13 * p; // in [1.03, 1.16]
  const panX = (((seed >> 1) % 3) - 1) * 10 * (p - 0.5);    // |drift| <= 5 < overscan (6)
  const panY = (((seed >> 3) % 3) - 1) * 5 * (p - 0.5);     // |drift| <= 2.5 < overscan (3.3)
  const cx = 200, cy = 112;
  return `translate(${(cx * (1 - z) + panX).toFixed(3)},${(cy * (1 - z) + panY).toFixed(3)}) scale(${z.toFixed(4)})`;
}

// Assemble one full 1280x720 frame (viewBox 400x225) for a beat at time tIn within the beat.
function frameSVG(beat, tInMs, tAbsMs, beatMs) {
  if (!TEMPLATES[beat.tpl]) throw new Error('unknown template: ' + beat.tpl);
  const storm = (beat.params && beat.params.storm) || beat.tpl === 'opening' || beat.tpl === 'closing';
  const body = TEMPLATES[beat.tpl](beat.params || {}, { tAbs: tAbsMs, tIn: tInMs, beatMs, W: 1280, H: 720 });
  const cam = cameraFor(beat, tInMs, beatMs);
  const fade = clamp(1 - tInMs / 350, 0, 1);
  let cap = '';
  if (beat.cap) { const L = wrap(beat.cap, 48), lh = 15, by = 214 - (L.length - 1) * lh; cap = `<rect x="0" y="182" width="400" height="43" fill="url(#capband)"/>` + L.map((l, i) => `<text x="200" y="${by + i * lh}" text-anchor="middle" font-family="${H1}" font-style="italic" font-weight="bold" font-size="12.5" fill="#ffe14d">${xml(l)}</text>`).join(''); }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 400 225">${defs(storm)}<g transform="${cam}">${body}</g><rect width="400" height="225" fill="url(#gvig)"/>${cap}<rect width="400" height="225" fill="#05080d" opacity="${fade}"/></svg>`;
}

module.exports = { TEMPLATES, TEMPLATE_NAMES, frameSVG, defs, wrap, BRAND };
