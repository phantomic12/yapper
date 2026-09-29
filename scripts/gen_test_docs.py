"""Generate test files for the new document formats.

Creates test files in public/test-docs/ for: RTF, HTML, CSV, XLSX, PPTX, DOC.
Each contains known text so we can verify extraction accuracy in E2E tests.
"""
import os
import struct
import sys
import zipfile
import xml.etree.ElementTree as ET

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "test-docs")
os.makedirs(OUTPUT_DIR, exist_ok=True)

# Regenerating with no argument fills in whatever is missing. Overwriting is
# opt-in, because not every fixture here came from this script: test.docx is a
# real Word export (full namespace set, docProps, thumbnail), and running the
# generator used to replace it with the minimal stand-in built below — a
# committed real-world sample silently swapped for a synthetic one that misses
# every construct the real file contains.
FORCE = "--force" in sys.argv

# Fixtures this script must never overwrite, even with --force. test.docx is a
# real Word export — full namespace set, docProps, a thumbnail — and
# `create_docx` builds a minimal stand-in that exercises a fraction of those
# constructs, so writing it over the real file replaces a good fixture with a
# worse one. It is only ever generated when the file is missing entirely.
NEVER_OVERWRITE = {"test.docx"}

# Every zip entry gets this timestamp instead of "now". Otherwise each run
# produces byte-different archives from identical content, so regenerating a
# fixture shows up as a modification in git even when nothing changed — and a
# diff nobody can explain is a diff nobody reviews.
ZIP_EPOCH = (2020, 1, 1, 0, 0, 0)

KNOWN_TEXT = "The quick brown fox jumps over the lazy dog"


def _target(name: str):
    """Where to write a fixture, or None to leave the existing one alone."""
    path = os.path.join(OUTPUT_DIR, name)
    if not os.path.exists(path):
        return path
    if name in NEVER_OVERWRITE:
        print(f"Kept {path} (a real-world fixture this script does not produce)")
        return None
    if not FORCE:
        print(f"Kept existing: {path} (pass --force to regenerate)")
        return None
    return path


def _entry(name: str, data: str, compress: int = zipfile.ZIP_DEFLATED):
    """A (ZipInfo, data) pair for `writestr`, with a pinned timestamp.

    external_attr matches what `writestr` sets for a plain name, so pinning the
    date is the only difference from the default behaviour.
    """
    info = zipfile.ZipInfo(name, date_time=ZIP_EPOCH)
    info.compress_type = compress
    info.external_attr = 0o600 << 16
    return info, data


def create_rtf(path: str):
    """Create a minimal RTF file with known text."""
    rtf = (
        r"{\rtf1\ansi\fs24 "
        + KNOWN_TEXT
        + r"\par\par Lorem ipsum dolor sit amet.}"
    )
    with open(path, "w", encoding="ascii") as f:
        f.write(rtf)
    print(f"Created RTF: {path}")


def create_html(path: str):
    """Create an HTML file with known text."""
    html = f"""<!DOCTYPE html>
<html>
<head><title>Test Document</title>
<style>body {{ font-family: sans-serif; }}</style>
<script>console.log("ignore this");</script>
</head>
<body>
<h1>{KNOWN_TEXT}</h1>
<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>
<p>She sells seashells by the seashore.</p>
</body>
</html>"""
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"Created HTML: {path}")


def create_csv(path: str):
    """Create a CSV file with known text."""
    csv = (
        f"Name,Description,Value\n"
        f"Fox,{KNOWN_TEXT},42\n"
        f"Dog,Lazy companion,7\n"
        f'"Quote test","She said ""hello""",99\n'
    )
    with open(path, "w", encoding="utf-8") as f:
        f.write(csv)
    print(f"Created CSV: {path}")


def create_xlsx(path: str):
    """Create a minimal XLSX file with known text."""
    # XLSX is a ZIP with specific XML structure
    ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"

    # Shared strings
    ss_xml = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="{ns}" count="3" uniqueCount="3">
  <si><t>Name</t></si>
  <si><t>{KNOWN_TEXT}</t></si>
  <si><t>Value</t></si>
</sst>"""

    # Sheet1
    sheet_xml = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="{ns}">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="s"><v>1</v></c>
      <c r="C1" t="s"><v>2</v></c>
    </row>
    <row r="2">
      <c r="A2"><v>42</v></c>
      <c r="B2" t="s"><v>1</v></c>
      <c r="C2"><v>99</v></c>
    </row>
  </sheetData>
</worksheet>"""

    # Workbook
    wb_xml = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="{ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Sheet1" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>"""

    # Content types
    ct_xml = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>"""

    # Relationships
    rels_xml = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>"""

    root_rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"""

    with zipfile.ZipFile(path, "w") as z:
        z.writestr(*_entry("[Content_Types].xml", ct_xml))
        z.writestr(*_entry("_rels/.rels", root_rels))
        z.writestr(*_entry("xl/workbook.xml", wb_xml))
        z.writestr(*_entry("xl/_rels/workbook.xml.rels", rels_xml))
        z.writestr(*_entry("xl/worksheets/sheet1.xml", sheet_xml))
        z.writestr(*_entry("xl/sharedStrings.xml", ss_xml))

    print(f"Created XLSX: {path}")


def create_pptx(path: str):
    """Create a minimal PPTX file with known text."""
    ns_a = "http://schemas.openxmlformats.org/drawingml/2006/main"
    ns_p = "http://schemas.openxmlformats.org/presentationml/2006/main"
    ns_r = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

    # Slide1 XML with text
    slide_xml = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="{ns_a}" xmlns:p="{ns_p}" xmlns:r="{ns_r}">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:txBody>
          <a:p>
            <a:r><a:t>{KNOWN_TEXT}</a:t></a:r>
          </a:p>
          <a:p>
            <a:r><a:t>Lorem ipsum dolor sit amet.</a:t></a:r>
          </a:p>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>"""

    # Presentation
    pres_xml = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="{ns_a}" xmlns:p="{ns_p}" xmlns:r="{ns_r}">
  <p:sldIdLst>
    <p:sldId r:id="rId1"/>
  </p:sldIdLst>
</p:presentation>"""

    ct_xml = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>"""

    root_rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>"""

    pres_rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>"""

    with zipfile.ZipFile(path, "w") as z:
        z.writestr(*_entry("[Content_Types].xml", ct_xml))
        z.writestr(*_entry("_rels/.rels", root_rels))
        z.writestr(*_entry("ppt/presentation.xml", pres_xml))
        z.writestr(*_entry("ppt/_rels/presentation.xml.rels", pres_rels))
        z.writestr(*_entry("ppt/slides/slide1.xml", slide_xml))

    print(f"Created PPTX: {path}")


def create_docx(path: str):
    """Create a minimal DOCX file with known text using mammoth-compatible structure."""
    ns_w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

    doc_xml = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="{ns_w}">
  <w:body>
    <w:p><w:r><w:t>{KNOWN_TEXT}</w:t></w:r></w:p>
    <w:p><w:r><w:t>Lorem ipsum dolor sit amet.</w:t></w:r></w:p>
  </w:body>
</w:document>"""

    ct_xml = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""

    root_rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""

    with zipfile.ZipFile(path, "w") as z:
        z.writestr(*_entry("[Content_Types].xml", ct_xml))
        z.writestr(*_entry("_rels/.rels", root_rels))
        z.writestr(*_entry("word/document.xml", doc_xml))

    print(f"Created DOCX: {path}")


# ─── Reader-redesign fixtures ──────────────────────────────────────────
# reader-notes.docx and reader-probe.epub exist for the *visual* reader: the
# first proves inline styling survives into the document window, the second
# exercises EPUB spine walking. Both deliberately mix headings, paragraphs,
# lists and inline runs, because a single plain paragraph would let a viewer
# render "convincingly" while silently dropping every block type but one.


def _xml_ok(label: str, xml: str) -> str:
    """Parse-check generated XML before it is written.

    A malformed fixture is uniquely nasty: extraction returns *nothing*, the
    viewer shows a blank page, and the failure looks like a bug in the viewer
    rather than in the fixture. XML that does not parse fails here instead,
    where the message names the file.
    """
    try:
        ET.fromstring(xml)
    except ET.ParseError as e:
        raise SystemExit(f"{label}: generated XML does not parse: {e}")
    return xml


def create_reader_docx(path: str):
    """DOCX for the visual reader: headings, inline runs, list, escaped markup."""
    ns_w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

    doc_xml = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="{ns_w}">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>Reader Probe</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading2"/></w:pPr>
      <w:r><w:t>Rendering fidelity</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">The rendered page keeps styling: this sentence starts bold, </w:t></w:r>
      <w:r><w:t xml:space="preserve">runs plain in the middle, </w:t></w:r>
      <w:r><w:rPr><w:i/></w:rPr><w:t>and finishes italic.</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>Every sentence gets its own highlight as the voice moves through it.</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>
      <w:r><w:t>Bullet one carries a sentence of its own.</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>
      <w:r><w:t>Bullet two does as well.</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>Literal markup must stay inert: &lt;script&gt;alert(1)&lt;/script&gt; and &amp;amp; signs.</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>She sells seashells by the seashore.</w:t></w:r>
    </w:p>
  </w:body>
</w:document>"""

    _xml_ok("reader-notes.docx", doc_xml)

    ct_xml = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""

    root_rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""

    with zipfile.ZipFile(path, "w") as z:
        z.writestr(*_entry("[Content_Types].xml", ct_xml))
        z.writestr(*_entry("_rels/.rels", root_rels))
        z.writestr(*_entry("word/document.xml", doc_xml))

    print(f"Created DOCX: {path}")


def _xhtml(title: str, body: str) -> str:
    """One EPUB chapter. The declaration must be the first byte: a stray
    leading newline before `<?xml` is an XML parse error, and the failure mode
    downstream is an empty document rather than a complaint."""
    return _xml_ok(
        f"EPUB chapter {title}",
        f"""<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>{title}</title></head>
<body>
{body}
</body>
</html>""",
    )


def create_reader_epub(path: str):
    """EPUB for the visual reader: two spine items, block and inline structure."""
    nav = _xhtml(
        "Contents",
        '    <nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc">\n'
        '      <ol><li><a href="ch1.xhtml">Chapter One</a></li>'
        '<li><a href="ch2.xhtml">Chapter Two</a></li></ol>\n'
        '    </nav>',
    )

    ch1 = _xhtml(
        "One",
        "    <h1>Chapter One</h1>\n"
        "    <p>The reader should show this as a paragraph, not as one long line.</p>\n"
        f"    <p><strong>The rendered page keeps styling:</strong> this sentence starts bold, "
        f"<em>and finishes italic.</em></p>\n"
        "    <p>Every sentence gets its own highlight as the voice moves through it.</p>\n"
        "    <ul>\n"
        "      <li>Bullet one carries a sentence of its own.</li>\n"
        "      <li>Bullet two does as well.</li>\n"
        "    </ul>\n"
        "    <blockquote>She sells seashells by the seashore.</blockquote>\n"
        "    <p>Literal markup must stay inert: &lt;script&gt;alert(1)&lt;/script&gt; stays as text.</p>",
    )

    ch2 = _xhtml(
        "Two",
        "    <h1>Chapter Two</h1>\n"
        "    <p>Offsets continue across the spine instead of restarting at zero.</p>",
    )

    container_xml = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"""

    opf = _xml_ok(
        "reader-probe.epub",
        """<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:9f1c4d2a-reader-probe</dc:identifier>
    <dc:title>Reader Probe</dc:title>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>""",
    )

    # The mimetype entry must come first and be stored uncompressed, or the
    # file is not a valid EPUB even though every reader-visible part is present.
    with zipfile.ZipFile(path, "w") as z:
        z.writestr(*_entry("mimetype", "application/epub+zip", zipfile.ZIP_STORED))
        z.writestr(*_entry("META-INF/container.xml", container_xml))
        z.writestr(*_entry("OEBPS/content.opf", opf))
        z.writestr(*_entry("OEBPS/nav.xhtml", nav))
        z.writestr(*_entry("OEBPS/ch1.xhtml", ch1))
        z.writestr(*_entry("OEBPS/ch2.xhtml", ch2))

    print(f"Created EPUB: {path}")


if __name__ == "__main__":
    for name, make in (
        ("test.rtf", create_rtf),
        ("test.html", create_html),
        ("test.csv", create_csv),
        ("test.xlsx", create_xlsx),
        ("test.pptx", create_pptx),
        ("test.docx", create_docx),
        ("reader-notes.docx", create_reader_docx),
        ("reader-probe.epub", create_reader_epub),
    ):
        target = _target(name)
        if target:
            make(target)
    print(f"\nTest documents in {os.path.abspath(OUTPUT_DIR)}")
