"""Sheet-music PDF -> MIDI for Piano Coach.

Usage:  python convert.py piece.pdf          -> piece.mid next to the PDF
Needs:  Audiveris (https://github.com/Audiveris/audiveris/releases) and  pip install music21

Audiveris reads the notes from the PDF into MusicXML; music21 turns that into a MIDI file
with one track per staff (right hand / left hand), which the app shows in two colours.
Recognition is not perfect: listen to the result in the app before learning from it.
"""
import glob
import os
import shutil
import subprocess
import sys
import tempfile


def find_audiveris():
    found = os.environ.get("AUDIVERIS") or shutil.which("Audiveris") or shutil.which("audiveris")
    if found:
        return found
    for pattern in [r"C:\Program Files\Audiveris*\Audiveris.exe", r"C:\Program Files\Audiveris*\bin\Audiveris.bat"]:
        hits = glob.glob(pattern)
        if hits:
            return hits[0]
    sys.exit("Audiveris not found. Install it, or set AUDIVERIS to the full path of Audiveris.exe.")


def pdf_to_musicxml(pdf, workdir):
    cmd = [find_audiveris(), "-batch", "-export", "-output", workdir, "--", pdf]
    print("Reading the sheet music (can take a minute per page)...")
    result = subprocess.run(cmd, capture_output=True, text=True)
    files = glob.glob(os.path.join(workdir, "**", "*.mxl"), recursive=True) + \
        glob.glob(os.path.join(workdir, "**", "*.xml"), recursive=True)
    if not files:
        sys.exit("Audiveris could not read any music from this PDF.\n" + result.stdout[-2000:] + result.stderr[-2000:])
    return sorted(files)  # multi-movement scores give one file per movement


def musicxml_to_midi(files, out):
    from music21 import converter, stream

    score = converter.parse(files[0])
    for extra in files[1:]:  # append later movements after the first one
        more = converter.parse(extra)
        for mine, theirs in zip(score.parts, more.parts):
            for m in theirs.getElementsByClass(stream.Measure):
                mine.append(m)
    score.write("midi", fp=out)
    return len(score.parts)


def main():
    if len(sys.argv) != 2 or not sys.argv[1].lower().endswith(".pdf"):
        sys.exit("Usage: python convert.py piece.pdf")
    pdf = os.path.abspath(sys.argv[1])
    if not os.path.isfile(pdf):
        sys.exit(f"File not found: {pdf}")
    out = os.path.splitext(pdf)[0] + ".mid"
    with tempfile.TemporaryDirectory() as work:
        parts = musicxml_to_midi(pdf_to_musicxml(pdf, work), out)
    print(f"Done: {out}  ({parts} staff track{'s' if parts != 1 else ''})")
    print("Copy it to your phone and open it with 'Open song' in Piano Coach.")


if __name__ == "__main__":
    main()
