"""Generate test files for the new document formats.

Creates test files in public/test-docs/ for: RTF, HTML, CSV, XLSX, PPTX, DOC.
Each contains known text so we can verify extraction accuracy in E2E tests.
"""
import os
import struct
import zipfile
import xml.etree.ElementTree as ET

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "test-docs")
os.makedirs(OUTPUT_DIR, exist_ok=True)

KNOWN_TEXT = "The quick brown fox jumps over the lazy dog"


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

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", ct_xml)
        z.writestr("_rels/.rels", root_rels)
        z.writestr("xl/workbook.xml", wb_xml)
        z.writestr("xl/_rels/workbook.xml.rels", rels_xml)
        z.writestr("xl/worksheets/sheet1.xml", sheet_xml)
        z.writestr("xl/sharedStrings.xml", ss_xml)

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

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", ct_xml)
        z.writestr("_rels/.rels", root_rels)
        z.writestr("ppt/presentation.xml", pres_xml)
        z.writestr("ppt/_rels/presentation.xml.rels", pres_rels)
        z.writestr("ppt/slides/slide1.xml", slide_xml)

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

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", ct_xml)
        z.writestr("_rels/.rels", root_rels)
        z.writestr("word/document.xml", doc_xml)

    print(f"Created DOCX: {path}")


if __name__ == "__main__":
    create_rtf(os.path.join(OUTPUT_DIR, "test.rtf"))
    create_html(os.path.join(OUTPUT_DIR, "test.html"))
    create_csv(os.path.join(OUTPUT_DIR, "test.csv"))
    create_xlsx(os.path.join(OUTPUT_DIR, "test.xlsx"))
    create_pptx(os.path.join(OUTPUT_DIR, "test.pptx"))
    create_docx(os.path.join(OUTPUT_DIR, "test.docx"))
    print(f"\nTest documents created in {os.path.abspath(OUTPUT_DIR)}")
