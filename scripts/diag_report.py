#!/usr/bin/env python3
"""
Read a diagnostic capture and answer the questions it was recorded for.

Usage:
    python scripts/diag_report.py mc-webui-diag-20260808T120000Z.zip
    python scripts/diag_report.py <dir>            # an already-unpacked capture
    python scripts/diag_report.py <zip> --frames   # add a per-frame listing

The capture comes from Settings > Diagnostics in mc-webui; see
docs/troubleshooting.md. Nothing here talks to a device or a database — a
capture is self-contained on purpose, so it can be analysed by someone who has
no access to the machine that produced it.

The headline number is the frame-loss test. The device counts every packet its
radio receives; the app only ever sees the RX-log frames the firmware manages
to push over the companion link, and the firmware's 4-frame queue drops the
rest without a word. If the counter climbed by much more than the frames we
logged, the loss is real and measured, not inferred.
"""

import argparse
import json
import sys
import zipfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8')
    except (AttributeError, OSError):
        pass


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------

class Capture:
    def __init__(self, meta, events, stats_before, stats_after, log_lines):
        self.meta = meta or {}
        self.events = events
        self.stats_before = stats_before or {}
        self.stats_after = stats_after or {}
        self.log_lines = log_lines

    @property
    def rx_frames(self):
        return [e for e in self.events if e.get('k') == 'rx_log']

    @property
    def echoes(self):
        return [e for e in self.events if e.get('k') == 'echo']

    @property
    def sends(self):
        return [e for e in self.events if e.get('k') == 'send']

    @property
    def stats_samples(self):
        return [e for e in self.events if e.get('k') == 'stats']


def _read_members(read_text):
    """Build a Capture from a callable mapping a member name to its text."""
    meta = json.loads(read_text('meta.json') or '{}')
    events = []
    for lineno, line in enumerate((read_text('events.jsonl') or '').splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            # A capture killed mid-write can end in half a line; everything
            # before it is still good, so report and keep going.
            print(f'warning: events.jsonl:{lineno} is not valid JSON — skipped',
                  file=sys.stderr)
    stats_before = json.loads(read_text('stats_before.json') or 'null')
    stats_after = json.loads(read_text('stats_after.json') or 'null')
    log_lines = (read_text('log.txt') or '').splitlines()
    return Capture(meta, events, stats_before, stats_after, log_lines)


def load(path: Path) -> Capture:
    if path.is_dir():
        def read_text(name):
            f = path / name
            return f.read_text(encoding='utf-8', errors='replace') if f.is_file() else None
        return _read_members(read_text)

    with zipfile.ZipFile(path) as zf:
        # Captures zip with a single top-level directory; tolerate flat ones too.
        names = {Path(n).name: n for n in zf.namelist() if not n.endswith('/')}

        def read_text(name):
            member = names.get(name)
            if member is None:
                return None
            return zf.read(member).decode('utf-8', errors='replace')
        return _read_members(read_text)


# ---------------------------------------------------------------------------
# Formatting
# ---------------------------------------------------------------------------

def ts(epoch):
    if not epoch:
        return '—'
    return datetime.fromtimestamp(epoch, timezone.utc).strftime('%H:%M:%S')


def duration(sec):
    if sec is None:
        return '—'
    sec = int(sec)
    if sec < 60:
        return f'{sec}s'
    return f'{sec // 60}m {sec % 60}s'


def head(title):
    print(f'\n{title}')
    print('─' * len(title))


def pct(part, whole):
    return f'{100.0 * part / whole:.1f}%' if whole else '—'


# ---------------------------------------------------------------------------
# Sections
# ---------------------------------------------------------------------------

def report_header(cap: Capture):
    m = cap.meta
    app = m.get('app', {})
    dev = m.get('device', {})
    counters = m.get('counters', {})

    head('Capture')
    print(f'  id            {m.get("capture_id", "?")}')
    if m.get('note'):
        print(f'  note          {m["note"]}')
    print(f'  app           {app.get("release", "?")} (build {app.get("build", "?")})')
    print(f'  transport     {m.get("transport", "?")}')
    print(f'  device        {dev.get("name", "?")}  fw_ver_code={dev.get("fw_ver_code")}  '
          f'connected={dev.get("connected")}')
    print(f'  window        {ts(m.get("started_at"))} → {ts(m.get("stopped_at"))} UTC '
          f'({duration(m.get("duration_sec"))}, stopped: {m.get("stop_reason", "?")})')
    print(f'  events        {counters.get("events", 0)} '
          f'({", ".join(f"{k}={v}" for k, v in sorted((counters.get("by_kind") or {}).items())) or "none"})')
    print(f'  log lines     {counters.get("log_lines", 0)}')
    if counters.get('dropped'):
        print(f'  DROPPED       {counters["dropped"]} events — the queue overflowed, '
              f'counts below are lower bounds')

    if m.get('transport') == 'ble':
        print('\n  NOTE: BLE drains the firmware\'s RX-log queue at one frame per 60 ms.')
        print('        This is the transport most likely to lose frames in a burst.')


def report_frame_loss(cap: Capture):
    """The measurement the whole tool exists for."""
    head('Frame loss (device counter vs. frames the app received)')

    before = (cap.stats_before or {}).get('packets') or {}
    after = (cap.stats_after or {}).get('packets') or {}
    t0 = cap.meta.get('stats_before_at')
    t1 = cap.meta.get('stats_after_at')

    if not before or not after:
        print('  Device stats missing from one or both endpoints — the device was')
        print('  probably disconnected. Frame loss cannot be measured from this capture.')
        return

    recv0, recv1 = before.get('recv'), after.get('recv')
    if recv0 is None or recv1 is None:
        print('  The device reported no "recv" counter — nothing to compare against.')
        return

    device_delta = recv1 - recv0
    if device_delta < 0:
        print(f'  The device counter went backwards ({recv0} → {recv1}) — the node')
        print('  rebooted mid-capture. Frame loss cannot be measured across a reboot.')
        return

    # Count only frames inside the window the two stats samples bracket, so the
    # two numbers describe the same slice of time.
    frames = [e for e in cap.rx_frames
              if (t0 is None or e['t'] >= t0) and (t1 is None or e['t'] <= t1)]
    app_frames = len(frames)
    missing = device_delta - app_frames

    window = (t1 - t0) if (t0 and t1) else None
    print(f'  Window            {ts(t0)} → {ts(t1)} UTC ({duration(window)})')
    print(f'  Device received   {device_delta} packets   (stats.packets.recv {recv0} → {recv1})')
    print(f'  App logged        {app_frames} RX-log frames')

    if missing <= 0:
        print(f'  Difference        {missing} — no loss detected.')
        print('\n  Every packet the radio counted also reached the app. If badges are')
        print('  still missing, the cause is elsewhere: check the echo section below.')
    else:
        print(f'  Difference        {missing} frames never reached the app '
              f'({pct(missing, device_delta)} of what the radio heard)')
        print('\n  Frames are being dropped on the companion link. The firmware queues')
        print('  four and discards the rest silently (writeFrame in SerialWifiInterface /')
        print('  SerialBLEInterface). Nothing the app does can recover them.')

    # Per-interval detail. A capture long enough to have samples shows *when*
    # the loss happened, which is usually right after a send.
    samples = [(e['t'], ((e.get('stats') or {}).get('packets') or {}).get('recv'))
               for e in cap.stats_samples]
    samples = [(t, r) for t, r in samples if r is not None]
    points = [(t0, recv0)] + samples + [(t1, recv1)]
    if len(points) > 2:
        print('\n  Per interval:')
        print(f'    {"time":>10}  {"device":>7}  {"app":>5}  {"lost":>5}')
        for (ta, ra), (tb, rb) in zip(points, points[1:]):
            if ta is None or tb is None:
                continue
            dev_n = rb - ra
            app_n = sum(1 for e in cap.rx_frames if ta < e['t'] <= tb)
            lost = dev_n - app_n
            flag = '  <-- loss' if lost > 0 else ''
            print(f'    {ts(tb):>10}  {dev_n:>7}  {app_n:>5}  {lost:>5}{flag}')


def report_frame_bursts(cap: Capture):
    head('RX-log frame arrival')
    frames = cap.rx_frames
    if not frames:
        print('  No frames captured.')
        return

    gaps = [round(b['t'] - a['t'], 3) for a, b in zip(frames, frames[1:])]
    gaps_sorted = sorted(gaps)

    def q(p):
        if not gaps_sorted:
            return 0.0
        return gaps_sorted[min(len(gaps_sorted) - 1, int(p * len(gaps_sorted)))]

    span = frames[-1]['t'] - frames[0]['t']
    if span > 0:
        print(f'  Frames            {len(frames)} over {duration(span)} '
              f'({len(frames) / span:.2f}/s average)')
    else:
        print(f'  Frames            {len(frames)}')
    if gaps:
        print(f'  Gap between       min {min(gaps):.3f}s  median {q(0.5):.3f}s  max {max(gaps):.3f}s')
        # Bursts are what overflow a 4-frame queue; a run of sub-100 ms gaps is
        # the shape to look for.
        burst = sum(1 for g in gaps if g < 0.1)
        print(f'  Gaps under 100ms  {burst} ({pct(burst, len(gaps))}) — bursts are what '
              f'overrun the firmware queue')

    sizes = [len(e.get('hex', '')) // 2 for e in frames]
    if sizes:
        over = sum(1 for s in sizes if s > 173)
        print(f'  Frame size        min {min(sizes)}B  median {sorted(sizes)[len(sizes) // 2]}B  '
              f'max {max(sizes)}B')
        if over:
            print(f'  Over 173 B        {over} — note MeshCore #3022: packets above that '
                  f'are never RX-logged at all')

    snrs = [e['snr'] for e in frames if e.get('snr') is not None]
    if snrs:
        print(f'  SNR               min {min(snrs)}  median {sorted(snrs)[len(snrs) // 2]}  '
              f'max {max(snrs)}')


def report_sends(cap: Capture, verbose=False):
    """Per-sent-message outcome — the user-visible symptom, explained."""
    head('Sent messages and their echoes')
    sends = cap.sends
    if not sends:
        print('  No messages were sent while recording.')
        print('  A capture that is meant to explain a missing repeater badge has to')
        print('  contain the send itself — record again and send during the recording.')
        return

    echoes = cap.echoes
    for s in sends:
        msg_id = s.get('msg_id')
        expected = set(s.get('expected') or [])
        matched = [e for e in echoes if e.get('msg_id') == msg_id]
        # An echo whose payload we predicted but which the matcher filed as
        # foreign traffic: an app-side correlation failure, not radio loss.
        near_miss = [e for e in echoes
                     if e.get('msg_id') != msg_id and e.get('pkt') in expected]

        text = (s.get('text') or '').replace('\n', ' ')
        if len(text) > 60:
            text = text[:57] + '…'
        print(f'\n  #{msg_id} at {ts(s.get("t"))} on channel {s.get("channel_idx")}: "{text}"')
        if s.get('scope'):
            print(f'    region scope   {s["scope"]}')
        if not s.get('has_secret'):
            print('    NO CHANNEL SECRET — expected payloads could not be computed, so')
            print('    correlation fell back to the channel-hash rule (60 s, approximate).')

        if matched:
            stages = Counter(e.get('match') or 'repeat' for e in matched)
            print(f'    echoes heard   {len(matched)} '
                  f'({", ".join(f"{k}×{v}" for k, v in sorted(stages.items()))})')
            for e in matched:
                delay = e['t'] - s['t']
                print(f'      +{delay:6.2f}s  path={e.get("path") or "(direct)"}  '
                      f'snr={e.get("snr")}  hash_size={e.get("hash_size")}')
        elif near_miss:
            print(f'    NOT CORRELATED — {len(near_miss)} echo(es) carried a payload this')
            print('    send predicted, but the matcher did not attribute them. This is an')
            print('    app-side correlation bug; the pending list at the time was:')
            for e in near_miss[:3]:
                print(f'      +{e["t"] - s["t"]:6.2f}s  pending={e.get("pending")}')
        else:
            print('    NO ECHO — nothing in earshot repeated this packet, or the frame')
            print('    carrying the repeat was dropped on the companion link. Read the')
            print('    frame-loss section above to tell those two apart.')

        if verbose and s.get('guess'):
            print(f'    guess payload  {s["guess"][:32]}…')
            print(f'    raw_packet     {(s.get("raw_packet") or "—")[:32]}…')


def report_echo_summary(cap: Capture):
    head('Echo correlation summary')
    echoes = cap.echoes
    if not echoes:
        print('  No GRP_TXT echoes were seen at all.')
        return
    by_dir = Counter(e.get('direction') for e in echoes)
    by_stage = Counter(e.get('match') for e in echoes if e.get('match'))
    print(f'  Echoes seen       {len(echoes)} '
          f'(sent {by_dir.get("sent", 0)}, incoming {by_dir.get("incoming", 0)})')
    if by_stage:
        print('  Matched by rule   ' + ', '.join(f'{k}={v}' for k, v in sorted(by_stage.items())))
    orphan = sum(1 for e in echoes
                 if e.get('direction') == 'incoming' and e.get('pending'))
    if orphan:
        print(f'  Unmatched while a send was pending: {orphan} — expected for other')
        print('  people\'s traffic, suspicious if it lines up with your own sends.')


def report_frames(cap: Capture):
    head('Frames')
    for e in cap.rx_frames:
        print(f'  {ts(e["t"])}  snr={str(e.get("snr")):>6}  rssi={str(e.get("rssi")):>6}  '
              f'{len(e.get("hex", "")) // 2:>3}B  {e.get("hex", "")[:48]}')


def report_errors(cap: Capture):
    errors = [ln for ln in cap.log_lines if ' ERROR ' in ln or ' WARNING ' in ln]
    if not errors:
        return
    head(f'Warnings and errors in the log ({len(errors)})')
    for line in errors[:40]:
        print(f'  {line}')
    if len(errors) > 40:
        print(f'  … {len(errors) - 40} more in log.txt')


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('capture', type=Path, help='capture .zip or unpacked directory')
    ap.add_argument('--frames', action='store_true', help='list every RX-log frame')
    ap.add_argument('--verbose', action='store_true', help='show payload details per send')
    args = ap.parse_args()

    if not args.capture.exists():
        print(f'No such capture: {args.capture}', file=sys.stderr)
        return 1

    cap = load(args.capture)
    if cap.meta.get('schema') not in (None, 1):
        print(f'warning: capture schema {cap.meta["schema"]} is newer than this script',
              file=sys.stderr)

    report_header(cap)
    report_frame_loss(cap)
    report_frame_bursts(cap)
    report_sends(cap, verbose=args.verbose)
    report_echo_summary(cap)
    report_errors(cap)
    if args.frames:
        report_frames(cap)
    print()
    return 0


if __name__ == '__main__':
    sys.exit(main())
