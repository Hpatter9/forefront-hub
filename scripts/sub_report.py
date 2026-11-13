#!/usr/bin/env python3
"""Forefront sub work order: what a subcontractor needs to do the job, room by room, with no prices.

    python sub_report.py order.json --photos <job>/photos --assets <skill>/assets --out <job>/estimate

order.json (written by Keystone from the estimate, the walk notes and the photos):

    {"job_number": 3184, "customer": "Wegener", "address": "...", "date": "2026-11-13", "trade": "Painter" | "",
     "contact": {"name": "Hunter Patterson", "phone": "(303) 660-6216"},
     "summary": "...", "access": "...", "general": ["..."],
     "rooms": [{"room": "Hall Bathroom",
                "work": [{"trade": "Drywall", "task": "Hang and finish 32 SF on the tub wall", "qty": "32 SF"}],
                "paint": {"walls": "...", "ceiling": "...", "trim": "...", "color": "...", "prep": "..."} | null,
                "notes": ["..."],
                "photos": [{"file": "previews/cc_....jpg", "caption": "..."}]}],
     "questions": ["..."]}

Writes "<Customer> - Sub Work Order[ (Trade)].pdf" and prints "-> <path>".
"""
from __future__ import annotations

import argparse
import io
import json
import re
import sys
from datetime import date
from pathlib import Path
from xml.sax.saxutils import escape

from PIL import Image, ImageOps
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib.utils import ImageReader
from reportlab.platypus import BaseDocTemplate, Flowable, Frame, KeepTogether, PageTemplate, Paragraph, Spacer, Table, TableStyle

PW, PH = letter
LM = RM = 0.6 * inch
TOP, BOTTOM = 0.95 * inch, 0.7 * inch
BODY_W = PW - LM - RM
NAVY, INK, MUTED, LINE, TINT, WARN = "#0f2748", "#1a1a1a", "#5a6472", "#c9d2de", "#eef3f9", "#b45309"
LONG_SIDE = 1300


def st(name, **kw):
    base = dict(fontName="Helvetica", fontSize=10.5, leading=14, textColor=INK)
    base.update(kw)
    return ParagraphStyle(name, **base)


BODY = st("body")
SMALL = st("small", fontSize=9, leading=11.5, textColor=MUTED)
CELL = st("cell", fontSize=10, leading=13)
CELL_B = st("cellb", fontSize=10, leading=13, fontName="Helvetica-Bold")
ROOM = st("room", fontSize=14, leading=17, fontName="Helvetica-Bold", textColor="#ffffff")
H = st("h", fontSize=11, leading=14, fontName="Helvetica-Bold", textColor=NAVY)
CAP = st("cap", fontSize=9, leading=11.5)
WARN_S = st("warn", fontSize=10, leading=13, textColor=WARN, fontName="Helvetica-Bold")


def P(text, style=BODY):
    return Paragraph(escape(str(text or "")).replace("\n", "<br/>"), style)


class Photo(Flowable):
    def __init__(self, data: bytes, size, max_w, max_h):
        super().__init__()
        self.reader = ImageReader(io.BytesIO(data))
        w, h = size
        scale = min(max_w / w, max_h / h)
        self.w, self.h = w * scale, h * scale

    def wrap(self, aw, ah):
        return self.w, self.h

    def draw(self):
        self.canv.drawImage(self.reader, 0, 0, self.w, self.h)


def load_photo(path: Path):
    im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    im.thumbnail((LONG_SIDE, LONG_SIDE))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=80)
    return buf.getvalue(), im.size


def safe(name: str) -> str:
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", name).strip() or "Job"


def bullets(items):
    return [Paragraph("&bull;&nbsp;&nbsp;" + escape(str(x)), BODY) for x in items if str(x).strip()]


def build(order: dict, photo_dir: Path | None, assets: Path | None, out_dir: Path) -> Path:
    company = {}
    if assets and (assets / "company.json").exists():
        company = json.loads((assets / "company.json").read_text(encoding="utf-8"))
    # The dark logo made for white pages (the one on the Xactimate documents); the other one is white, for dark covers.
    logo = assets / "xact_logo.png" if assets and (assets / "xact_logo.png").exists() else None
    trade = (order.get("trade") or "").strip()
    customer = order.get("customer") or "Job"
    title = "Sub Work Order" + (f" ({trade})" if trade else "")
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{safe(customer)} - {safe(title)}.pdf"
    contact = order.get("contact") or {}
    foot = " · ".join(x for x in [company.get("name", "Forefront Building + Restoration"), f"Questions on site: {contact.get('name', '')} {contact.get('phone', '')}".strip()] if x)

    def page(canv, doc):
        canv.saveState()
        y = PH - 0.42 * inch
        if logo:
            try:
                iw, ih = ImageReader(str(logo)).getSize()
                h = 0.42 * inch
                canv.drawImage(str(logo), LM, y - h + 4, width=iw * h / ih, height=h, mask="auto")
                canv.setFont("Helvetica-Bold", 11)
                canv.setFillColor(NAVY)
                canv.drawString(LM + iw * h / ih + 8, y - 12, company.get("name", "Forefront Building + Restoration"))
            except Exception:
                pass
        else:
            canv.setFont("Helvetica-Bold", 12)
            canv.setFillColor(NAVY)
            canv.drawString(LM, y - 10, company.get("name", "Forefront Building + Restoration"))
        canv.setFillColor(NAVY)
        canv.setFont("Helvetica-Bold", 15)
        canv.drawRightString(PW - RM, y - 6, title.upper())
        canv.setFont("Helvetica", 9.5)
        canv.setFillColor(MUTED)
        canv.drawRightString(PW - RM, y - 20, f"#{order.get('job_number', '')} {customer} · {order.get('address', '')}"[:110])
        canv.setStrokeColor(LINE)
        canv.line(LM, PH - TOP + 10, PW - RM, PH - TOP + 10)
        canv.setFont("Helvetica", 8.5)
        canv.drawString(LM, 0.42 * inch, foot[:120])
        canv.drawRightString(PW - RM, 0.42 * inch, f"Page {doc.page}")
        canv.restoreState()

    doc = BaseDocTemplate(str(out), pagesize=letter, leftMargin=LM, rightMargin=RM, topMargin=TOP, bottomMargin=BOTTOM, title=f"{title} - {customer}", author=company.get("name", "Forefront"))
    doc.addPageTemplates(PageTemplate(id="p", frames=[Frame(LM, BOTTOM, BODY_W, PH - TOP - BOTTOM, leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)], onPage=page))

    story = []
    info = [
        [P("Job", SMALL), P(f"#{order.get('job_number', '')} {customer}", CELL_B), P("Date", SMALL), P(order.get("date") or date.today().isoformat(), CELL)],
        [P("Address", SMALL), P(order.get("address", ""), CELL), P("For", SMALL), P(trade or "All trades", CELL_B)],
        [P("Forefront contact", SMALL), P(f"{contact.get('name', '')}  {contact.get('phone', '')}".strip(), CELL), P("Access", SMALL), P(order.get("access") or "Ask your Forefront contact", CELL)],
    ]
    t = Table(info, colWidths=[1.05 * inch, BODY_W / 2 - 1.05 * inch, 0.6 * inch, BODY_W / 2 - 0.6 * inch])
    t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("BOX", (0, 0), (-1, -1), 0.6, LINE), ("INNERGRID", (0, 0), (-1, -1), 0.3, LINE), ("BACKGROUND", (0, 0), (0, -1), TINT), ("BACKGROUND", (2, 0), (2, -1), TINT), ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5)]))
    story += [t, Spacer(1, 10)]
    if order.get("summary"):
        story += [P("The job in short", H), P(order["summary"]), Spacer(1, 8)]
    if order.get("general"):
        story += [P("For everyone on site", H), *bullets(order["general"]), Spacer(1, 8)]
    questions = [q for q in order.get("questions") or [] if str(q).strip()]
    if questions:
        box = Table([[[P("NOT SETTLED YET: check with Forefront before starting these", WARN_S), *bullets(questions)]]], colWidths=[BODY_W])
        box.setStyle(TableStyle([("BOX", (0, 0), (-1, -1), 1, colors.HexColor(WARN)), ("LEFTPADDING", (0, 0), (-1, -1), 8), ("RIGHTPADDING", (0, 0), (-1, -1), 8), ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6)]))
        story += [box, Spacer(1, 10)]

    for room in order.get("rooms") or []:
        block = []
        bar = Table([[P(room.get("room", "Room"), ROOM)]], colWidths=[BODY_W])
        bar.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), colors.HexColor(NAVY)), ("LEFTPADDING", (0, 0), (-1, -1), 8), ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 6)]))
        block += [bar, Spacer(1, 6)]
        work = [w for w in room.get("work") or [] if str(w.get("task", "")).strip()]
        if work:
            rows = [[P("Trade", SMALL), P("What to do", SMALL), P("How much", SMALL)]] + [[P(w.get("trade", ""), CELL_B), P(w.get("task", ""), CELL), P(w.get("qty", ""), CELL)] for w in work]
            wt = Table(rows, colWidths=[1.15 * inch, BODY_W - 2.2 * inch, 1.05 * inch], repeatRows=1)
            wt.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LINEBELOW", (0, 0), (-1, -1), 0.3, LINE), ("BACKGROUND", (0, 0), (-1, 0), TINT), ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]))
            block += [wt, Spacer(1, 8)]
        paint = room.get("paint") or None
        if paint and any(str(paint.get(k, "")).strip() for k in ("walls", "ceiling", "trim", "color", "prep")):
            rows = [[P("PAINT", CELL_B), P("", CELL)]] + [[P(label, SMALL), P(paint.get(key) or "Not in this scope", CELL)] for key, label in (("walls", "Walls to paint"), ("ceiling", "Ceiling"), ("trim", "Trim, doors, casing"), ("color", "Color and sheen"), ("prep", "Prep")) if str(paint.get(key, "")).strip()]
            pt = Table(rows, colWidths=[1.35 * inch, BODY_W - 1.35 * inch])
            pt.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("SPAN", (0, 0), (-1, 0)), ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#fff7e6")), ("BOX", (0, 0), (-1, -1), 0.8, colors.HexColor("#d9a441")), ("LINEBELOW", (0, 0), (-1, -2), 0.3, colors.HexColor("#e8cf9a")), ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4), ("LEFTPADDING", (0, 0), (-1, -1), 8)]))
            block += [pt, Spacer(1, 8)]
        if room.get("notes"):
            block += [P("Notes", H), *bullets(room["notes"]), Spacer(1, 6)]
        story.append(KeepTogether(block) if len(work) <= 10 else block[0])
        if len(work) > 10:
            story += block[1:]
        # Photos: up to three across, each with its caption.
        cells = []
        for ph in (room.get("photos") or [])[:6]:
            f = Path(ph.get("file", ""))
            f = f if f.is_absolute() else (photo_dir / f if photo_dir else f)
            if not f.exists():
                continue
            try:
                data, size = load_photo(f)
            except Exception as e:  # unreadable photo: leave it out, say so
                print(f"! skipped {f.name}: {e}", file=sys.stderr)
                continue
            cells.append([Photo(data, size, BODY_W / 3 - 8, 1.9 * inch), Spacer(1, 3), P(ph.get("caption", ""), CAP)])
        for i in range(0, len(cells), 3):
            row = cells[i:i + 3] + [[""]] * (3 - len(cells[i:i + 3]))
            g = Table([row], colWidths=[BODY_W / 3] * 3)
            g.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 8)]))
            story += [g, Spacer(1, 6)]
        story.append(Spacer(1, 10))

    story.append(P("This is the work to do, not a price. Anything not listed here, or anything that looks different on site, call your Forefront contact before doing it.", SMALL))
    doc.build(story)
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("order")
    ap.add_argument("--photos")
    ap.add_argument("--assets")
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    order = json.loads(Path(a.order).read_text(encoding="utf-8"))
    out = build(order, Path(a.photos) if a.photos else None, Path(a.assets) if a.assets else None, Path(a.out))
    print(f"-> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
