"""Generate test PDFs for E2E OCR testing.

Creates two PDFs in public/test-pdfs/:
1. text-based.pdf — has embedded text (no OCR needed)
2. scanned.pdf — image-only PDF (requires OCR to extract text)

Both contain the same known text so we can verify extraction accuracy.
"""
import os
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.lib.utils import ImageReader
from PIL import Image, ImageDraw, ImageFont
import io

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "test-pdfs")
os.makedirs(OUTPUT_DIR, exist_ok=True)

# Known text that both PDFs will contain — we verify this after extraction.
KNOWN_TEXT_LINES = [
    "The Quick Brown Fox Jumps Over The Lazy Dog",
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
    "She sells seashells by the seashore on sunny days.",
    "Pack my box with five dozen liquor jugs.",
    "How vexingly quick daft zebras jump!",
    "",
    "This is page content for OCR testing purposes.",
    "The year was 2024 and the document was scanned.",
]


def create_text_pdf(path: str):
    """Create a PDF with embedded text (extractable without OCR)."""
    c = rl_canvas.Canvas(path, pagesize=letter)
    width, height = letter
    y = height - 100
    for line in KNOWN_TEXT_LINES:
        c.drawString(80, y, line)
        y -= 20
    c.showPage()
    c.save()
    print(f"Created text-based PDF: {path}")


def create_scanned_pdf(path: str):
    """Create an image-only PDF (no embedded text — requires OCR)."""
    # Render the text as an image using PIL, then embed it in a PDF.
    img = Image.new("RGB", (612, 792), "white")
    draw = ImageDraw.Draw(img)

    # Use a built-in PIL font (bitmap). For better OCR accuracy we'd use
    # a TTF, but the default bitmap font works for Tesseract at 2x render.
    try:
        font = ImageFont.truetype("arial.ttf", 20)
    except (OSError, IOError):
        font = ImageFont.load_default()

    y = 80
    for line in KNOWN_TEXT_LINES:
        draw.text((60, y), line, fill="black", font=font)
        y += 30

    # Save image to a bytes buffer, then embed in PDF
    img_buf = io.BytesIO()
    img.save(img_buf, format="PNG")
    img_buf.seek(0)

    c = rl_canvas.Canvas(path, pagesize=letter)
    c.drawImage(ImageReader(img_buf), 0, 0, width=612, height=792)
    c.showPage()
    c.save()
    print(f"Created scanned (image-only) PDF: {path}")


if __name__ == "__main__":
    create_text_pdf(os.path.join(OUTPUT_DIR, "text-based.pdf"))
    create_scanned_pdf(os.path.join(OUTPUT_DIR, "scanned.pdf"))
    print(f"\nTest PDFs created in {os.path.abspath(OUTPUT_DIR)}")
