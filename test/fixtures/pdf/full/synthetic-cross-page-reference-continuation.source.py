# SPDX-License-Identifier: CC0-1.0
from pathlib import Path

from reportlab import rl_config
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import Paragraph


OUTPUT = Path(__file__).with_name("synthetic-cross-page-reference-continuation.pdf")
PAGE_WIDTH, PAGE_HEIGHT = letter
rl_config.useA85 = 0
REFERENCE = ParagraphStyle(
    "reference",
    fontName="Times-Roman",
    fontSize=9,
    leading=11,
    leftIndent=18,
    firstLineIndent=-18,
    spaceAfter=6,
)


def draw_paragraph(canvas, text, x, y, width, style=REFERENCE):
    paragraph = Paragraph(text, style)
    _, height = paragraph.wrap(width, PAGE_HEIGHT)
    paragraph.drawOn(canvas, x, y - height)
    return y - height - style.spaceAfter


canvas = Canvas(str(OUTPUT), pagesize=letter, invariant=1, pageCompression=1)
canvas.setTitle("Cross-page reference continuation regression fixture")
canvas.setAuthor("Zotero document-worker contributors")
canvas.setSubject("CC0-1.0 synthetic regression fixture")

canvas.setFont("Times-Bold", 14)
canvas.drawString(54, 735, "Synthetic channel-flow sources")
canvas.setFont("Times-Roman", 10)
canvas.drawString(54, 708, "The baseline method follows earlier work [1-3].")
canvas.drawString(54, 690, "Later measurements use the extended sources [4-6].")
canvas.drawString(54, 672, "Quiet vortices in a model channel (2019) describes the general topic.")
canvas.drawString(54, 654, "Wake control with imaginary sensors is ordinary prose here.")
canvas.setFont("Times-Bold", 12)
canvas.drawString(54, 116, "REFERENCES")
y = 100
y = draw_paragraph(canvas, "[1] A. Arbor, Quiet vortices in a model channel, <i>Invented Fluids</i> 12, 41 (2019).", 54, y, 500)
y = draw_paragraph(canvas, "[2] B. Birch, Wake control with imaginary sensors, <i>Invented Fluids</i> 15, 73 (2020).", 54, y, 500)
draw_paragraph(canvas, "[3] C. Cedar, Adaptive transport in a synthetic multi-", 54, y, 300)
canvas.setFont("Times-Roman", 8)
canvas.drawCentredString(PAGE_WIDTH / 2, 20, "1")
canvas.showPage()

canvas.setFont("Times-Roman", 8)
canvas.drawString(54, 760, "SYNTHETIC CHANNEL-FLOW SOURCES")
y = 730
y = draw_paragraph(canvas, "scale boundary layer, <i>Invented Fluids</i> 18, 105 (2021).", 72, y, 482)
y = draw_paragraph(canvas, "[4] D. Dogwood, Constructed shear measurements, <i>Journal of Synthetic Results</i> 4: 20-31 (2022).", 54, y, 500)
y = draw_paragraph(canvas, "[5] E. Elm, Fictional pressure statistics, <i>Journal of Synthetic Results</i> 5: 40-52 (2023).", 54, y, 500)
draw_paragraph(canvas, "[6] F. Fir, Reproducible invented turbulence, <i>Journal of Synthetic Results</i> 6: 60-74 (2024).", 54, y, 500)
canvas.setFont("Times-Roman", 8)
canvas.drawCentredString(PAGE_WIDTH / 2, 20, "2")
canvas.save()
