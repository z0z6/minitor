# Generuje ikony aplikacji: python3 scripts/make-icon.py <katalog app>
# Ikona: zaokrąglony kwadrat z gradientem + biała waga (symbol prawa)
from PIL import Image, ImageDraw, ImageFilter
import sys, os
S = 1024
def scales(d, cx, cy, k, col=(255,255,255,255), w=None):
    w = w or int(46*k)
    # słup i podstawa
    d.line([(cx, cy-300*k), (cx, cy+250*k)], fill=col, width=w)
    d.rounded_rectangle([cx-170*k, cy+230*k, cx+170*k, cy+230*k+w], radius=w//2, fill=col)
    # belka
    d.line([(cx-280*k, cy-200*k), (cx+280*k, cy-200*k)], fill=col, width=w)
    d.ellipse([cx-44*k, cy-344*k, cx+44*k, cy-256*k], fill=col)
    for sx in (-1, 1):
        px = cx + sx*280*k
        top = cy-200*k
        # linki
        d.line([(px, top), (px-120*k, top+190*k)], fill=col, width=int(w*0.55))
        d.line([(px, top), (px+120*k, top+190*k)], fill=col, width=int(w*0.55))
        # szalka
        d.pieslice([px-150*k, top+110*k, px+150*k, top+290*k], 0, 180, fill=col)
def make(size, rounded=True, bg=True, scale=0.8):
    img = Image.new('RGBA', (S, S), (0,0,0,0))
    if bg:
        grad = Image.new('RGBA', (S, S))
        g = ImageDraw.Draw(grad)
        for y in range(S):
            t = y/(S-1)
            r = int(10 + (88-10)*t); gg = int(132 + (86-132)*t); b = int(255 + (214-255)*t)
            g.line([(0,y),(S,y)], fill=(r,gg,b,255))
        mask = Image.new('L', (S, S), 0)
        ImageDraw.Draw(mask).rounded_rectangle([40,40,S-40,S-40], radius=230 if rounded else 0, fill=255)
        if not rounded:
            mask = Image.new('L', (S, S), 255)
        img.paste(grad, (0,0), mask)
    fg = Image.new('RGBA', (S, S), (0,0,0,0))
    scales(ImageDraw.Draw(fg), S/2, S/2+20*scale, 1.0*scale)
    shadow = fg.copy().filter(ImageFilter.GaussianBlur(14))
    sh = Image.new('RGBA', (S,S), (0,0,0,0)); sh.paste((0,0,40,70), (0,12), shadow)
    if bg: img = Image.alpha_composite(img, sh)
    img = Image.alpha_composite(img, fg)
    return img.resize((size, size), Image.LANCZOS)
out = sys.argv[1]
make(1024).save(f'{out}/build/icon.png')
make(512).save(f'{out}/www/icon.png')
# Android: klasyczne ikony + warstwa pierwszoplanowa ikony adaptacyjnej
dens = {'mdpi':1,'hdpi':1.5,'xhdpi':2,'xxhdpi':3,'xxxhdpi':4}
for d,f in dens.items():
    os.makedirs(f'{out}/android-res/mipmap-{d}', exist_ok=True)
    make(int(48*f)).save(f'{out}/android-res/mipmap-{d}/ic_launcher.png')
    # okrągła
    r = make(int(48*f), rounded=False)
    m = Image.new('L', r.size, 0); ImageDraw.Draw(m).ellipse([0,0,r.size[0]-1,r.size[1]-1], fill=255)
    rr = Image.new('RGBA', r.size, (0,0,0,0)); rr.paste(r, (0,0), m); rr.save(f'{out}/android-res/mipmap-{d}/ic_launcher_round.png')
    make(int(108*f), bg=False, scale=0.62).save(f'{out}/android-res/mipmap-{d}/ic_launcher_foreground.png')
# Ikona powiadomień Androida: biała sylwetka (drawable-*/ic_stat_monitor.png)
for d, f in {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}.items():
    os.makedirs(f'{out}/android-res/drawable-{d}', exist_ok=True)
    make(int(24 * f), bg=False, scale=1.0).save(f'{out}/android-res/drawable-{d}/ic_stat_monitor.png')
# Ekran startowy Androida: ikona na jasnym tle, w rozmiarach z szablonu Capacitor
SPLASH = {'drawable': (480, 320), 'drawable-land-mdpi': (480, 320), 'drawable-land-hdpi': (800, 480), 'drawable-land-xhdpi': (1280, 720),
          'drawable-land-xxhdpi': (1600, 960), 'drawable-land-xxxhdpi': (1920, 1280), 'drawable-port-mdpi': (320, 480),
          'drawable-port-hdpi': (480, 800), 'drawable-port-xhdpi': (720, 1280), 'drawable-port-xxhdpi': (960, 1600), 'drawable-port-xxxhdpi': (1280, 1920)}
for d, (w, hgt) in SPLASH.items():
    os.makedirs(f'{out}/android-res/{d}', exist_ok=True)
    bgimg = Image.new('RGBA', (w, hgt), (245, 245, 247, 255))
    ic = make(int(min(w, hgt) * 0.32))
    bgimg.alpha_composite(ic, ((w - ic.size[0]) // 2, (hgt - ic.size[1]) // 2))
    bgimg.convert('RGB').save(f'{out}/android-res/{d}/splash.png')
