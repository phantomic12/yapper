"""Generate the tiny e2e PDF fixture (e2e/fixtures/sample.pdf).

A minimal single-page PDF whose text layer holds two short lines. pdfjs joins
each rendered line into its own paragraph (see src/document-reader.ts), so the
extracted text yields two paragraphs / two sentences — enough for the reader
to render spans without making the e2e run slow.
"""
from pathlib import Path

OUT = Path(__file__).resolve().parent / "sample.pdf"

objects = []
objects.append(b"<</Type/Catalog/Pages 2 0 R>>")
objects.append(b"<</Type/Pages/Kids[3 0 R]/Count 1>>")
objects.append(
    b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]"
    b"/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>"
)

stream = (
    b"BT /F1 16 Tf 72 720 Td (Yapper end-to-end test PDF.) Tj ET\n"
    b"BT /F1 16 Tf 72 690 Td (Second line proves pdfjs extraction worked.) Tj ET\n"
)
objects.append(b"<</Length %d>>stream\n%sendstream" % (len(stream), stream))
objects.append(b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>")

buf = bytearray(b"%PDF-1.4\n")
offsets = []
for i, body in enumerate(objects, start=1):
    offsets.append(len(buf))
    buf += b"%d 0 obj\n" % i + body + b"\nendobj\n"

xref_pos = len(buf)
buf += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
for off in offsets:
    buf += b"%010d 00000 n \n" % off
buf += (
    b"trailer\n<</Size %d/Root 1 0 R>>\nstartxref\n%d\n%%%%EOF\n"
    % (len(objects) + 1, xref_pos)
)

OUT.write_bytes(bytes(buf))
print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
