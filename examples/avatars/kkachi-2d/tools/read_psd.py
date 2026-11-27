# Minimal PSD layer reader (RGB, raw or PackBits) to verify make_psd.py output independently.
import struct
import sys

import numpy as np


def unpack(b, n):
    out = bytearray()
    i = 0
    while len(out) < n:
        h = b[i]
        i += 1
        if h < 128:
            out += b[i:i + h + 1]
            i += h + 1
        elif h > 128:
            out += bytes([b[i]]) * (257 - h)
            i += 1
    return bytes(out[:n])


def read(path):
    d = open(path, 'rb').read()
    assert d[:4] == b'8BPS'
    ch, h, w, depth, mode = struct.unpack('>HIIHH', d[12:26])
    p = 26
    p += 4 + struct.unpack('>I', d[p:p + 4])[0]  # colour mode
    p += 4 + struct.unpack('>I', d[p:p + 4])[0]  # resources
    lm_len = struct.unpack('>I', d[p:p + 4])[0]
    p += 4
    li_len = struct.unpack('>I', d[p:p + 4])[0]
    p += 4
    count = abs(struct.unpack('>h', d[p:p + 2])[0])
    p += 2
    recs = []
    for _ in range(count):
        top, left, bottom, right = struct.unpack('>iiii', d[p:p + 16]); p += 16
        nch = struct.unpack('>H', d[p:p + 2])[0]; p += 2
        chans = [struct.unpack('>hI', d[p + 6 * k:p + 6 * k + 6]) for k in range(nch)]; p += 6 * nch
        assert d[p:p + 4] == b'8BIM'; p += 12
        extra = struct.unpack('>I', d[p:p + 4])[0]; p += 4
        e = p
        e += 4 + struct.unpack('>I', d[e:e + 4])[0]
        e += 4 + struct.unpack('>I', d[e:e + 4])[0]
        name = d[e + 1:e + 1 + d[e]].decode('latin1')
        p += extra
        recs.append((name, top, left, bottom, right, chans))
    layers = []
    for name, top, left, bottom, right, chans in recs:
        lh, lw = bottom - top, right - left
        planes = {}
        for cid, length in chans:
            blob = d[p:p + length]; p += length
            comp = struct.unpack('>H', blob[:2])[0]
            if comp == 0:
                data = blob[2:2 + lh * lw]
            else:
                counts = struct.unpack(f'>{lh}H', blob[2:2 + 2 * lh])
                q = 2 + 2 * lh
                rows = []
                for c in counts:
                    rows.append(unpack(blob[q:q + c], lw)); q += c
                data = b''.join(rows)
            planes[cid] = np.frombuffer(data, np.uint8).reshape(lh, lw)
        rgba = np.stack([planes[0], planes[1], planes[2], planes[-1]], axis=-1)
        layers.append((name, (left, top, right, bottom), rgba))
    return (w, h), layers


if __name__ == '__main__':
    size, layers = read(sys.argv[1])
    print(size, len(layers), [n for n, _, _ in layers][:5])
