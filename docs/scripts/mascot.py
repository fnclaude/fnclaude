# Regenerates the pixel grid behind the SVG in src/components/Mascot.astro.
BODY_W, BODY_H = 10, 5
LEAN   = 1                      # px shift per row, bottom -> top
LEG_H  = 2
LEGS   = (1, 3, 6, 8)           # x offsets within the bottom row
EYES   = (3, 7)                 # x offsets within the eye row
EYE_ROW, EYE_H = 1, 2           # row index within body, height

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

for row in g:
    print(''.join({'o':'██','k':'▒▒','.':'  '}[c] for c in row))
print()
print('\n'.join(''.join(r) for r in g))
print(f'\n{W}x{H}')
