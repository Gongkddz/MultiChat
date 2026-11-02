"""Generate matching vector, PNG and multi-resolution Windows application icons."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'static' / 'brand'
OUT.mkdir(parents=True, exist_ok=True)

# Two open conversation brackets around a four-point spark: connected ideas.
SVG = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect x="2" y="2" width="60" height="60" rx="18" fill="#173f40"/>
<path d="M27 17H21a8 8 0 0 0-8 8v12a8 8 0 0 0 8 8h5l5 5v-8" fill="none" stroke="#edfaf4" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M37 47h6a8 8 0 0 0 8-8V27a8 8 0 0 0-8-8h-5l-5-5v8" fill="none" stroke="#76c9b5" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
<path d="m32 24 2.4 5.6L40 32l-5.6 2.4L32 40l-2.4-5.6L24 32l5.6-2.4z" fill="#edfaf4"/>
</svg>'''
(OUT / 'logo.svg').write_text(SVG, encoding='utf-8')
SCALE = 8
im = Image.new('RGBA', (64*SCALE, 64*SCALE))
d = ImageDraw.Draw(im)
def box(values): return tuple(int(v*SCALE) for v in values)
def line(points, color):
    pts = [(int(x*SCALE), int(y*SCALE)) for x,y in points]
    d.line(pts, fill=color, width=4*SCALE, joint='curve')
    for x,y in pts:
        d.ellipse((x-2*SCALE,y-2*SCALE,x+2*SCALE,y+2*SCALE),fill=color)
d.rounded_rectangle(box((2,2,62,62)), radius=18*SCALE, fill='#173f40')
line([(27,17),(21,17),(17,18),(14,21),(13,25),(13,37),(14,41),(17,44),(21,45),(26,45),(31,50),(31,42)], '#edfaf4')
line([(37,47),(43,47),(47,46),(50,43),(51,39),(51,27),(50,23),(47,20),(43,19),(38,19),(33,14),(33,22)], '#76c9b5')
d.polygon([(int(x*SCALE),int(y*SCALE)) for x,y in [(32,24),(34.4,29.6),(40,32),(34.4,34.4),(32,40),(29.6,34.4),(24,32),(29.6,29.6)]], fill='#edfaf4')
im.resize((512,512),Image.Resampling.LANCZOS).save(OUT/'logo.png')
im.save(OUT/'app.ico',format='ICO',sizes=[(16,16),(20,20),(24,24),(32,32),(40,40),(48,48),(64,64),(128,128),(256,256)])
print('Brand assets generated:', OUT)
