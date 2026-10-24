# garage-common: manual-pdf 1
# Builds the user manual of the app as three PDFs (English, Italian, Spanish) from the Markdown files
# docs/manual/manual.en.md, manual.it.md, manual.es.md. Python 3 standard library only, plus headless Chrome or Chromium.
#
#   python3 docs/manual/build.py <version> [<output folder>]
#
# Names: <NAME>-Manual-<LANG>-<version>.pdf. The Markdown is the small subset the manuals use: # title (ignored, the cover has
# it), ## chapters (numbered in the contents), ### sections, paragraphs, - and 1. lists, | tables |, > notes (> **Warning** for a
# red box), ``` code ```, **bold**, *italic*, `code`, [links](url), --- . {v} is replaced by the version.
import html, os, re, shutil, subprocess, sys

NAME = "Ticker-Feed-Builder"           # product name with dashes: it names the files
TITLE = "Ticker Feed Builder"          # title on the cover
# where the three Markdown sources are (relative to this folder) and what a relative link in them points to in the PDF
SOURCES = {"en": "manual.en.md", "it": "manual.it.md", "es": "manual.es.md"}
LINK_BASE = "https://github.com/djgragra/ticker-feed-builder/blob/main/docs/manual/"
VER = sys.argv[1] if len(sys.argv) > 1 else "0.0.0"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(sys.argv[2] if len(sys.argv) > 2 else HERE)  # absolute: Chrome needs it for file:// and --print-to-pdf

LABELS = {
    "en": dict(manual="User manual", version="Version", license="MIT License © 2026 Graziano Melzi", toc="Contents"),
    "it": dict(manual="Manuale d'uso", version="Versione", license="Licenza MIT © 2026 Graziano Melzi", toc="Indice"),
    "es": dict(manual="Manual de usuario", version="Versión", license="Licencia MIT © 2026 Graziano Melzi", toc="Contenido"),
}

CSS = """
@page { size: A4; margin: 20mm 18mm 20mm 18mm; }
* { box-sizing: border-box; }
body { font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; color:#1c2333; font-size:10.5pt; line-height:1.5; }
h1 { font-size: 30pt; margin: 0 0 6px; color:#2f62d6; }
h2 { font-size: 16pt; color:#2f62d6; border-bottom: 2px solid #c9d8f6; padding-bottom:4px; margin: 26px 0 10px; break-after: avoid; }
h3 { font-size: 12pt; margin: 16px 0 6px; break-after: avoid; }
p { margin: 6px 0; } ul,ol { margin: 6px 0 6px 20px; padding:0; } li { margin: 3px 0; }
code { font-family: Menlo, Consolas, monospace; font-size: 9.2pt; background:#eef1f7; padding:1px 4px; border-radius:3px; }
pre { background:#eef1f7; padding:8px 10px; border-radius:6px; font-size:9pt; overflow:hidden; white-space:pre-wrap; break-inside: avoid; }
pre code { background:none; padding:0; }
table { border-collapse: collapse; width:100%; margin: 8px 0; font-size:9.6pt; break-inside: avoid; }
th, td { border:1px solid #c5ccd8; padding:5px 8px; text-align:left; vertical-align:top; }
th { background:#e3e9f5; }
.note { border-left:4px solid #2f62d6; background:#eef3ff; padding:7px 12px; margin:10px 0; break-inside: avoid; }
.warn { border-left:4px solid #c2323f; background:#fdeeee; padding:7px 12px; margin:10px 0; break-inside: avoid; }
.cover { min-height: 235mm; display:flex; flex-direction:column; justify-content:center; page-break-after: always; }
.cover .sub { font-size:14pt; color:#4d586b; margin-bottom:28px; }
.cover .meta { color:#4d586b; font-size:10.5pt; }
.toc { page-break-after: always; } .toc ol { list-style: none; margin:0; } .toc li { padding:3px 0; border-bottom:1px dotted #c5ccd8; }
h2.brk { break-before: page; }
hr { border:0; border-top:1px solid #c5ccd8; margin:14px 0; }
a { color:#2f62d6; }
"""


def inline(t):
    t = html.escape(t, quote=False)
    codes = []
    t = re.sub(r"`([^`]+)`", lambda m: codes.append(m.group(1)) or f"\x00{len(codes) - 1}\x00", t)
    t = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", t)
    t = re.sub(r"(?<![\w*])\*([^*\s][^*]*?)\*(?![\w*])", r"<i>\1</i>", t)
    t = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", lambda m: f'<a href="{m.group(2) if re.match(r"^[a-z]+:", m.group(2)) else LINK_BASE + m.group(2)}">{m.group(1)}</a>', t)
    return re.sub(r"\x00(\d+)\x00", lambda m: f"<code>{codes[int(m.group(1))]}</code>", t)


def cells(line):
    return [c.strip() for c in line.strip().strip("|").split("|")]


def convert(md):
    lines = md.replace("\r\n", "\n").split("\n")
    out, chapters, i = [], [], 0
    while i < len(lines):
        ln = lines[i]
        if not ln.strip():
            i += 1
        elif ln.startswith("```"):
            i += 1
            code = []
            while i < len(lines) and not lines[i].startswith("```"):
                code.append(lines[i]); i += 1
            i += 1
            out.append("<pre><code>" + html.escape("\n".join(code)) + "</code></pre>")
        elif ln.startswith("# "):
            i += 1  # the cover carries the title
        elif ln.startswith("## "):
            title = ln[3:].strip()
            chapters.append(title)
            out.append(f"<h2>{len(chapters)}. {inline(title)}</h2>")
            i += 1
        elif ln.startswith("### "):
            out.append(f"<h3>{inline(ln[4:].strip())}</h3>"); i += 1
        elif re.match(r"^-{3,}\s*$", ln):
            out.append("<hr>"); i += 1
        elif ln.lstrip().startswith("|") and i + 1 < len(lines) and re.match(r"^\s*\|?\s*:?-{2,}", lines[i + 1]):
            head = cells(ln); i += 2
            rows = []
            while i < len(lines) and lines[i].lstrip().startswith("|"):
                rows.append(cells(lines[i])); i += 1
            t = "<table><tr>" + "".join(f"<th>{inline(c)}</th>" for c in head) + "</tr>"
            for r in rows:
                t += "<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>"
            out.append(t + "</table>")
        elif ln.startswith(">"):
            q = []
            while i < len(lines) and lines[i].startswith(">"):
                q.append(lines[i].lstrip(">").strip()); i += 1
            body = " ".join(q)
            warn = re.match(r"^\*\*(Warning|Attenzione|Atención|Avviso|Aviso)", body)
            out.append(f'<div class="{"warn" if warn else "note"}">{inline(body)}</div>')
        elif re.match(r"^\s*([-*]|\d+\.)\s+", ln):
            ordered = bool(re.match(r"^\s*\d+\.\s+", ln))
            items = []
            item_re = r"^\s*([-*]|\d+\.)\s+"
            while i < len(lines):
                if re.match(item_re, lines[i]):
                    items.append(re.sub(item_re, "", lines[i]))
                elif items and lines[i].startswith("  ") and lines[i].strip():
                    items[-1] += " " + lines[i].strip()
                else:
                    break
                i += 1
            tag = "ol" if ordered else "ul"
            out.append(f"<{tag}>" + "".join(f"<li>{inline(x)}</li>" for x in items) + f"</{tag}>")
        else:
            para = []
            while i < len(lines) and lines[i].strip() and not re.match(r"^(#{1,3} |```|>|\s*([-*]|\d+\.)\s+|\s*\|)", lines[i]):
                para.append(lines[i].strip()); i += 1
            if not para:
                para = [ln.strip()]; i += 1
            out.append(f"<p>{inline(' '.join(para))}</p>")
    return "\n".join(out), chapters


def page(lang, md):
    body, chapters = convert(md)
    d = LABELS[lang]
    toc = "".join(f"<li>{n + 1}. {html.escape(t)}</li>" for n, t in enumerate(chapters))
    return f"""<!DOCTYPE html><html lang="{lang}"><head><meta charset="utf-8"><title>{TITLE} {VER} — {d["manual"]}</title><style>{CSS}</style></head><body>
<div class="cover"><h1>{TITLE}</h1><div class="sub">{d["manual"]}</div><div class="meta">{d["version"]} {VER}<br>Graziano Melzi · OnAir Garage<br>onairgarage.com · hello@onairgarage.com<br>{d["license"]}</div></div>
<div class="toc"><h2>{d["toc"]}</h2><ol>{toc}</ol></div>
{body}</body></html>"""


def find_chrome():
    mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    for c in (os.environ.get("CHROME"), mac if os.path.exists(mac) else None,
              shutil.which("google-chrome"), shutil.which("chromium"), shutil.which("chromium-browser")):
        if c and os.path.exists(c):
            return c
    sys.exit("No Chrome or Chromium found: set CHROME to its path")


if __name__ == "__main__":
    chrome = find_chrome()
    for lang in ("en", "it", "es"):
        md = open(os.path.join(HERE, SOURCES[lang]), encoding="utf-8").read().replace("{v}", VER)
        name = f"{NAME}-Manual-{lang.upper()}-{VER}"
        h = os.path.join(OUT, f"{name}.html")
        open(h, "w", encoding="utf-8").write(page(lang, md))
        out = os.path.join(OUT, f"{name}.pdf")
        flags = ["--headless=new", "--disable-gpu", "--no-pdf-header-footer", f"--print-to-pdf={out}"]
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            flags.append("--no-sandbox")  # root in a container
        subprocess.run([chrome, *flags, f"file://{h}"], check=True, capture_output=True)
        os.remove(h)
        print(out, os.path.getsize(out))
