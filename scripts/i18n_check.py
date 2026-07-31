#!/usr/bin/env python3
"""
Translation catalog checker.

Run from the repo root:
    python scripts/i18n_check.py            # check everything
    python scripts/i18n_check.py --lang pl  # one language
    python scripts/i18n_check.py --missing pl > pl-todo.txt

Exits non-zero if any ERROR is reported. Warnings never fail the run.

For translators the useful output is the coverage table and --missing, which prints the
untranslated keys with their English text — that is your worklist.
"""

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

# Catalog values and the --missing worklist contain non-ASCII text. Windows consoles
# default to a legacy code page, which would mangle them and corrupt a redirected file.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8')
    except (AttributeError, OSError):
        pass

REPO = Path(__file__).resolve().parent.parent
TRANSLATIONS = REPO / 'app' / 'translations'
SCAN_GLOBS = ['app/templates/**/*.html', 'app/static/js/*.js']

# Never flag these as unused — they are read by app/i18n.py, not by a t() call.
META_KEYS = {'meta.language_name', 'meta.language_english_name', 'meta.translator',
             'meta.review_status'}

# Terms that must survive translation. Mesh operators use the English words regardless
# of UI language, and a translated "flood" matches no firmware doc or forum post.
# Canonical list — docs/translations.md points here.
# Kept deliberately tight: only jargon whose native translation would leave a mesh
# operator unable to match the UI against firmware output or a forum post. Words with a
# normal, unambiguous native equivalent — telemetry, sensor, broker, bandwidth — are
# guidance in docs/translations.md, not an automated check. They fired on correct Polish
# ("telemetria", "czujniki"), and a warning you are meant to ignore trains you to ignore
# all of them. "direct" is out for the same reason: it is a common adjective ("direct
# neighbours") far more often than the Direct mode value.
GLOSSARY = [
    'flood', 'hop', 'advert', 'ACK', 'RSSI', 'SNR', 'LoRa', 'MQTT', 'pubkey', 'repeater',
]

# t('key'), tn('key', n), tHtml('key', {...}), t_html('key', name=x).
# The lookbehind stops "format(" / ".at(" / "$t(" from matching.
CALL_RE = re.compile(r'''(?<![\w.$])(t|tn|tHtml|t_html)\s*\(\s*(['"])((?:(?!\2).)*)\2''')

# The key is often chosen inline: tHtml(p.is_primary ? 'a.b' : 'c.d'). CALL_RE cannot see
# those, because the first thing after "(" is not a quote. That produced false "unused
# key" warnings and, worse, would have hidden a typo in either branch.
TERNARY_CALL_RE = re.compile(
    r'''(?<![\w.$])(t|tn|tHtml|t_html)\s*\([^()'"]*\?\s*'''
    r'''(['"])((?:(?!\2).)*)\2\s*:\s*(['"])((?:(?!\4).)*)\4'''
)

PARAM_RE = re.compile(r'\{(\w+)\}')
SHADOW_RE = re.compile(r'(?:const|let|var)\s+t\s*=')

HTML_SINK_RE = re.compile(r'innerHTML|insertAdjacentHTML')

errors: list[str] = []
warnings: list[str] = []


def err(msg): errors.append(msg)
def warn(msg): warnings.append(msg)


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------

def load_catalog(lang: str) -> dict:
    path = TRANSLATIONS / f'{lang}.json'
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        err(f"{path.relative_to(REPO)}: not found")
        return {}
    except json.JSONDecodeError as e:
        err(f"{path.relative_to(REPO)}: invalid JSON — {e}")
        return {}


def available_langs() -> list[str]:
    return sorted(p.stem for p in TRANSLATIONS.glob('*.json'))


STRING_LITERAL_RE = re.compile(r'''(['"])((?:(?!\1)[^\\])*)\1''')


def scan_sources() -> tuple[dict[str, set[str]], dict[str, list[str]], set[str]]:
    """Return (key -> call kinds, key -> 'file:line' sites, every string literal seen)."""
    kinds: dict[str, set[str]] = defaultdict(set)
    sites: dict[str, list[str]] = defaultdict(list)
    literals: set[str] = set()

    for pattern in SCAN_GLOBS:
        for path in sorted(REPO.glob(pattern)):
            rel = path.relative_to(REPO).as_posix()
            for lineno, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
                for func, _, key in CALL_RE.findall(line):
                    kinds[key].add(func)
                    sites[key].append(f'{rel}:{lineno}')

                for func, _, key_true, _, key_false in TERNARY_CALL_RE.findall(line):
                    for key in (key_true, key_false):
                        kinds[key].add(func)
                        sites[key].append(f'{rel}:{lineno}')

                for _, literal in STRING_LITERAL_RE.findall(line):
                    literals.add(literal)

                # A t() result landing in innerHTML must be tHtml() — its params are
                # escaped, so interpolated user data cannot inject markup.
                if HTML_SINK_RE.search(line) and re.search(r'\$\{\s*t\s*\(', line):
                    err(f'{rel}:{lineno}: t() inside an HTML sink — use tHtml()')

                if SHADOW_RE.search(line):
                    err(f'{rel}:{lineno}: `t` is assigned here, shadowing the global '
                        f'translation helper — rename the variable')

    return kinds, sites, literals


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

def value_strings(value) -> list[str]:
    """All text variants of a catalog value (plural objects have several)."""
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [v for v in value.values() if isinstance(v, str)]
    return []


def placeholders(value) -> set[str]:
    out: set[str] = set()
    for text in value_strings(value):
        out |= set(PARAM_RE.findall(text))
    return out


def check_usage(en: dict, kinds: dict[str, set[str]], sites: dict[str, list[str]],
                literals: set[str]):
    for key in sorted(kinds):
        if key not in en:
            where = sites[key][0]
            err(f'{where}: key not in en.json — {key!r}')

    # Some keys are resolved dynamically — a declarative schema holding
    # labelKey: 'repeaters.settings.name' and calling t(f.labelKey) at render time.
    # A bare literal that exactly matches a catalog key counts as a reference, which
    # keeps those out of the unused list. It only relaxes this warning: missing-key
    # errors and the markup lint still come from real call sites.
    unused = set(en) - set(kinds) - META_KEYS - literals
    for key in sorted(unused):
        warn(f'en.json: unused key {key!r}')

    # Markup in a catalog value only survives through the _html variants.
    #
    # Only flagged in this direction. The reverse (_html used on a markup-free value) is
    # not a problem and must not be warned about: what _html buys at an innerHTML sink is
    # param escaping, not markup support. Warning there would push people toward t() in
    # exactly the place where t() is the XSS hazard.
    for key, value in sorted(en.items()):
        if key not in kinds:
            continue
        if any('<' in text for text in value_strings(value)) and kinds[key] & {'t', 'tn'}:
            err(f'{sites[key][0]}: {key!r} contains markup but is used via t()/tn() - '
                f'use tHtml()/t_html()')

        # A plural value only picks the right form when the count reaches the resolver,
        # and tn() is the only helper that passes it. t()/tHtml() fall back to the "one"
        # form and render it for every count - silently, and correctly-looking in English
        # where "1 hop"/"2 hops" differ only in a letter. Polish makes it obvious, but by
        # then it is in a screenshot, not in a test.
        if isinstance(value, dict) and kinds[key] - {'tn'}:
            wrong = ', '.join(sorted(f'{f}()' for f in kinds[key] - {'tn'}))
            err(f'{sites[key][0]}: {key!r} is a plural value but is used via {wrong} - '
                f'use tn(key, count)')


def check_language(lang: str, en: dict, catalog: dict) -> float:
    translated = [k for k in en if k in catalog]
    coverage = 100.0 * len(translated) / len(en) if en else 100.0

    for key in sorted(catalog):
        if key not in en:
            warn(f'{lang}.json: key not in en.json — {key!r} (renamed or removed?)')

    for key in sorted(translated):
        want, got = placeholders(en[key]), placeholders(catalog[key])
        if want != got:
            missing = ', '.join(sorted(want - got)) or '-'
            extra = ', '.join(sorted(got - want)) or '-'
            err(f'{lang}.json: {key!r} placeholder mismatch — missing: {missing}; '
                f'unexpected: {extra}')

        # Deleting a glossary term is a bug; inflecting it ("hopów") is fine, so this
        # is a substring test and only ever a warning.
        en_text = ' '.join(value_strings(en[key])).lower()
        tr_text = ' '.join(value_strings(catalog[key])).lower()
        for term in GLOSSARY:
            if re.search(rf'\b{re.escape(term.lower())}', en_text) and term.lower() not in tr_text:
                warn(f'{lang}.json: {key!r} drops the glossary term {term!r}')

    return coverage


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--lang', help='check only this language')
    parser.add_argument('--missing', metavar='LANG',
                        help='print untranslated keys for LANG and exit')
    args = parser.parse_args()

    en = load_catalog('en')
    if not en:
        print('\n'.join(errors), file=sys.stderr)
        return 1

    if args.missing:
        catalog = load_catalog(args.missing)
        for key in sorted(set(en) - set(catalog) - META_KEYS):
            value = en[key]
            text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
            print(f'{key}\t{text}')
        return 0

    kinds, sites, literals = scan_sources()
    check_usage(en, kinds, sites, literals)

    langs = [args.lang] if args.lang else [l for l in available_langs() if l != 'en']
    coverage = {lang: check_language(lang, en, load_catalog(lang)) for lang in langs}

    print(f'en.json: {len(en)} keys, {len(kinds)} used in code\n')
    if coverage:
        print('Coverage')
        for lang, pct in sorted(coverage.items()):
            print(f'  {lang:6} {pct:5.1f}%')
        print()

    for msg in warnings:
        print(f'WARN  {msg}')
    for msg in errors:
        print(f'ERROR {msg}', file=sys.stderr)

    print(f'\n{len(errors)} error(s), {len(warnings)} warning(s)')
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
