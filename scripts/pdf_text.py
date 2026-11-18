#!/usr/bin/env python3
"""Print the text of a PDF, page by page (for reading a report or an estimate without opening it).

    python pdf_text.py file.pdf [--max-pages 40]
"""
import argparse
import sys

import pdfplumber


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--max-pages", type=int, default=40)
    a = ap.parse_args()
    with pdfplumber.open(a.pdf) as pdf:
        pages = pdf.pages[: a.max_pages]
        for i, page in enumerate(pages, 1):
            text = (page.extract_text() or "").strip()
            print(f"--- page {i} of {len(pdf.pages)} ---")
            print(text if text else "(no text on this page: it's a drawing or a scan)")
        if len(pdf.pages) > len(pages):
            print(f"(stopped after {len(pages)} pages)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
