# Find the back-to-front layer order whose composite best matches the full 3D render.
# Greedy: move one layer to another slot while that clearly lowers the count of differing pixels.
# "Over" is associative, so for each layer the stacks below and above every slot are built once.
import json
import sys
import numpy as np
from PIL import Image

out = sys.argv[1]
R = 512
bake = json.load(open(f'{out}/bake.json', encoding='utf8'))
names = [l['name'] for l in bake['layers']]
def load(path):
    im = Image.open(path).convert('RGBA').resize((R, R), Image.LANCZOS)
    a = np.asarray(im, dtype=np.float32) / 255
    return a[..., :3] * a[..., 3:4], a[..., 3:4]  # premultiplied colour, alpha
layers = {l['name']: load(f"{out}/{l['image']}") for l in bake['layers']}
bg = np.array([40, 40, 46], np.float32) / 255
fc, fa = load(f'{out}/full.png')
target = fc + bg * (1 - fa)
TH = 24 / 255

def over(top, bottom):  # premultiplied (c, a) pairs
    tc, ta = top
    bc, ba = bottom
    return tc + bc * (1 - ta), ta + ba * (1 - ta)

def err(c):
    return int((np.abs(c - target).max(axis=2) > TH).sum())

def score(order):
    c = np.broadcast_to(bg, (R, R, 3)).copy()
    for n in order:
        lc, la = layers[n]
        c = lc + c * (1 - la)
    return err(c)

def best_slot(order, n):
    rest = [x for x in order if x != n]
    k = len(rest)
    below = [np.broadcast_to(bg, (R, R, 3)).copy()]
    for x in rest:
        lc, la = layers[x]
        below.append(lc + below[-1] * (1 - la))
    above = [None] * (k + 1)
    above[k] = (np.zeros((R, R, 3), np.float32), np.zeros((R, R, 1), np.float32))
    for j in range(k - 1, -1, -1):
        above[j] = over(above[j + 1], layers[rest[j]])
    lc, la = layers[n]
    scores = []
    for j in range(k + 1):
        c = lc + below[j] * (1 - la)
        ac, aa = above[j]
        scores.append(err(ac + c * (1 - aa)))
    return rest, scores

order = names[:]
best = score(order)
print('start', best, flush=True)
for rnd in range(4):
    moved = False
    for n in names:
        rest, scores = best_slot(order, n)
        j = int(np.argmin(scores))
        if scores[j] < best - 25 and rest[:j] + [n] + rest[j:] != order:
            print(f'move {n} -> slot {j}: {best} -> {scores[j]}', flush=True)
            order = rest[:j] + [n] + rest[j:]
            best = scores[j]
            moved = True
    if not moved:
        break
print('final', best)
print(' | '.join(order))
json.dump(order, open(f'{out}/order.json', 'w', encoding='utf8'), ensure_ascii=False)
