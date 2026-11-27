# Write the baked layers as a layered PSD that Live2D Cubism Editor can import:
# 8-bit RGB, one pixel layer per part (straight alpha, cropped to its pixels), unique names,
# bottom layer first, PackBits (RLE) compression, plus a merged RGBA image.
# Usage: python make_psd.py <out dir> <order.json> <target.psd>
import json
import struct
import sys

import numpy as np
from PIL import Image

out_dir, order_file, target = sys.argv[1:4]
bake = json.load(open(f'{out_dir}/bake.json', encoding='utf8'))
order = json.load(open(order_file, encoding='utf8'))
S = bake['size']
by_name = {l['name']: l for l in bake['layers']}


def psd_name(name):
    # "Eye:: Left:: White" -> "Eye Left White"
    return ' '.join(p.strip() for p in name.split('::'))


def packbits(row):
    """PackBits-encode one row (1-D uint8 array)."""
    n = len(row)
    out = bytearray()
    lit = bytearray()

    def flush():
        nonlocal lit
        for i in range(0, len(lit), 128):
            chunk = lit[i:i + 128]
            out.append(len(chunk) - 1)
            out.extend(chunk)
        lit = bytearray()

    change = np.flatnonzero(np.diff(row)) + 1
    starts = np.concatenate(([0], change))
    ends = np.concatenate((change, [n]))
    for s, e in zip(starts.tolist(), ends.tolist()):
        length, v = e - s, int(row[s])
        if length < 3:
            lit.extend(bytes([v]) * length)
            continue
        flush()
        while length >= 2:
            k = min(length, 128)
            out.append((257 - k) & 0xFF)
            out.append(v)
            length -= k
        if length == 1:
            lit.append(v)
    flush()
    return bytes(out)


def rle_planes(planes, even=False):
    """planes: list of 2-D uint8 arrays -> (bytecounts, data) for all rows of all planes.
    even: pad to an even length with a PackBits no-op (0x80) on the last row; some readers
    (Pillow) skip a byte after odd-length channel data, Photoshop and Cubism ignore the no-op."""
    counts, data = [], bytearray()
    for p in planes:
        for row in p:
            enc = packbits(row)
            counts.append(len(enc))
            data.extend(enc)
    if even and len(data) % 2:
        data.append(0x80)
        counts[-1] += 1
    return counts, bytes(data)


def pascal(name, pad):
    b = name.encode('ascii', 'replace')[:255]
    s = bytes([len(b)]) + b
    while len(s) % pad:
        s += b'\0'
    return s


records, channel_data = bytearray(), bytearray()
merged = Image.new('RGBA', (S, S), (0, 0, 0, 0))
names_seen = set()
for name in order:
    layer = by_name[name]
    im = Image.open(f"{out_dir}/{layer.get('imageFull', layer['image'])}").convert('RGBA')
    merged.alpha_composite(Image.open(f"{out_dir}/{layer['image']}").convert('RGBA'))
    box = im.getchannel('A').getbbox()
    if not box:
        continue
    left, top, right, bottom = box
    a = np.asarray(im.crop(box))
    # Channel ids tell readers which plane is which; R, G, B, then alpha (-1) also suits readers
    # that take the planes in that order (Pillow).
    planes = {0: a[..., 0], 1: a[..., 1], 2: a[..., 2], -1: a[..., 3]}
    label = psd_name(name)
    assert label not in names_seen, label
    names_seen.add(label)
    chan_info = bytearray()
    for cid, plane in planes.items():
        counts, data = rle_planes([plane], even=True)
        blob = struct.pack('>H', 1) + struct.pack(f'>{len(counts)}H', *counts) + data
        chan_info += struct.pack('>hI', cid, len(blob))
        channel_data.extend(blob)
    uni = label.encode('utf-16-be')
    luni = struct.pack('>I', len(label)) + uni
    if len(luni) % 2:
        luni += b'\0'
    extra = struct.pack('>II', 0, 0) + pascal(label, 4) + b'8BIMluni' + struct.pack('>I', len(luni)) + luni
    records += struct.pack('>iiii', top, left, bottom, right) + struct.pack('>H', 4) + chan_info
    records += b'8BIMnorm' + bytes([255, 0, 0, 0]) + struct.pack('>I', len(extra)) + extra

count = len(names_seen)
layer_info = struct.pack('>h', count) + records + channel_data
if len(layer_info) % 2:
    layer_info += b'\0'
layer_info = struct.pack('>I', len(layer_info)) + layer_info
layer_and_mask = layer_info + struct.pack('>I', 0)

m = np.asarray(merged)
counts, data = rle_planes([m[..., 0], m[..., 1], m[..., 2], m[..., 3]])
image_data = struct.pack('>H', 1) + struct.pack(f'>{len(counts)}H', *counts) + data

with open(target, 'wb') as f:
    f.write(b'8BPS' + struct.pack('>H', 1) + b'\0' * 6 + struct.pack('>HIIHH', 4, S, S, 8, 3))
    f.write(struct.pack('>I', 0))  # colour mode data
    f.write(struct.pack('>I', 0))  # image resources
    f.write(struct.pack('>I', len(layer_and_mask)) + layer_and_mask)
    f.write(image_data)
print(f'wrote {target}: {count} layers, {S}x{S}')
