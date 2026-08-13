# SPDX-License-Identifier: CC0-1.0
# This file and its generated PDF are dedicated to the public domain.
from pathlib import Path


OUTPUT = Path(__file__).with_name("synthetic-printed-contents-outline.pdf")
PAGE_WIDTH = 612
PAGE_HEIGHT = 792

CHAPTERS = [
    ("Orbit Manual", "Quiet Signals"),
    ("Harbor Ledger", "Blue Measures"),
    ("Field Atlas", "Small Coordinates"),
    ("Archive Compass", "Paper Roads"),
    ("Lantern Index", "Night Entries"),
    ("Threshold Notes", "Open Margins"),
]


def pdf_string(value):
    return value.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def draw_text(commands, font, size, x, y, value):
    commands.append(f"BT /{font} {size} Tf 1 0 0 1 {x} {y} Tm ({pdf_string(value)}) Tj ET")


def draw_page_number(commands, value):
    draw_text(commands, "F4", 8, 300, 24, str(value))


def contents_page(chapters, page_number, continued=False):
    commands = []
    draw_text(commands, "F3", 20, 72, 730, "Contents" if not continued else "Contents continued")
    y = 675
    for index, (title, subtitle) in chapters:
        draw_text(commands, "F1", 12, 84, y, f"{title}: {subtitle}")
        draw_text(commands, "F1", 12, 510, y, str(index + 2))
        draw_text(commands, "F4", 9, 108, y - 17, f"Editor {chr(64 + index)}")
        y -= 72
    draw_page_number(commands, page_number)
    return "\n".join(commands) + "\n"


def chapter_page(index, title, subtitle):
    commands = []
    draw_text(commands, "F2", 24, 72, 710, title)
    draw_text(commands, "F3", 18, 72, 674, subtitle)
    draw_text(commands, "F5", 10, 72, 642, f"Editor {chr(64 + index)}")

    y = 590
    body_lines = [
        "This synthetic chapter contains ordinary prose arranged in a stable text block.",
        "Its display title is intentionally split across two typographic styles.",
        "The printed contents records the two fragments as one navigation entry.",
        "Repeated geometry keeps the example independent of vocabulary and language.",
        "A generated outline should use the navigation evidence and ignore other labels.",
    ]
    if index == 1:
        body_lines[0] = "Harbor Ledger: Blue Measures 4"
        body_lines[4] = "Field Atlas: Small Coordinates 5"
    for line in body_lines:
        draw_text(commands, "F1", 11, 72, y, line)
        y -= 16

    if index == 2:
        draw_text(commands, "F1", 11, 72, 420, "To the reader:")
        draw_text(commands, "F1", 11, 90, 396, "This salutation belongs to the prose, not to document navigation.")
    if index == 6:
        draw_text(commands, "F5", 16, 72, 300, "Archive Bulletin")
        draw_text(commands, "F1", 10, 72, 276, "A promotional heading is outside the printed contents map.")

    draw_page_number(commands, index + 2)
    return "\n".join(commands) + "\n"


def stream_object(data):
    encoded = data.encode("ascii")
    return b"<< /Length %d >>\nstream\n" % len(encoded) + encoded + b"endstream"


def build_pdf(page_streams):
    objects = []

    def add_object(value=b""):
        objects.append(value)
        return len(objects)

    catalog_ref = add_object()
    pages_ref = add_object()
    font_refs = {
        "F1": add_object(b"<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>"),
        "F2": add_object(b"<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold >>"),
        "F3": add_object(b"<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic >>"),
        "F4": add_object(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
        "F5": add_object(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>"),
    }
    page_refs = []
    for page_stream in page_streams:
        content_ref = add_object(stream_object(page_stream))
        resources = " ".join(f"/{name} {ref} 0 R" for name, ref in font_refs.items())
        page_refs.append(add_object(
            f"<< /Type /Page /Parent {pages_ref} 0 R /MediaBox [0 0 {PAGE_WIDTH} {PAGE_HEIGHT}] "
            f"/Resources << /Font << {resources} >> >> /Contents {content_ref} 0 R >>".encode("ascii")
        ))

    info_ref = add_object(
        b"<< /Title (Printed contents outline regression fixture) "
        b"/Author (Zotero document-worker contributors) "
        b"/Subject (CC0-1.0 synthetic regression fixture) >>"
    )
    objects[catalog_ref - 1] = f"<< /Type /Catalog /Pages {pages_ref} 0 R >>".encode("ascii")
    kids = " ".join(f"{ref} 0 R" for ref in page_refs)
    objects[pages_ref - 1] = f"<< /Type /Pages /Count {len(page_refs)} /Kids [{kids}] >>".encode("ascii")

    # Keep Git from treating PDF bytes as text and normalizing xref records.
    output = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\x00\n")
    offsets = [0]
    for number, value in enumerate(objects, start=1):
        offsets.append(len(output))
        output.extend(f"{number} 0 obj\n".encode("ascii"))
        output.extend(value)
        output.extend(b"\nendobj\n")
    xref_offset = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    output.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root {catalog_ref} 0 R /Info {info_ref} 0 R >>\n"
        f"startxref\n{xref_offset}\n%%EOF\n".encode("ascii")
    )
    return output


pages = [
    contents_page(list(enumerate(CHAPTERS[:3], start=1)), "i"),
    contents_page(list(enumerate(CHAPTERS[3:], start=4)), "ii", continued=True),
]
pages.extend(
    chapter_page(index, title, subtitle)
    for index, (title, subtitle) in enumerate(CHAPTERS, start=1)
)
OUTPUT.write_bytes(build_pdf(pages))
