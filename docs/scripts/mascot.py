# Regenerates the pixel grid and <rect> list behind the SVG in
# src/components/Mascot.astro (and public/favicon.svg).
BODY_W, BODY_H = 10, 7
LEAN   = 1                      # px shift per row, bottom -> top
LEG_H  = 2
LEGS   = (2, 7)                 # x offsets within the bottom row
EYES   = (3, 7)                 # x offsets within the eye row
EYE_ROW, EYE_H = 1, 2           # row index within body, height
MOUTH  = {4: (4, 5, 6, 7),      # half-disc smile: flat top row ...
          5: (6, 7)}            # ... rounded bottom row; row -> x offsets

W = BODY_W + LEAN * (BODY_H - 1)
H = BODY_H + LEG_H
g = [['.'] * W for _ in range(H)]

def row_x0(i):                  # left edge of body row i (0 = top)
    return LEAN * (BODY_H - 1 - i)

for i in range(BODY_H):
    for x in range(row_x0(i), row_x0(i) + BODY_W):
        g[i][x] = 'o'

for off in LEGS:                # legs hang off the bottom row
    x = row_x0(BODY_H - 1) + off
    for y in range(BODY_H, BODY_H + LEG_H):
        g[y][x] = 'o'

for off in EYES:                # upright slots, placed on the eye row
    x = row_x0(EYE_ROW) + off
    for y in range(EYE_ROW, EYE_ROW + EYE_H):
        g[y][x] = 'k'

for row, offs in MOUTH.items(): # the smile is background showing through
    for off in offs:
        g[row][row_x0(row) + off] = 'k'

for row in g:
    print(''.join({'o':'██','k':'▒▒','.':'  '}[c] for c in row))
print()

for y, row in enumerate(g):     # run-length merge each row into <rect>s
    x = 0
    while x < W:
        if row[x] != 'o':
            x += 1
            continue
        x0 = x
        while x < W and row[x] == 'o':
            x += 1
        print(f'<rect x="{x0}" y="{y}" width="{x - x0}" height="1" />')
print(f'\nviewBox="0 0 {W} {H}"')
