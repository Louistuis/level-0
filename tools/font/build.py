#!/usr/bin/env python3
"""Troffer: the LEVEL 0 typeface.

Every glyph is a handful of tubes: straight runs and bent corners, the way a
fluorescent sign shop would build letters. One skeleton set makes two cuts:

  Troffer Tube   display. The tubes stay separate, with a gap at every joint.
  Troffer Sign   text. The same tubes welded together, like routed door signs.

Needs fonttools, brotli and skia-pathops:
  python3 -m venv .venv && .venv/bin/pip install fonttools brotli skia-pathops
  .venv/bin/python tools/font/build.py
Writes dist/assets/troffer-*.woff2 and tools/font/specimen.svg.
"""
import math, os, sys
import pathops
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.svgPathPen import SVGPathPen

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, '..', '..', 'dist', 'assets'))
CAP, DESC, ASC = 700, -210, 760


def s(pts, a='', b='', closed=False):
    """One tube. pts: 'x,y[,r] ...'. a/b: how the start/end meets another tube.
    'T' = butts into the side of a tube, 'E' = meets another tube end to end."""
    P = []
    for tok in pts.split():
        v = [float(t) for t in tok.split(',')]
        P.append((v[0], v[1], v[2] if len(v) > 2 else 0.0))
    return (P, a, b, closed)


def O(w, h, r, y0=0):
    """Round-cornered loop made of two bent tubes that meet top and bottom."""
    m = w / 2
    return [s(f'{m},{y0 + h} 0,{y0 + h},{r} 0,{y0},{r} {m},{y0}', 'E', 'E'),
            s(f'{m},{y0 + h} {w},{y0 + h},{r} {w},{y0},{r} {m},{y0}', 'E', 'E')]


def dot(x, y):
    return s(f'{x},{y} {x},{y + 2}')


G = {}  # name -> (centre-line width, [tubes])
U = {}  # codepoint -> name


def g(ch, w, tubes, name=None):
    name = name or (ch if ch.isalnum() and ch.isascii() else 'u%04X' % ord(ch))
    if ch.isascii() and ch.islower():
        name = ch + '.lc'
    G[name] = (w, tubes)
    U[ord(ch)] = name
    return name


# ---- capitals -------------------------------------------------------------
g('A', 540, [s('0,0 270,700,40 540,0'), s('93,240 447,240', 'T', 'T')])
g('B', 480, [s('0,0 0,700'), s('0,700 440,700,160 440,370', 'T', 'T'), s('0,370 480,370,175 480,0,175 0,0', 'T', 'T')])
g('C', 480, [s('480,540 480,700,170 0,700,170 0,0,170 480,0,170 480,160')])
g('D', 500, [s('0,0 0,700'), s('0,700 500,700,200 500,0,200 0,0', 'T', 'T')])
g('E', 440, [s('0,0 0,700'), s('0,700 440,700', 'T'), s('0,360 380,360', 'T'), s('0,0 440,0', 'T')])
g('F', 430, [s('0,0 0,700'), s('0,700 430,700', 'T'), s('0,360 360,360', 'T')])
g('G', 500, [s('500,540 500,700,170 0,700,170 0,0,170 500,0,170 500,330,40 270,330')])
g('H', 500, [s('0,0 0,700'), s('500,0 500,700'), s('0,360 500,360', 'T', 'T')])
g('I', 0, [s('0,0 0,700')])
g('J', 400, [s('400,700 400,0,170 0,0,170 0,200')])
g('K', 480, [s('0,0 0,700'), s('0,290 470,700', 'T'), s('170,438 480,0', 'T')])
g('L', 420, [s('0,0 0,700'), s('0,0 420,0', 'T')])
g('M', 620, [s('0,0 0,700'), s('620,0 620,700'), s('0,700 310,200,30 620,700', 'T', 'T')])
g('N', 520, [s('0,0 0,700'), s('520,0 520,700'), s('0,700 520,0', 'T', 'T')])
g('O', 520, O(520, 700, 190))
g('P', 470, [s('0,0 0,700'), s('0,700 470,700,170 470,330,170 0,330', 'T', 'T')])
g('Q', 520, O(520, 700, 190) + [s('400,0 520,-140', 'T')])
g('R', 480, [s('0,0 0,700'), s('0,700 470,700,170 470,340,170 0,340', 'T', 'T'), s('240,340 480,0', 'T')])
g('S', 480, [s('480,560 480,700,165 0,700,165 0,360,165 480,360,165 480,0,165 0,0,165 0,140')])
g('T', 480, [s('0,700 480,700'), s('240,0 240,700', '', 'T')])
g('U', 500, [s('0,700 0,0,190 500,0,190 500,700')])
g('V', 520, [s('0,700 260,0,40 520,700')])
g('W', 760, [s('0,700 190,0,40 380,560,40 570,0,40 760,700')])
g('X', 500, [s('0,0 500,700'), s('0,700 250,350', '', 'T'), s('500,0 250,350', '', 'T')])
g('Y', 500, [s('0,700 250,330,40 500,700'), s('250,0 250,330', '', 'T')])
g('Z', 480, [s('0,700 480,700,30 0,0,30 480,0')])

# ---- figures (tabular) ----------------------------------------------------
g('0', 480, O(480, 700, 180), 'zero')
g('1', 480, [s('260,0 260,700'), s('110,560 260,700', '', 'T')], 'one')
g('2', 480, [s('0,560 0,700,165 480,700,165 480,360,165 0,360,165 0,0,30 480,0')], 'two')
g('3', 480, [s('0,560 0,700,165 480,700,165 480,0,165 0,0,165 0,140'), s('230,360 480,360', '', 'T')], 'three')
g('4', 480, [s('370,0 370,700'), s('370,700 0,230,30 370,230', 'T', 'T'), s('370,230 480,230', 'T')], 'four')
g('5', 480, [s('480,700 0,700,40 0,390,40 480,390,170 480,0,170 0,0,165 0,140')], 'five')
g('6', 480, [s('480,560 480,700,165 0,700,165 0,0,170 480,0,170 480,390,170 0,390', '', 'T')], 'six')
g('7', 480, [s('0,700 480,700,60 160,0')], 'seven')
g('8', 480, [s('34,366 34,700,160 446,700,160 446,366', 'T', 'T'), s('0,366,62 480,366,62 480,0,175 0,0,175', closed=True)], 'eight')
g('9', 480, [s('0,140 0,0,165 480,0,165 480,700,170 0,700,170 0,330,170 480,330', '', 'T')], 'nine')

# ---- lowercase ------------------------------------------------------------
X = 490
g('a', 420, [s('420,0 420,490'), s('420,490 0,490,150 0,0,150 420,0', 'T', 'T')])
g('b', 420, [s('0,0 0,700'), s('0,490 420,490,150 420,0,150 0,0', 'T', 'T')])
g('c', 420, [s('420,370 420,490,150 0,490,150 0,0,150 420,0,150 420,120')])
g('d', 420, [s('420,0 420,700'), s('420,490 0,490,150 0,0,150 420,0', 'T', 'T')])
g('e', 420, [s('0,250 420,250,70 420,490,150 0,490,150 0,0,150 420,0,150 420,110', 'T')])
g('f', 320, [s('120,0 120,700,130 320,700'), s('0,490 120,490', '', 'T'), s('120,490 300,490', 'T')])
g('g', 420, [s('420,490 420,-210,150 60,-210'), s('420,490 0,490,150 0,0,150 420,0', 'T', 'T')])
g('h', 420, [s('0,0 0,700'), s('0,490 420,490,150 420,0', 'T')])
g('i', 0, [s('0,0 0,490'), dot(0, 668)])
g('j', 140, [s('140,490 140,-210,130 0,-210'), dot(140, 668)])
g('k', 400, [s('0,0 0,700'), s('0,200 380,490', 'T'), s('150,315 400,0', 'T')])
g('l', 160, [s('0,700 0,0,120 160,0')])
g('m', 680, [s('0,0 0,490'), s('0,490 680,490,140 680,0', 'T'), s('340,0 340,490', '', 'T')])
g('n', 420, [s('0,0 0,490'), s('0,490 420,490,150 420,0', 'T')])
g('o', 420, O(420, 490, 150))
g('p', 420, [s('0,-210 0,490'), s('0,490 420,490,150 420,0,150 0,0', 'T', 'T')])
g('q', 420, [s('420,-210 420,490'), s('420,490 0,490,150 0,0,150 420,0', 'T', 'T')])
g('r', 280, [s('0,0 0,490'), s('0,490 280,490', 'T')])
g('s', 400, [s('400,380 400,490,120 0,490,120 0,250,120 400,250,120 400,0,120 0,0,120 0,110')])
g('t', 320, [s('120,700 120,0,130 320,0'), s('0,490 120,490', '', 'T'), s('120,490 300,490', 'T')])
g('u', 420, [s('0,490 0,0,150 420,0', '', 'T'), s('420,0 420,490')])
g('v', 420, [s('0,490 210,0,40 420,490')])
g('w', 640, [s('0,490 160,0,40 320,400,40 480,0,40 640,490')])
g('x', 420, [s('0,0 420,490'), s('0,490 210,245', '', 'T'), s('420,0 210,245', '', 'T')])
g('y', 420, [s('0,490 0,0,150 420,0', '', 'T'), s('420,490 420,-210,150 60,-210')])
g('z', 420, [s('0,490 420,490,30 0,0,30 420,0')])

# ---- punctuation and marks ------------------------------------------------
g('.', 0, [dot(0, 0)], 'period')
g(',', 40, [s('40,10 0,-120')], 'comma')
g(':', 0, [dot(0, 0), dot(0, 410)], 'colon')
g(';', 40, [s('40,10 0,-120'), dot(40, 410)], 'semicolon')
g('!', 0, [s('0,220 0,700'), dot(0, 0)], 'exclam')
g('?', 400, [s('0,560 0,700,150 400,700,150 400,380,120 200,380,50 200,215'), dot(200, 0)], 'question')
g('-', 300, [s('0,300 300,300')], 'hyphen')
g('–', 440, [s('0,300 440,300')], 'endash')
g('_', 480, [s('0,-130 480,-130')], 'underscore')
g('/', 340, [s('0,-60 340,760')], 'slash')
g('\\', 340, [s('340,-60 0,760')], 'backslash')
g('(', 160, [s('160,790 0,600,120 0,100,120 160,-90')], 'parenleft')
g(')', 160, [s('0,790 160,600,120 160,100,120 0,-90')], 'parenright')
g('[', 180, [s('180,790 0,790 0,-90 180,-90')], 'bracketleft')
g(']', 180, [s('0,790 180,790 180,-90 0,-90')], 'bracketright')
g('+', 400, [s('0,330 400,330'), s('200,130 200,330', '', 'T'), s('200,530 200,330', '', 'T')], 'plus')
g('=', 400, [s('0,230 400,230'), s('0,430 400,430')], 'equal')
g("'", 0, [s('0,560 0,700')], 'quotesingle')
g('’', 0, [s('0,560 0,700')], 'quoteright')
g('"', 150, [s('0,560 0,700'), s('150,560 150,700')], 'quotedbl')
g('%', 520, [s('20,0 500,700'), s('0,500,75 160,500,75 160,700,75 0,700,75', closed=True), s('360,0,75 520,0,75 520,200,75 360,200,75', closed=True)], 'percent')
g('@', 600, [s('470,-80 0,-80,180 0,620,180 600,620,180 600,120,100 420,120 420,430'), s('420,430 180,430,110 180,120,110 420,120', 'T', 'T')], 'at')
g('°', 160, [s('0,520,80 160,520,80 160,700,80 0,700,80', closed=True)], 'degree')
g('·', 0, [dot(0, 340)], 'periodcentered')
g('•', 0, [dot(0, 340)], 'bullet')
g('×', 300, [s('0,150 300,450'), s('0,450 150,300', '', 'T'), s('300,150 150,300', '', 'T')], 'multiply')
g('→', 470, [s('0,330 470,330', '', 'T'), s('300,500 470,330,20 300,160')], 'arrowright')
g('←', 470, [s('470,330 0,330', '', 'T'), s('170,500 0,330,20 170,160')], 'arrowleft')
g('<', 300, [s('300,560 0,330,20 300,100')], 'less')
g('>', 300, [s('0,560 300,330,20 0,100')], 'greater')
g('#', 480, [s('150,0 190,700'), s('330,0 370,700'), s('0,230 480,230'), s('0,470 480,470')], 'numbersign')
g('&', 520, [s('520,0 120,470,90 120,700,110 380,700,110 380,470,90 0,230,90 0,0,160 300,0,160 520,300')], 'ampersand')
g('*', 280, [s('140,420 140,700'), s('0,490 280,630'), s('280,490 0,630')], 'asterisk')
g('Ø', 520, O(520, 700, 190) + [s('-10,-50 530,750')], 'Oslash')
g('ø', 420, O(420, 490, 150) + [s('-10,-40 430,530')], 'oslash')
g('Å', 540, [s('0,0 270,640,40 540,0'), s('102,240 438,240', 'T', 'T'), s('200,760,70 340,760,70 340,900,70 200,900,70', closed=True)], 'Aring')
g('å', 420, [s('420,0 420,490'), s('420,490 0,490,150 0,0,150 420,0', 'T', 'T'), s('140,590,70 280,590,70 280,730,70 140,730,70', closed=True)], 'aring')

SPACE = 250
TIGHT = {  # side-bearing trims (left, right) for open and diagonal shapes
    'A': (-26, -26), 'V': (-26, -26), 'W': (-22, -22), 'Y': (-26, -26), 'T': (-22, -22), 'L': (0, -22),
    'v.lc': (-22, -22), 'w.lc': (-20, -20), 'y.lc': (0, 0), 'r.lc': (0, -26), 'f.lc': (-10, -22), 't.lc': (-10, -14),
    'seven': (0, -10), 'J': (-14, 0), 'slash': (-20, -20), 'period': (0, 0),
}
KERN = [('A', 'VWYT', -46), ('VWYT', 'A', -46), ('L', 'TVWY', -52), ('F', 'A', -40), ('P', 'A', -34),
        ('T', 'acdegoqs', -44), ('VY', 'acdegoqs', -30), ('r', 'acdegoq', -14), ('K', 'O', -14)]


def nm(ch):
    return U[ord(ch)]


def fillet_path(P, closed, w, yscale, a, b, trimT, trimE):
    """Skia path through P with rounded corners; ends pulled back for joints."""
    pts = [(x, w / 2 + y * yscale, r) for x, y, r in P]

    def pull(p, q, d):
        dx, dy = q[0] - p[0], q[1] - p[1]
        L = math.hypot(dx, dy) or 1
        d = min(d, L * 0.6)
        return (p[0] + dx / L * d, p[1] + dy / L * d, p[2])
    if not closed:
        if a:
            pts[0] = pull(pts[0], pts[1], trimT if a == 'T' else trimE)
        if b:
            pts[-1] = pull(pts[-1], pts[-2], trimT if b == 'T' else trimE)
    n = len(pts)
    path = pathops.Path()
    idx = range(n) if closed else range(1, n - 1)
    corners = {}
    for i in idx:
        A, B, C = pts[(i - 1) % n], pts[i], pts[(i + 1) % n]
        r = B[2]
        u1 = (B[0] - A[0], B[1] - A[1]); l1 = math.hypot(*u1) or 1; u1 = (u1[0] / l1, u1[1] / l1)
        u2 = (C[0] - B[0], C[1] - B[1]); l2 = math.hypot(*u2) or 1; u2 = (u2[0] / l2, u2[1] / l2)
        cosang = max(-1, min(1, u1[0] * u2[0] + u1[1] * u2[1]))
        turn = math.acos(cosang)  # 0 = straight on
        if r <= 0 or turn < 1e-3:
            corners[i] = None
            continue
        t = r * math.tan(turn / 2)
        # interior segments are shared by two corners; end segments are not
        lim1 = l1 * (0.5 if (closed or i - 1 > 0) else 1.0)
        lim2 = l2 * (0.5 if (closed or i + 1 < n - 1) else 1.0)
        t2 = min(t, lim1, lim2)
        rr = t2 / math.tan(turn / 2)
        k = 4 / 3 * math.tan(turn / 4) * rr
        T1 = (B[0] - u1[0] * t2, B[1] - u1[1] * t2)
        T2 = (B[0] + u2[0] * t2, B[1] + u2[1] * t2)
        corners[i] = (T1, (T1[0] + u1[0] * k, T1[1] + u1[1] * k), (T2[0] - u2[0] * k, T2[1] - u2[1] * k), T2)
    if closed:
        c0 = corners[0]
        start = c0[3] if c0 else pts[0][:2]
        path.moveTo(*start)
        for i in list(range(1, n)) + [0]:
            c = corners[i]
            if c:
                path.lineTo(*c[0]); path.cubicTo(*c[1], *c[2], *c[3])
            else:
                path.lineTo(*pts[i][:2])
        path.close()
    else:
        path.moveTo(*pts[0][:2])
        for i in range(1, n - 1):
            c = corners[i]
            if c:
                path.lineTo(*c[0]); path.cubicTo(*c[1], *c[2], *c[3])
            else:
                path.lineTo(*pts[i][:2])
        path.lineTo(*pts[-1][:2])
    return path


def outline(tubes, w, gap, x0):
    """Outlined, unioned glyph as a pathops.Path. gap None = welded (Sign)."""
    yscale = (CAP - w) / CAP
    parts = []
    for (P, a, b, closed) in tubes:
        if gap is None:
            p = fillet_path(P, closed, w, yscale, '', '', 0, 0)
        else:
            p = fillet_path(P, closed, w, yscale, a, b, w + gap, w / 2 + gap / 2)
        p.stroke(w, pathops.LineCap.ROUND_CAP, pathops.LineJoin.ROUND_JOIN, 4)
        p.convertConicsToQuads()
        parts.append(p)
    out = pathops.Path()
    pen = out.getPen()
    pathops.union(parts, pen)
    out.simplify(fix_winding=True, clockwise=False)
    out.convertConicsToQuads()
    sh = pathops.Path()
    spen = sh.getPen()
    from fontTools.pens.transformPen import TransformPen
    out.draw(TransformPen(spen, (1, 0, 0, 1, x0, 0)))
    return sh


def build(style, w, gap, sb, weight_class, fname):
    family = 'Troffer ' + style
    order = ['.notdef', 'space'] + list(G.keys())
    cmap = {32: 'space', 0xA0: 'space', **U}
    for c in range(ord('a'), ord('z') + 1):
        cmap[c] = chr(c) + '.lc'
    charstrings, metrics, svg = {}, {}, {}
    pen = T2CharStringPen(600, None)
    pen.moveTo((60, 0)); pen.lineTo((540, 0)); pen.lineTo((540, CAP)); pen.lineTo((60, CAP)); pen.closePath()
    charstrings['.notdef'] = pen.getCharString(); metrics['.notdef'] = (600, 60)
    charstrings['space'] = T2CharStringPen(SPACE, None).getCharString(); metrics['space'] = (SPACE, 0)
    for name, (gw, tubes) in G.items():
        tl, tr = TIGHT.get(name, (0, 0))
        lsb = sb + tl
        adv = round(lsb + w + gw + sb + tr)
        if name in ('zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'):
            adv = round(2 * sb + w + 480); lsb = sb
        path = outline(tubes, w, gap, lsb + w / 2)
        pen = T2CharStringPen(adv, None)
        path.draw(pen)
        charstrings[name] = pen.getCharString()
        metrics[name] = (adv, round(lsb))
        sp = SVGPathPen(None); path.draw(sp); svg[name] = (sp.getCommands(), adv)
    fb = FontBuilder(1000, isTTF=False)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap(cmap)
    ps = 'Troffer' + style + ('-Bold' if weight_class >= 700 else '-Regular')
    fb.setupCFF(ps, {'FullName': family, 'FamilyName': family, 'Weight': 'Bold' if weight_class >= 700 else 'Regular'}, charstrings, {})
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=940, descent=-260)
    fb.setupNameTable({'familyName': family, 'styleName': 'Bold' if weight_class >= 700 else 'Regular',
                       'psName': ps, 'copyright': 'Copyright 2026 Louis Nordbø. SIL Open Font License 1.1.',
                       'licenseDescription': 'SIL Open Font License, Version 1.1', 'licenseInfoURL': 'https://openfontlicense.org',
                       'designer': 'Louis Nordbø', 'version': 'Version 1.000'})
    fb.setupOS2(sTypoAscender=940, sTypoDescender=-260, sTypoLineGap=0, usWinAscent=960, usWinDescent=280,
                sxHeight=X, sCapHeight=CAP, usWeightClass=weight_class, achVendID='LVL0')
    fb.setupPost()
    lines = []
    for L, Rr, v in KERN:
        ln = ' '.join(nm(c) for c in L); rn = ' '.join(nm(c) for c in Rr)
        lines.append(f'    pos [{ln}] [{rn}] {v};')
    fb.addOpenTypeFeatures('languagesystem DFLT dflt;\nlanguagesystem latn dflt;\nfeature kern {\n' + '\n'.join(lines) + '\n} kern;\n')
    os.makedirs(OUT, exist_ok=True)
    fb.font.flavor = 'woff2'
    path = os.path.join(OUT, fname)
    fb.font.save(path)
    print(f'{family:14s} w={w:<4} {os.path.getsize(path):6d} bytes  {path}')
    return svg, cmap


def specimen(sets):
    """One SVG sheet with every cut, for eyeballing."""
    rows = ['LEVEL 0', 'ABCDEFGHIJKLM', 'NOPQRSTUVWXYZ', 'abcdefghijklm', 'nopqrstuvwxyz', '0123456789 @%&#',
            'Sector 4F-19 / 312 m', 'You are not supposed', 'to be here. (Yet?)', 'AVATAR TYPE LAYOUT']
    out, y = [], 0
    scale = 0.085
    for label, (svg, cmap) in sets:
        for row in rows:
            y += 1000 * scale * 1.12
            x = 30
            for ch in row:
                name = cmap.get(ord(ch))
                if name == 'space' or name is None:
                    x += SPACE * scale; continue
                d, adv = svg[name]
                out.append(f'<path transform="translate({x:.1f},{y:.1f}) scale({scale},-{scale})" d="{d}"/>')
                x += adv * scale
        y += 30
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="{y + 40:.0f}" viewBox="0 0 1400 {y + 40:.0f}"><rect width="100%" height="100%" fill="#0c0b07"/><g fill="#f3ecd0">{"".join(out)}</g></svg>'


if __name__ == '__main__':
    sets = [
        ('Tube', build('Tube', 104, 40, 62, 400, 'troffer-tube.woff2')),
        ('Sign', build('Sign', 78, None, 50, 400, 'troffer-sign.woff2')),
        ('Sign Bold', build('Sign', 116, None, 44, 700, 'troffer-sign-bold.woff2')),
    ]
    with open(os.path.join(HERE, 'specimen.svg'), 'w') as f:
        f.write(specimen(sets))
    print('specimen:', os.path.join(HERE, 'specimen.svg'))
