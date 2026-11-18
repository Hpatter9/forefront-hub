// Keystone game mode. Loaded by ui.html; does nothing until the "Game mode" switch is on. Everything Keystone does
// stays the same: this only changes how it looks and adds a score kept from real work (/api/game). The pixel art is
// drawn here from small text maps (original art, no image files); sounds are made by the browser, off by default.
(() => {
  const SP = {
    palette: {"k": "#1a1426", "w": "#f6f6f2", "s": "#f2c28c", "S": "#c98b5a", "o": "#f28a1e", "O": "#b85a12", "y": "#ffe066", "b": "#3d6fd6", "B": "#233d7a", "g": "#a7b0c2", "G": "#5a6275", "r": "#e0453a", "R": "#8f2330", "n": "#9a6234", "N": "#5a3820", "e": "#5fcf6a", "E": "#2b7a36", "p": "#9a63e6", "P": "#4f2f8a", "c": "#62dcef", "C": "#2a8ea3", "m": "#ff6fbf", "t": "#f3e4b6", "T": "#c9b37a", "z": "#ffcf3d", "Z": "#c98d14", "l": "#d8dde8"},
    // Each sprite is a grid of palette letters; "." is see-through.
    sprites: {
      hero: [
        ".....kkkkkk.....",
        "...kkooyyookk...",
        "..kooyyoooooOk..",
        "..koooooooooOk..",
        ".kkkkkkkkkkkkkk.",
        ".kOOOOOOOOOOOOk.",
        "..kssssssssssk..",
        "..kssksssskssk..",
        "..kssksssskssk..",
        "..kSssssssssSk..",
        "...kssSSSSssk...",
        "..kkbbkkkkbbkk..",
        ".kbbbbkttTkbbbk.",
        ".ksbbbktGGTkbsk.",
        "..kkBBkttTkBBk..",
        "..kNNNk..kNNNk..",
      ].join("\n"),
      boss: [
        ".......k..........k.....",
        "......kPk........kPk....",
        "......kPPk......kPPk....",
        ".......kPPkkkkkkPPk.....",
        ".....kkkppppppppppkkk...",
        "....kppppppppppppppppk..",
        "...kppwppppppppppppwppk.",
        "...kpppwppppppppppwpppk.",
        "..kppkkkkpppppppkkkkppk.",
        "..kppkyykkpppppkkyykppk.",
        "..kppkyRykpppppkyRykppk.",
        "..kpppkkkpppppppkkkpppk.",
        "..kppppppppppppppppppppk",
        "..kpppkwkkkkkkkkkkwkpppk",
        "..kpppkwRRRRRRRRRRwkpppk",
        "..kppppkwkwkwkwkwkwkpppk",
        "..kPpppkkkkkkkkkkkkppPk.",
        "...kPpppppppppppppppPk..",
        "...kPPpppppppppppppPPk..",
        "....kPPPppppppppPPPPk...",
        "....kkPPPPPPPPPPPPPkk...",
        "...kgk.kkkkkkkkkkk.kgk..",
        "..kgk..............kgk..",
        "..kk................kk..",
      ].join("\n"),
      heart: [
        "................",
        "................",
        "...kkk....kkk...",
        "..krrrk..krrrk..",
        ".krwrrrkkrrrrrk.",
        ".krwrrrrrrrrrrk.",
        ".krrrrrrrrrrrrk.",
        ".krrrrrrrrrrrRk.",
        "..krrrrrrrrrRk..",
        "...krrrrrrrRk...",
        "....krrrrrRk....",
        ".....krrrRk.....",
        "......krRk......",
        ".......kk.......",
        "................",
        "................",
      ].join("\n"),
      heartEmpty: [
        "................",
        "................",
        "...kkk....kkk...",
        "..kGGGk..kGGGk..",
        ".kGgGGGkkGGGGGk.",
        ".kGgGGGGGGGGGGk.",
        ".kGGGGGGGGGGGGk.",
        ".kGGGGGGGGGGGkk.",
        "..kGGGGGGGGGkk..",
        "...kGGGGGGGkk...",
        "....kGGGGGkk....",
        ".....kGGGkk.....",
        "......kGkk......",
        ".......kk.......",
        "................",
        "................",
      ].join("\n"),
      gem: [
        "................",
        ".....kkkkkk.....",
        "....kcwwcccck...",
        "...kcwcccccCck..",
        "..kkkkkkkkkkkkk.",
        "..kcwcccccccCk..",
        "...kcwcccccCk...",
        "....kccccccCk...",
        ".....kcccCck....",
        "......kccCk.....",
        ".......kCk......",
        "........k.......",
        "................",
        "................",
        "................",
        "................",
      ].join("\n"),
      coin: [
        "................",
        ".....kkkkkk.....",
        "...kkzzzzzzkk...",
        "..kzzyyzzzzzZk..",
        "..kzyzzkkzzzZk..",
        ".kzzyzkzzkzzzZk.",
        ".kzzzzkzzzzzzZk.",
        ".kzzzzzkkzzzzZk.",
        ".kzzzzzzzkzzzZk.",
        ".kzzzzkzzkzzzZk.",
        "..kzzzzkkzzzZk..",
        "..kzzzzzzzzZZk..",
        "...kkZZZZZZkk...",
        ".....kkkkkk.....",
        "................",
        "................",
      ].join("\n"),
      flame: [
        ".......k........",
        "......kok.......",
        "......kok...k...",
        ".....kooyk.kok..",
        "....koooyk.kok..",
        "...kooyyyokooOk.",
        "...koyyyyyooooOk",
        "..kooyywyyyooOk.",
        "..koyywwwyyyoOk.",
        "..koyywwwwyyoOk.",
        "..koyywwwyyyoOk.",
        "..kooyyyyyyooOk.",
        "...kooyyyyooOk..",
        "....kOoooooOk...",
        ".....kkkkkkk....",
        "................",
      ].join("\n"),
      star: [
        ".......kk.......",
        ".......kzk......",
        "......kzzk......",
        "......kzyzk.....",
        ".kkkkkkzyzkkkkk.",
        ".kzzzzzyyzzzzZk.",
        "..kZzzyyyyzzZk..",
        "...kZzzyyzzZk...",
        "....kzzzzzzk....",
        "...kzzzZZzzzk...",
        "...kzzZkkZzzk...",
        "..kzzZk..kZzzk..",
        "..kzZk....kZzk..",
        "..kkk......kkk..",
        "................",
        "................",
      ].join("\n"),
      trophy: [
        "................",
        "..kkkkkkkkkkkk..",
        ".kzkzyyzzzzZkzk.",
        ".kzkzyzzzzzZkzk.",
        ".kzkzyzzzzzZkzk.",
        "..kkzyzzzzzZkk..",
        "...kzzzzzzzZk...",
        "....kzzzzzZk....",
        ".....kkzzkk.....",
        "......kZZk......",
        "......kzZk......",
        "....kkkzZkkk....",
        "...kNNNNNNNNk...",
        "...kNnnnnnnNk...",
        "...kkkkkkkkkk...",
        "................",
      ].join("\n"),
      scroll: [
        "................",
        "..kkkkkkkkkkk...",
        ".kTtttttttttTk..",
        ".kTkkkkkkkkkkk..",
        "..ktttttttttk...",
        "..ktGGGGGGGtk...",
        "..kttttttttTk...",
        "..ktGGGGGtttk...",
        "..kttttttttTk...",
        "..ktGGGGGGttk...",
        "..kttttttttTk...",
        "..ktGGGtttttk...",
        "..kkkkkkkkkkkk..",
        "..kTttttttttTk..",
        "...kkkkkkkkkk...",
        "................",
      ].join("\n"),
      anvil: [
        "................",
        "................",
        "...........ky...",
        "..........kyk...",
        ".........kgk....",
        "..kkkkkkkGkkk...",
        ".kgggggggggggk..",
        "kgglllllllllGk..",
        ".kkgggggggGGkk..",
        "...kkGGGGGkk....",
        "....kGGGGGk.....",
        "....kGGGGGk.....",
        "...kGGGGGGGk....",
        "..kGGGGGGGGGk...",
        "..kkkkkkkkkkk...",
        "................",
      ].join("\n"),
      crown: [
        "................",
        "................",
        "..k....k....k...",
        ".kzk..kzk..kzk..",
        ".kzzk.kzk.kzzk..",
        ".kzzzkzzzkzzzk..",
        ".kzyzzzzzzzzzk..",
        ".kzyzzrzzbzzzk..",
        ".kzzzrrzbbzzzk..",
        ".kzzzzzzzzzzZk..",
        ".kZZZZZZZZZZZk..",
        ".kkkkkkkkkkkkk..",
        "................",
        "................",
        "................",
        "................",
      ].join("\n"),
      sword: [
        ".............kk.",
        "............kwk.",
        "...........kwlk.",
        "..........kwlk..",
        ".........kwlk...",
        "........kwlk....",
        ".......kwlk.....",
        "..kk..kwlk......",
        "..kzkkwlk.......",
        "...kzzlk........",
        "....kzzk........",
        "...kNkzzk.......",
        "..kNk.kzzk......",
        ".kNk...kk.......",
        ".kk.............",
        "................",
      ].join("\n"),
      shield: [
        "................",
        "..kkkkkkkkkkkk..",
        ".kbbbbbbbbbbbbk.",
        ".kbwbbbzzbbbbBk.",
        ".kbwbbbzzbbbbBk.",
        ".kbbbzzzzzzbbBk.",
        ".kbbbzzzzzzbbBk.",
        ".kbbbbbzzbbbbBk.",
        "..kbbbbzzbbbBk..",
        "..kbbbbbbbbbBk..",
        "...kbbbbbbbBk...",
        "....kbbbbbBk....",
        ".....kbbbBk.....",
        "......kkkk......",
        "................",
        "................",
      ].join("\n"),
      envelope: [
        "................",
        "................",
        "................",
        ".kkkkkkkkkkkkkk.",
        ".kwkwwwwwwwwkwk.",
        ".kwwkwwwwwwkwwk.",
        ".kwwwkwwwwkwwwk.",
        ".kwwwwkrrkwwwwk.",
        ".kwwwkwkkwkwwwk.",
        ".kwwkwwwwwwkwwk.",
        ".kwkwwwwwwwwkwk.",
        ".klllllllllllk..",
        ".kkkkkkkkkkkkkk.",
        "................",
        "................",
        "................",
      ].join("\n"),
      broom: [
        ".........kk.....",
        "........knk.....",
        ".......knk......",
        "......knk.......",
        ".....knk........",
        "....knk.........",
        "...kNk..........",
        "..kkzk..........",
        ".kzzyzk.........",
        "kzzyyzzk........",
        "kzyzzyzk........",
        "kzzyzzzzk.......",
        ".kzzzyzzk.......",
        "..kzzzzzk.......",
        "...kkkkk........",
        "................",
      ].join("\n"),
      boot: [
        "................",
        "....kkkkkk......",
        "....knnnnnk.....",
        "....knNnnnk.....",
        "....knnnnnk.....",
        "....knNnnnk.....",
        "....knnnnnk.....",
        "....knnnnnkk....",
        "....knnnnnnnkk..",
        "...knnnnnnnnnnk.",
        "...knnnnnnnnnnk.",
        "...kNNNNNNNNNNk.",
        "...kkkkkkkkkkkk.",
        "................",
        "................",
        "................",
      ].join("\n"),
      hammer: [
        "................",
        "..kkkkkkk.......",
        ".kgggggggk......",
        ".kglllllgkk.....",
        ".kgggggggGk.....",
        "..kkkkknkkk.....",
        "......knk.......",
        "......knk.......",
        "......knk.......",
        "......kNk.......",
        "......knk.......",
        "......kNk.......",
        "......knk.......",
        "......kkk.......",
        "................",
        "................",
      ].join("\n"),
      castle: [
        "................",
        ".k.k.k....k.k.k.",
        ".kgkgk....kgkgk.",
        ".kgggk.kk.kgggk.",
        ".kgggkkrrkkgggk.",
        ".kgggkgrrgkgggk.",
        ".kggggggggggggk.",
        ".kgkkgggggggkkgk",
        ".kggggggggggggk.",
        ".kggggkkkkggggk.",
        ".kgggkNNNNkgggk.",
        ".kgggkNnnNkgggk.",
        ".kGGGkNnnNkGGGk.",
        ".kkkkkkkkkkkkkk.",
        "................",
        "................",
      ].join("\n"),
      map: [
        "................",
        ".kkkkkkkkkkkkkk.",
        ".kttTttttTttttk.",
        ".ktttTtttTtrtrk.",
        ".ktetTttttTtrtk.",
        ".keeetTtttTrtrk.",
        ".ktetttTTtttTtk.",
        ".kttttktttttTtk.",
        ".kttkttkttttTtk.",
        ".ktkttttkkkttTk.",
        ".kttttTtttttktk.",
        ".kTTTTTTTTTTTTk.",
        ".kkkkkkkkkkkkkk.",
        "................",
        "................",
        "................",
      ].join("\n"),
      party: [
        "................",
        "................",
        "...kkk....kkk...",
        "..kooOk..kbbBk..",
        "..kkkkk..kkkkk..",
        "..kssSk..kssSk..",
        "..kskSk..kskSk..",
        "...kSk....kSk...",
        "..kbbbk..kppPk..",
        ".kbbbbbkkppppPk.",
        ".ksbbbbskpppppk.",
        "..kbBbk..kPpPk..",
        "..kNkNk..kNkNk..",
        "..kk.kk..kk.kk..",
        "................",
        "................",
      ].join("\n"),
      hourglass: [
        "................",
        "..kkkkkkkkkkkk..",
        "..knnnnnnnnnnk..",
        "...kwwwwwwwwk...",
        "...kwzzzzzzwk...",
        "....kwzzzzwk....",
        ".....kwzzwk.....",
        "......kwwk......",
        "......kwwk......",
        ".....kwwzwk.....",
        "....kwwzzzwk....",
        "...kwzzzzzzwk...",
        "..knnnnnnnnnnk..",
        "..kkkkkkkkkkkk..",
        "................",
        "................",
      ].join("\n"),
      jukebox: [
        "................",
        "....kkkkkkkk....",
        "...kmmmmmmmmk...",
        "..kmkkkkkkkkmk..",
        "..kmkyyzzyykmk..",
        "..kmkkkkkkkkmk..",
        "..kmmmmmmmmmmk..",
        "..kmkcckkcckmk..",
        "..kmkcckkcckmk..",
        "..kmmmmmmmmmmk..",
        "..kmkkkkkkkkmk..",
        "..kmkpPpPpPkmk..",
        "..kmkkkkkkkkmk..",
        "..kkkkkkkkkkkk..",
        "................",
        "................",
      ].join("\n"),
      chest: [
        "................",
        "................",
        "...kkkkkkkkkk...",
        "..knnnnnnnnnnk..",
        ".knNnnnnnnnNnnk.",
        ".kzkkkkkkkkkkzk.",
        ".kzkkkkzzkkkkzk.",
        ".knnnnkyzknnnnk.",
        ".knNnnkzzknnNnk.",
        ".knnnnnkknnnnnk.",
        ".knnnnnnnnnnnnk.",
        ".kzNNNNNNNNNNzk.",
        ".kkkkkkkkkkkkkk.",
        "................",
        "................",
        "................",
      ].join("\n"),
      board: [
        "................",
        ".kkkkkkkkkkkkkk.",
        ".knnnnnnnnnnnnk.",
        ".kntttkttttttnk.",
        ".kntkttkTttttnk.",
        ".knttttktttttnk.",
        ".knttTttktrttnk.",
        ".kntttttttkttnk.",
        ".knnnnnnnnnnnnk.",
        ".kkkkkknnkkkkkk.",
        "......knnk......",
        "......knNk......",
        "......knnk......",
        ".....kkkkkk.....",
        "................",
        "................",
      ].join("\n"),
      note: [
        "................",
        "......kkkkkkkk..",
        "......kcccccck..",
        "......kckkkkck..",
        "......kck...ck..",
        "......kck...ck..",
        "......kck...ck..",
        "......kck...ck..",
        "...kkkkck.kkkck.",
        "..kcccccck.kcck.",
        "..kccccck.kccck.",
        "..kkccckk.kkkk..",
        "...kkkkk........",
        "................",
        "................",
        "................",
      ].join("\n"),
      mic: [
        "................",
        ".....kkkkk......",
        "....kgglggk.....",
        "....kgkgkgk.....",
        "....kglgglk.....",
        "....kgkgkgk.....",
        "....kgglggk.....",
        "...k.kGGGk.k....",
        "...kk.kkk.kk....",
        "....kk...kk.....",
        ".....kkkkk......",
        ".......k........",
        ".......k........",
        ".....kkkkk......",
        "................",
        "................",
      ].join("\n"),
    },
  };

  // ---------------------------------------------------------------- sprites
  const cache = {};
  function sprite(name) {
    if (cache[name]) return cache[name];
    const rows = (SP.sprites[name] || SP.sprites.star).trim().split("\n");
    const c = document.createElement("canvas");
    c.width = rows[0].length; c.height = rows.length;
    const g = c.getContext("2d");
    rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== ".") { g.fillStyle = SP.palette[ch]; g.fillRect(x, y, 1, 1); } }));
    return (cache[name] = c.toDataURL());
  }
  const img = (name, px, cls = "") => `<img class="gpx ${cls}" src="${sprite(name)}" width="${px}" height="${px}" alt="">`;
  const e = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const get = (k, d) => { try { return JSON.parse(localStorage.getItem("hub:game:" + k)) ?? d; } catch { return d; } };
  const put = (k, v) => { try { localStorage.setItem("hub:game:" + k, JSON.stringify(v)); } catch { /* private window */ } };

  // ---------------------------------------------------------------- sounds (made on the fly; off unless turned on)
  let ac = null;
  function tone(freq, start, dur, type = "square", vol = 0.06) {
    ac ??= new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator(), v = ac.createGain();
    o.type = type; o.frequency.value = freq;
    v.gain.setValueAtTime(vol, ac.currentTime + start);
    v.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + start + dur);
    o.connect(v).connect(ac.destination);
    o.start(ac.currentTime + start); o.stop(ac.currentTime + start + dur + 0.02);
  }
  const SOUNDS = {
    coin: () => { tone(988, 0, 0.08); tone(1319, 0.08, 0.25); },
    quest: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.09, 0.18)),
    level: () => [392, 523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, i * 0.08, i === 5 ? 0.5 : 0.12, "square", 0.07)),
    boss: () => { [196, 165, 131].forEach((f, i) => tone(f, i * 0.12, 0.2, "sawtooth", 0.05)); [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.45 + i * 0.08, 0.2)); },
    badge: () => [880, 1109, 1319].forEach((f, i) => tone(f, i * 0.07, 0.22, "triangle", 0.08)),
    click: () => tone(660, 0, 0.04, "square", 0.03),
  };
  const play = (n) => { if (get("sound", false)) try { SOUNDS[n]?.(); } catch { /* no audio */ } };

  // ---------------------------------------------------------------- the look
  const TABS = {
    today: ["HQ", "castle"], brief: ["Quests", "scroll"], jobs: ["World Map", "map"], est: ["The Forge", "anvil"],
    mail: ["Mailbox", "envelope"], people: ["Party", "party"], cal: ["Schedule", "hourglass"], walks: ["Scouting", "boot"], music: ["Jukebox", "jukebox"],
  };
  const CSS = `
  :root[data-game] {
    --side-bg: #140d2c; --side-ink: #f4f1ff; --side-muted: #b8aef0; --side-active: #2f2266;
    --bg: #1b1240; --panel: #281d58; --panel-2: #31246b; --ink: #f4f1ff; --muted: #c0b6f2; --line: #5a47b8; --soft: #221852;
    --brand: #ffcf3d; --brand-ink: #1a1426; --accent: #ffcf3d; --accent-ink: #1a1426; --link: #62dcef; --focus: #62dcef;
    --ok: #5fcf6a; --warn: #ffb347; --bad: #ff5f7a; --pill: #3a2c7a; color-scheme: dark;
    --sans: "Pixelify Sans", "Jost", system-ui, sans-serif; --pix: "Press Start 2P", "Pixelify Sans", monospace;
  }
  :root[data-game] body { background: #1b1240 radial-gradient(1px 1px at 20% 30%, #fff8 50%, transparent 51%) 0 0/97px 89px, radial-gradient(1px 1px at 70% 60%, #fff6 50%, transparent 51%) 0 0/131px 113px, radial-gradient(2px 2px at 40% 80%, #ffcf3d55 50%, transparent 51%) 0 0/211px 173px, #1b1240; }
  :root[data-game] body::after { content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 9998; background: repeating-linear-gradient(0deg, rgba(0,0,0,.09) 0 1px, transparent 1px 3px); }
  :root[data-game] .gpx { image-rendering: pixelated; image-rendering: crisp-edges; vertical-align: middle; }
  :root[data-game] h1, :root[data-game] h2, :root[data-game] .card h3, :root[data-game] #crumbs, :root[data-game] dialog h4 { font-family: var(--pix); letter-spacing: .5px; line-height: 1.5; }
  :root[data-game] .card h3 { font-size: 13px; }
  :root[data-game] #crumbs { font-size: 12px; color: var(--accent); }
  :root[data-game] .card { border: 0; border-radius: 0; background: var(--panel);
    box-shadow: 0 -4px 0 var(--line), 0 4px 0 var(--line), -4px 0 0 var(--line), 4px 0 0 var(--line), 0 8px 0 4px rgba(0,0,0,.35); margin: 4px; }
  :root[data-game] .btn, :root[data-game] .topbtn, :root[data-game] .side-foot button { border-radius: 0; border: 2px solid #0d0820; box-shadow: inset -3px -3px 0 rgba(0,0,0,.35), inset 3px 3px 0 rgba(255,255,255,.18); transition: transform .05s; }
  :root[data-game] .btn:active, :root[data-game] .topbtn:active { transform: translateY(2px); box-shadow: inset 3px 3px 0 rgba(0,0,0,.35); }
  :root[data-game] .btn.primary { background: #ffcf3d; color: #1a1426; border-color: #0d0820; font-weight: 700; }
  :root[data-game] .chip { border-radius: 0; }
  :root[data-game] input, :root[data-game] textarea, :root[data-game] select { border-radius: 0 !important; }
  :root[data-game] nav.tabs button { border-radius: 0; font-family: var(--pix); font-size: 10px; letter-spacing: .3px; }
  :root[data-game] nav.tabs button.active { background: #ffcf3d; color: #1a1426; box-shadow: inset -3px -3px 0 rgba(0,0,0,.3); }
  :root[data-game] nav.tabs button .gicon { width: 22px; height: 22px; flex: none; }
  :root[data-game] nav.tabs button:hover .gicon { animation: gbob .5s steps(2) infinite; }
  :root[data-game] dialog { border: 0; border-radius: 0; background: #120b2e; color: #f4f1ff; overflow: visible; box-shadow: 0 0 0 4px #f4f1ff, 0 0 0 8px #120b2e, 0 0 0 12px #5a47b8, 12px 16px 0 12px rgba(0,0,0,.4); }
  :root[data-game] dialog .foot { background: transparent; border-top: 2px dashed #3a2c7a; }
  :root[data-game] dialog::backdrop { background: rgba(10,4,30,.72); }
  :root[data-game] #approve > .in { padding-left: 92px; position: relative; min-height: 96px; }
  :root[data-game] #approve > .in::before { content: ""; position: absolute; left: 18px; top: 18px; width: 56px; height: 56px; background: var(--g-hero) center/contain no-repeat; image-rendering: pixelated; }
  :root[data-game] #approve .foot .btn::before { content: "▶ "; }
  @keyframes gbob { 50% { transform: translateY(-2px); } }
  @keyframes gfloat { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
  @keyframes gshake { 0%, 100% { transform: translateX(0); } 25% { transform: translateX(-4px); } 75% { transform: translateX(4px); } }
  @keyframes gin { from { transform: translateX(120%); } to { transform: translateX(0); } }
  @keyframes gpop { 0% { transform: scale(.3); opacity: 0; } 60% { transform: scale(1.15); opacity: 1; } 100% { transform: scale(1); } }
  @keyframes gspark { to { transform: translate(var(--dx), var(--dy)) rotate(180deg); opacity: 0; } }
  @keyframes gblink { 50% { opacity: .2; } }
  .ghud { display: flex; align-items: center; gap: 10px; margin-right: auto; margin-left: 12px; cursor: pointer; font-family: "Press Start 2P", monospace; font-size: 10px; color: #f4f1ff; }
  .ghud .lv { color: #ffcf3d; white-space: nowrap; }
  .ghud .tt { color: #c0b6f2; white-space: nowrap; }
  .gbar { position: relative; height: 12px; background: #0d0820; box-shadow: 0 0 0 2px #f4f1ff; min-width: 120px; }
  .gbar > i { position: absolute; inset: 0 auto 0 0; background: linear-gradient(#7ff09a, #3fb35a); }
  .gbar.xp > i { background: linear-gradient(#8ff0ff, #3aa9c9); }
  .gbar.gold > i { background: linear-gradient(#ffe066, #e0a21a); }
  .gbar > b { position: absolute; inset: 0; text-align: center; font: 8px/12px "Press Start 2P", monospace; color: #fff; text-shadow: 1px 1px 0 #000; }
  .ghud .snd { background: none; border: 0; cursor: pointer; font-size: 15px; padding: 0 4px; color: inherit; }
  .gboard { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr) minmax(0, 1fr); gap: 16px; }
  @media (max-width: 1100px) { .gboard { grid-template-columns: 1fr; } }
  .gboard .card h3 .gpx { margin-right: 8px; }
  .gq { display: grid; grid-template-columns: 26px 1fr auto; gap: 4px 10px; align-items: center; padding: 8px 0; border-bottom: 2px dashed #3a2c7a; }
  .gq:last-child { border-bottom: 0; }
  .gq .nm { font-weight: 600; }
  .gq.done .nm { text-decoration: line-through; color: var(--muted); }
  .gq .rw { font-family: "Press Start 2P", monospace; font-size: 9px; color: #ffcf3d; }
  .gq .gbar { grid-column: 2 / 4; height: 10px; }
  .gq .hn { grid-column: 2 / 4; font-size: 13px; color: var(--muted); }
  .gboss { text-align: center; }
  .gboss .mon { animation: gfloat 1.6s steps(4) infinite; margin: 4px auto 6px; display: block; }
  .gboss .mon.hit { animation: gshake .25s steps(2) 3; }
  .gboss .hp { display: flex; justify-content: center; gap: 4px; margin: 6px 0; }
  .gboss .who { font-family: "Press Start 2P", monospace; font-size: 11px; color: #ff6fbf; line-height: 1.6; }
  .gboss .why { color: var(--muted); font-size: 14px; margin: 4px 0 10px; }
  .gplayer { display: grid; grid-template-columns: 72px 1fr; gap: 6px 12px; align-items: center; }
  .gplayer .hero { animation: gfloat 2.2s steps(4) infinite; }
  .gplayer .lvl { font-family: "Press Start 2P", monospace; font-size: 11px; color: #ffcf3d; line-height: 1.7; }
  .gstats { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 10px; font-size: 14px; }
  .gstats span { display: inline-flex; gap: 5px; align-items: center; }
  .gbadges { display: grid; grid-template-columns: repeat(auto-fill, minmax(40px, 1fr)); gap: 8px; margin-top: 12px; }
  .gbadges .gb { display: grid; place-items: center; height: 40px; background: #1a1240; box-shadow: inset 0 0 0 2px #3a2c7a; }
  .gbadges .gb.no img { filter: grayscale(1) brightness(.35); }
  .gbadges .gb.yes { box-shadow: inset 0 0 0 2px #ffcf3d; }
  .gfeed { margin-top: 12px; display: grid; gap: 4px; font-size: 13px; max-height: 170px; overflow: auto; }
  .gfeed div { display: flex; gap: 8px; } .gfeed b { color: #7ff09a; font-family: "Press Start 2P", monospace; font-size: 8px; line-height: 18px; min-width: 52px; }
  .gpath { display: inline-flex; gap: 2px; margin-left: 8px; vertical-align: middle; }
  .gpath i { width: 9px; height: 9px; background: #2a1f5c; box-shadow: inset 0 0 0 1px #5a47b8; }
  .gpath i.past { background: #5fcf6a; box-shadow: none; }
  .gpath i.here { background: #ffcf3d; box-shadow: none; animation: gblink 1.2s steps(2) infinite; }
  .gpath.big { gap: 4px; margin: 0; flex-wrap: wrap; }
  .gpath.big i { width: auto; height: auto; padding: 5px 9px; font: 9px/1 "Press Start 2P", monospace; font-style: normal; color: #c0b6f2; }
  .gpath.big i.past { color: #10301a; } .gpath.big i.here { color: #1a1426; animation: none; box-shadow: 0 0 0 2px #fff; }
  .gpath.lost { font: 9px "Press Start 2P", monospace; color: #ff5f7a; }
  .gtoasts { position: fixed; right: 16px; bottom: 110px; display: grid; gap: 8px; z-index: 9999; pointer-events: none; }
  .gtoast { display: flex; gap: 10px; align-items: center; background: #120b2e; color: #f4f1ff; padding: 10px 14px; box-shadow: 0 0 0 3px #f4f1ff, 0 0 0 6px #120b2e, 4px 8px 0 6px rgba(0,0,0,.4); animation: gin .25s steps(5); max-width: 380px; font-size: 14px; }
  .gtoast b { font-family: "Press Start 2P", monospace; font-size: 10px; color: #7ff09a; white-space: nowrap; }
  .gover { position: fixed; inset: 0; z-index: 10000; display: grid; place-items: center; background: rgba(10,4,30,.75); cursor: pointer; }
  .gover .box { text-align: center; color: #fff; animation: gpop .45s steps(6); }
  .gover h2 { font-family: "Press Start 2P", monospace; font-size: 34px; color: #ffcf3d; text-shadow: 4px 4px 0 #b85a12, 8px 8px 0 #1a1426; margin: 14px 0; animation: gblink .6s steps(2) 3; }
  .gover p { font-family: "Press Start 2P", monospace; font-size: 12px; line-height: 1.8; color: #c0b6f2; }
  .gspark { position: fixed; width: 10px; height: 10px; background: #ffcf3d; z-index: 10001; pointer-events: none; animation: gspark 1s steps(8) forwards; }
  :root[data-game] .gtoggle.on { background: #ffcf3d; color: #1a1426; }
  `;

  const FONTS = "https://fonts.googleapis.com/css2?family=Press+Start+2P&family=Pixelify+Sans:wght@400;500;600;700&display=swap";
  let state = null;

  function on() { return !!get("on", false); }

  function applyTabs(game) {
    for (const b of document.querySelectorAll("#tabs button[data-tab]")) {
      const t = TABS[b.dataset.tab];
      if (!t) continue;
      const ms = b.querySelector(".ms"), nm = b.querySelector(".nm");
      if (game) {
        if (nm && !nm.dataset.orig) nm.dataset.orig = nm.textContent;
        if (nm) nm.textContent = t[0];
        if (ms) ms.hidden = true;
        if (!b.querySelector(".gicon")) b.insertAdjacentHTML("afterbegin", img(t[1], 22, "gicon"));
      } else {
        if (nm?.dataset.orig) nm.textContent = nm.dataset.orig;
        if (ms) ms.hidden = false;
        b.querySelector(".gicon")?.remove();
      }
    }
  }

  function apply() {
    const game = on();
    const root = document.documentElement;
    if (game) root.setAttribute("data-game", ""); else root.removeAttribute("data-game");
    if (game && !document.getElementById("game-css")) {
      const l = document.createElement("link"); l.rel = "stylesheet"; l.href = FONTS; l.id = "game-fonts"; document.head.appendChild(l);
      const st = document.createElement("style"); st.id = "game-css"; st.textContent = CSS; document.head.appendChild(st);
      root.style.setProperty("--g-hero", `url(${sprite("hero")})`);
    }
    applyTabs(game);
    const btn = document.getElementById("gamebtn");
    if (btn) { btn.textContent = game ? "Game mode: On" : "Game mode"; btn.classList.toggle("on", game); btn.title = game ? "Back to the normal look" : "Turn Keystone into a game: quests, XP, levels, badges and a boss"; }
    const p = document.getElementById("prompt");
    if (p) { p.dataset.orig ??= p.placeholder; if (game) p.placeholder = "What's your next move? Ask anything, or drop files here"; else p.placeholder = p.dataset.orig; }
    document.querySelector(".ghud")?.remove();
    document.getElementById("gboard")?.remove();
    document.querySelectorAll(".gpath").forEach((x) => (x.parentElement?.childElementCount === 1 && x.parentElement.tagName === "DIV" && !x.parentElement.id ? x.parentElement : x).remove());
    if (game) { hud(); board(); decorate(); refresh(); }
  }

  // ---------------------------------------------------------------- HUD (top bar)
  function hud() {
    let h = document.querySelector(".ghud");
    const bar = document.querySelector(".topbar");
    if (!bar) return;
    if (!h) {
      h = document.createElement("div"); h.className = "ghud";
      bar.insertBefore(h, bar.querySelector(".topright"));
      h.addEventListener("click", (ev) => {
        if (ev.target.closest(".snd")) { put("sound", !get("sound", false)); if (get("sound", false)) { play("coin"); } hud(); return; }
        try { showTab("today"); } catch { /* page not ready */ }
      });
    }
    const s = state;
    const pct = s ? Math.round(((s.xp - s.levelFrom) / Math.max(1, s.levelTo - s.levelFrom)) * 100) : 0;
    h.innerHTML = s ? `${img("hero", 28)}<span class="lv">LV ${s.level}</span><span class="tt">${e(s.title)}</span>
      <span class="gbar xp" title="${s.xp} XP. ${s.levelTo - s.xp} more to level ${s.level + 1}"><i style="width:${pct}%"></i><b>${s.xp - s.levelFrom}/${s.levelTo - s.levelFrom}</b></span>
      <span title="Workdays in a row with points">${img("flame", 18)} ${s.streak}</span>
      <span title="Points today">${img("gem", 18)} +${s.xpToday}</span>
      <button class="snd" type="button" title="${get("sound", false) ? "Sound on (click to mute)" : "Sound off (click for game sounds)"}">${get("sound", false) ? "🔊" : "🔇"}</button>` : `${img("hero", 28)}<span class="lv">Loading…</span>`;
  }

  // ---------------------------------------------------------------- Quest Board (top of the dashboard)
  function board() {
    const host = document.getElementById("today");
    if (!host || !on()) return;
    let b = document.getElementById("gboard");
    if (!b) { b = document.createElement("div"); b.id = "gboard"; b.className = "gboard"; host.prepend(b); }
    const s = state;
    if (!s) { b.innerHTML = `<div class="card"><h3>${img("board", 20)}Quest Board</h3><div class="muted">Loading your quests…</div></div>`; return; }
    const pct = (a, z) => Math.round((Math.min(a, z) / Math.max(1, z)) * 100);
    const quests = s.quests.map((q) => `<div class="gq ${q.done ? "done" : ""}">${img(q.done ? "star" : "scroll", 22)}<span class="nm">${e(q.title)}</span><span class="rw">${q.done ? "DONE" : `+${q.xp} XP`}</span>
      <span class="gbar gold"><i style="width:${q.done ? 100 : pct(q.progress, q.goal)}%"></i><b>${q.done ? "COMPLETE" : `${q.progress}/${q.goal}`}</b></span><span class="hn">${e(q.hint)}</span></div>`).join("");
    const boss = s.boss;
    const hearts = boss ? Array.from({ length: boss.hpMax }, (_, i) => img(i < boss.hp ? "heart" : "heartEmpty", 22)).join("") : "";
    const bossHtml = boss ? `<div class="gboss">${img("boss", 112, `mon ${lastHits !== null && boss.hits > lastHits ? "hit" : ""}`)}
        <div class="who">#${boss.jobNumber} ${e(boss.name)}</div><div class="hp">${hearts}</div>
        <div class="why">${e(boss.title)} · waiting ${boss.days} day${boss.days === 1 ? "" : "s"}</div>
        <button class="btn primary" type="button" data-gattack="${boss.jobNumber}">⚔ Attack</button>
        <div class="small muted" style="margin-top:8px">Every action on this job hits it. Clear what's waiting to win +100 XP.</div></div>`
      : `<div class="gboss">${img("trophy", 80, "mon")}<div class="who">No boss in sight</div><div class="why">Nothing has been waiting on you. Nice work.</div></div>`;
    const earned = s.badges.filter((x) => x.earned).length;
    const badges = s.badges.map((x) => `<span class="gb ${x.earned ? "yes" : "no"}" title="${e(x.name)}: ${e(x.desc)}${x.earned ? ` (earned ${new Date(x.earned).toLocaleDateString()})` : ""}">${img(x.icon, 28)}</span>`).join("");
    const feed = s.feed.slice(0, 10).map((f) => `<div><b>+${f.xp}</b><span>${e(f.label)}</span></div>`).join("") || `<div class="muted">Your loot shows up here as you work.</div>`;
    const lpct = Math.round(((s.xp - s.levelFrom) / Math.max(1, s.levelTo - s.levelFrom)) * 100);
    b.innerHTML = `
      <div class="card"><h3><span>${img("scroll", 20)}Today's quests</span><span class="small muted">${s.quests.filter((q) => q.done).length}/${s.quests.length}</span></h3>${quests}</div>
      <div class="card"><h3><span>${img("sword", 20)}Boss fight</span><span class="small muted">${s.bossesBeaten} beaten</span></h3>${bossHtml}</div>
      <div class="card"><h3><span>${img("shield", 20)}Player</span><span class="small muted">${earned}/${s.badges.length} badges</span></h3>
        <div class="gplayer">${img("hero", 72, "hero")}<div><div class="lvl">LV ${s.level} ${e(s.title).toUpperCase()}</div>
          <span class="gbar xp" style="display:block;margin-top:6px"><i style="width:${lpct}%"></i><b>${s.xp - s.levelFrom}/${s.levelTo - s.levelFrom} XP</b></span></div></div>
        <div class="gstats"><span>${img("gem", 18)} ${s.xp} XP</span><span>${img("flame", 18)} ${s.streak}-day streak</span><span>${img("coin", 18)} +${s.xpToday} today</span></div>
        <div class="gbadges">${badges}</div>
        <div class="gfeed">${feed}</div></div>`;
  }
  let lastHits = null;
  document.addEventListener("click", (ev) => {
    const a = ev.target.closest("[data-gattack]");
    if (a) { play("click"); try { showTab("jobs"); openJob(Number(a.dataset.gattack)); } catch { /* page not ready */ } }
    if (on() && ev.target.closest("#tabs button")) play("click");
  });
  // The dashboard redraws itself; put the board back on top each time.
  const watch = new MutationObserver(() => { if (on() && !document.getElementById("gboard")) board(); });
  const startWatch = () => { const t = document.getElementById("today"); if (t) watch.observe(t, { childList: true }); };

  // ---------------------------------------------------------------- World Map: each job's place in the pipeline
  const WORLDS = [
    ["Lead", ["Qualify", "Lead", "FDA"]], ["Scout", ["Scope Walk", "Adjustment"]], ["Forge", ["Estimating", "Proposal Review"]],
    ["Bid", ["Proposal Submitted", "Supplement"]], ["Won", ["Job Won", "Waitlist", "WA/Contract Sent"]],
    ["Build", ["Job Prep", "Ordering Materials", "Materials Stand-by", "Scheduling", "Work In Progress", "On-Hold"]], ["Done", []],
  ];
  const worldOf = (stage) => { if (/closed lost/i.test(stage)) return -1; const i = WORLDS.findIndex(([, l]) => l.includes(stage)); return i < 0 ? WORLDS.length - 1 : i; };
  function path(stage, big) {
    const w = worldOf(stage);
    if (w < 0) return `<span class="gpath lost" title="Closed Lost">✕ GAME OVER</span>`;
    return `<span class="gpath ${big ? "big" : ""}" title="World ${w + 1} of ${WORLDS.length}: ${WORLDS[w][0]} (${e(stage)})">${WORLDS.map(([n], i) => `<i class="${i < w ? "past" : i === w ? "here" : ""}">${big ? n : ""}</i>`).join("")}</span>`;
  }
  function decorate() {
    if (!on()) return;
    for (const st of document.querySelectorAll("#list .stage")) {
      const sub = st.closest(".sub");
      if (sub && !sub.querySelector(".gpath")) sub.insertAdjacentHTML("beforeend", path(st.textContent.trim(), false));
    }
    const pill = document.querySelector("#job #stagebtn");
    const head = document.querySelector("#job .jobhead");
    if (pill && head && !document.querySelector("#job .gpath")) {
      const stage = [...pill.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
      head.insertAdjacentHTML("afterend", `<div style="margin:8px 0 4px">${path(stage, true)}</div>`);
    }
  }
  const watchJobs = new MutationObserver(() => decorate());
  const startJobsWatch = () => { for (const id of ["list", "job"]) { const el = document.getElementById(id); if (el) watchJobs.observe(el, { childList: true, subtree: id === "job" ? false : true }); } };

  // ---------------------------------------------------------------- pop-ups
  function toast(icon, xp, text) {
    let box = document.querySelector(".gtoasts");
    if (!box) { box = document.createElement("div"); box.className = "gtoasts"; document.body.appendChild(box); }
    const t = document.createElement("div"); t.className = "gtoast";
    t.innerHTML = `${img(icon, 28)}${xp ? `<b>+${xp} XP</b>` : ""}<span>${e(text)}</span>`;
    box.appendChild(t);
    setTimeout(() => t.remove(), 5000);
  }
  function sparks(n = 28) {
    const cx = innerWidth / 2, cy = innerHeight / 2, colors = ["#ffcf3d", "#62dcef", "#ff6fbf", "#7ff09a", "#ffffff"];
    for (let i = 0; i < n; i++) {
      const s = document.createElement("i"); s.className = "gspark";
      const a = (i / n) * Math.PI * 2, r = 140 + Math.random() * 220;
      s.style.cssText = `left:${cx}px;top:${cy}px;background:${colors[i % colors.length]};--dx:${Math.cos(a) * r}px;--dy:${Math.sin(a) * r}px`;
      document.body.appendChild(s); setTimeout(() => s.remove(), 1100);
    }
  }
  function overlay(icon, title, line) {
    const o = document.createElement("div"); o.className = "gover";
    o.innerHTML = `<div class="box">${img(icon, 128)}<h2>${e(title)}</h2><p>${e(line)}</p><p style="font-size:9px;margin-top:18px">click to continue</p></div>`;
    o.addEventListener("click", () => o.remove());
    document.body.appendChild(o); sparks();
    setTimeout(() => o.remove(), 4500);
  }

  // ---------------------------------------------------------------- data
  let busy = false, again = false;
  async function refresh() {
    if (!on()) return;
    if (busy) { again = true; return; }
    busy = true;
    try {
      const seen = get("seen", "");
      const r = await fetch(`/api/game?seen=${encodeURIComponent(seen)}`);
      if (!r.ok) throw new Error(String(r.status));
      const s = await r.json();
      const prev = state;
      lastHits = prev?.boss && s.boss && prev.boss.jobNumber === s.boss.jobNumber ? prev.boss.hits : null;
      state = s;
      put("seen", new Date().toISOString());
      // Celebrations, biggest first. The first load after switching on stays quiet.
      if (seen) {
        const lvBefore = get("level", s.level);
        if (s.level > lvBefore) { overlay("crown", "LEVEL UP!", `Level ${s.level}: ${s.title}`); play("level"); }
        for (const f of s.fresh) {
          if (f.kind === "boss") { overlay("sword", "BOSS DEFEATED!", f.label.replace(/^Boss beaten: /, "")); play("boss"); }
          else if (f.kind === "badge") { toast(s.badges.find((b) => f.label.endsWith(b.name))?.icon ?? "star", 0, f.label); play("badge"); }
          else if (f.kind === "quest") { toast("scroll", f.xp, f.label); play("quest"); }
          else { toast(f.kind === "won" ? "trophy" : f.kind === "proposal" ? "coin" : f.kind === "estimate" ? "anvil" : "gem", f.xp, f.label); play("coin"); }
        }
        if (prev?.boss && s.boss && prev.boss.jobNumber === s.boss.jobNumber && s.boss.hits > prev.boss.hits) toast("sword", 0, `Hit! #${s.boss.jobNumber} ${s.boss.name} is weakening`);
      }
      put("level", s.level);
      hud(); board();
    } catch { /* Keystone restarting; try again next time */ }
    finally { busy = false; if (again) { again = false; setTimeout(refresh, 500); } }
  }
  let t = null;
  const soon = () => { clearTimeout(t); t = setTimeout(refresh, 2500); };
  function listen() {
    try {
      const es = new EventSource("/api/events");
      es.onmessage = (m) => { try { const ev = JSON.parse(m.data); if (ev.type === "changed" || (ev.type === "task" && ev.state === "done")) soon(); } catch { /* not ours */ } };
    } catch { /* fine: the timer below still refreshes */ }
    setInterval(() => { if (on() && document.visibilityState === "visible") refresh(); }, 60_000);
  }

  // ---------------------------------------------------------------- the switch
  function init() {
    const foot = document.querySelector(".side-foot");
    if (foot && !document.getElementById("gamebtn")) {
      const b = document.createElement("button"); b.type = "button"; b.id = "gamebtn"; b.className = "gtoggle";
      foot.prepend(b);
      b.addEventListener("click", () => { put("on", !on()); if (on()) { put("seen", ""); } apply(); if (on()) play("level"); });
    }
    startWatch();
    startJobsWatch();
    listen();
    apply();
  }
  window.KeystoneGame = { refresh, sprite, toggle: () => document.getElementById("gamebtn")?.click() };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
