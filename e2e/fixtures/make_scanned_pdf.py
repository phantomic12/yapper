"""Generate the scanned-PDF e2e fixture (e2e/fixtures/scanned.pdf).

sample.pdf has a real text layer, so pdfjs extracts it without OCR. This
fixture is the other case: a single page whose only content is a bitmap of
two lines, with no text objects at all. pdfjs returns an empty text layer
and the app has to fall back to Tesseract to read it, which is the path
e2e_test.py's OCR step exercises.

Kept deliberately small and high-contrast (black on white, large type) so
recognition is fast and unambiguous — a fancy fixture would only make the
step flaky.

Run with:  uv run --with pillow python e2e/fixtures/make_scanned_pdf.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent / "scanned.pdf"

LINES = [
    "Yapper scanned document test.",
    "Optical character recognition found this line.",
]


def _font(size: int) -> ImageFont.ImageFont:
    """Prefer a real TTF; fall back to PIL's bitmap font if none is found."""
    for candidate in (
        r"C:\Windows\Fonts\arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    ):
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    return ImageFont.load_default()


def main() -> None:
    # 1700x2200 px at 200 DPI is a US-Letter page; 40pt type reads cleanly.
    img = Image.new("L", (1700, 2200), color=255)
    draw = ImageDraw.Draw(img)
    font = _font(72)

    y = 320
    for line in LINES:
        draw.text((200, y), line, fill=0, font=font)
        y += 160

    # PDF (not JPEG): Pillow re-encodes as a lossless image so the fixture
    # stays byte-identical across runs and OCR output is deterministic.
    img.save(OUT, "PDF", resolution=200.0)
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
