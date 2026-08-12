# SPDX-License-Identifier: CC0-1.0
# This file and its generated PDF are dedicated to the public domain.
from pathlib import Path

from reportlab import rl_config
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import Paragraph


OUTPUT = Path(__file__).with_name("synthetic-cross-page-mixed-notes.pdf")
PAGE_WIDTH, PAGE_HEIGHT = letter
rl_config.useA85 = 0
NOTE = ParagraphStyle(
    "note",
    fontName="Times-Roman",
    fontSize=9,
    leading=11,
    leftIndent=16,
    firstLineIndent=-16,
    spaceAfter=5,
)


def draw_notes(canvas, notes, x, y, width):
    for text in notes:
        paragraph = Paragraph(text, NOTE)
        _, height = paragraph.wrap(width, PAGE_HEIGHT)
        paragraph.drawOn(canvas, x, y - height)
        y -= height + NOTE.spaceAfter


canvas = Canvas(str(OUTPUT), pagesize=letter, invariant=1, pageCompression=1)
canvas.setTitle("Cross-page mixed notes regression fixture")
canvas.setAuthor("Zotero document-worker contributors")
canvas.setSubject("CC0-1.0 synthetic regression fixture")

canvas.setFont("Times-Bold", 13)
canvas.drawString(54, 720, "Cross-page notes")
canvas.setFont("Times-Roman", 11)
canvas.drawString(54, 695, "A numbered note run continues onto the facing page.")
canvas.setFont("Times-Bold", 13)
canvas.drawString(54, 290, "Notes")
draw_notes(canvas, [
    "1. &#8220;Vortices in Quiet Channels,&#8221; <i>Journal of Fictional Fluid Studies</i>, July 1904: 10-20.",
    "2. &#8220;Adaptive Wake Control,&#8221; <i>Journal of Fictional Fluid Studies</i>, March 2021: 81-99.",
    "3. This explanatory note deliberately contains no source date.",
], 54, 280, 500)
canvas.setFont("Times-Roman", 8)
canvas.drawCentredString(PAGE_WIDTH / 2, 20, "1")
canvas.showPage()

draw_notes(canvas, [
    "4. A. Quill, &#8220;Friction in Model Boundary Layers,&#8221; <i>Synthetic Aerodynamics</i> 12: 75-90 (1994).",
    "5. B. North, &#8220;Simulated Turbulent Transport,&#8221; <i>Synthetic Aerodynamics</i> 18: 154-171 (2011).",
    "6. This second explanatory note also contains no source date.",
    "7. &#8220;Adaptive Wake Control,&#8221; <i>Journal of Fictional Fluid Studies</i>, March 2021: 81-99.",
], 66, 730, 488)
canvas.setFont("Times-Roman", 8)
canvas.drawCentredString(PAGE_WIDTH / 2, 20, "2")
canvas.save()
