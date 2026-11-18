#!/usr/bin/env python3
"""
Game mode's art, cut from Hunter's Little Town game (github.com/Hpatter9/Little-Town) into small files Keystone serves
from src/server/game-art/. Only the project's own art is used (PixelLab townsfolk and the settlers' building kit,
made for and owned by Little Town; see its CREDITS.md) plus the "Tiny RPG" town theme by Luis Zuno (@ansimuz), free
for personal and commercial use. Run again after changing what's picked:

    python3 scripts/build-game-art.py [path/to/Little-Town]
"""
import json, os, shutil, sys
from PIL import Image

LT = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("LITTLE_TOWN_DIR", "../Little-Town")
ART = os.path.join(LT, "src/renderer/art/iso")
OUT = os.path.join(os.path.dirname(__file__), "..", "src/server/game-art")
DIRS = ["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"]
os.makedirs(OUT, exist_ok=True)
meta = {"strips": {}, "buildings": {}}

def small(im):
    return im.quantize(colors=255, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)

def strip(name, look, anim, facing):
    """One animation, one facing, as a horizontal strip of equal frames cropped to what the figure uses."""
    d = os.path.join(ART, "folk", look)
    ix = json.load(open(os.path.join(d, "index.json")))
    fw, fh = ix["frame"]; n = ix["animations"][anim]["frames"]; row = DIRS.index(facing)
    sheet = Image.open(os.path.join(d, f"{anim}.png")).convert("RGBA")
    frames = [sheet.crop((i * fw, row * fh, (i + 1) * fw, (row + 1) * fh)) for i in range(n)]
    boxes = [f.getbbox() for f in frames if f.getbbox()]
    box = (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))
    w, h = box[2] - box[0], box[3] - box[1]
    out = Image.new("RGBA", (w * n, h))
    for i, f in enumerate(frames):
        out.alpha_composite(f.crop(box), (i * w, 0))
    small(out).save(os.path.join(OUT, f"{name}.png"), optimize=True)
    meta["strips"][name] = {"frames": n, "w": w, "h": h}

# The player: a builder with a hammer (swinging, and standing about).
strip("hero_hammer", "settlers/man_leather+hammer", "hammer", "south-east")
strip("hero_idle", "settlers/man_leather", "idle", "south-east")
# The bosses: one is picked per job. Each stands, flinches when hit (where it can) and falls when beaten.
for key, look in {"werewolf": "werewolf/man_beast", "lich": "lich/man_skeleton", "vampire": "vampire/man_lord", "orc": "orcs/man_brute"}.items():
    strip(f"boss_{key}_idle", look, "idle", "south-west")
    strip(f"boss_{key}_death", look, "death", "south-west")
    ix = json.load(open(os.path.join(ART, "folk", look, "index.json")))
    if "hurt" in ix["animations"]:
        strip(f"boss_{key}_hurt", look, "hurt", "south-west")

# The town: one building per level, and one per stage of a job on the World Map.
for b in ["well", "cottage", "workshop", "stockpile", "granary", "tavern", "watchtower", "chapel", "longhouse", "stone_gate", "signpost", "market_stall", "campfire", "cart", "oak_tree", "pine_tree"]:
    im = Image.open(os.path.join(ART, "kits/settlers", f"{b}.png")).convert("RGBA")
    im = im.crop(im.getbbox())
    small(im).save(os.path.join(OUT, f"b_{b}.png"), optimize=True)
    meta["buildings"][b] = {"w": im.width, "h": im.height}
im = Image.open(os.path.join(ART, "castles/dwarves/hold_hall.png")).convert("RGBA")
im = im.crop(im.getbbox()); im.thumbnail((260, 260))
small(im).save(os.path.join(OUT, "b_castle.png"), optimize=True)
meta["buildings"]["castle"] = {"w": im.width, "h": im.height}

shutil.copyfile(os.path.join(LT, "src/renderer/music/town.ogg"), os.path.join(OUT, "town.ogg"))
json.dump(meta, open(os.path.join(OUT, "art.json"), "w"), indent=1)
open(os.path.join(OUT, "CREDITS.md"), "w").write("""# Game mode art

- Townsfolk (the builder and the bosses) and the buildings are from **Little Town** (github.com/Hpatter9/Little-Town),
  Hunter's own game: made for and owned by that project (townsfolk generated with PixelLab, buildings drawn with
  ChatGPT's image generation), cut and reduced by `scripts/build-game-art.py`.
- `town.ogg`: "Tiny RPG" town theme by **Luis Zuno (@ansimuz)**, free for personal and commercial use.
""")
print("wrote", len(os.listdir(OUT)), "files")
