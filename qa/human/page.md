# Manual QA: the page

Serve it: `python3 -m http.server 8000 --bind 127.0.0.1 --directory web`, open <http://127.0.0.1:8000/>.
You need a few `.colreplay` files of your own.

1. Empty page. The big number reads "11.2x smaller" with a line saying it is the benchmark result.
2. Drop 3 replays. Each row goes Waiting, Working, Exact. The big number switches to your files.
   The chart shows two bars from zero with sizes as text.
3. Each finished row says "exact: verified by checksum ... and a full unpack, byte for byte".
4. "Download all 3 (.zip)" saves a zip of three `.clrz` files. One row's button saves one `.clrz`.
5. Drop those `.clrz` files back. Each row says Unpack and Exact; the downloads match your originals
   (`cmp` or `sha256sum`).
6. Drop a text file. It says "Kept as is", is left out of the big number, and the progress line says
   "1 not a replay, kept as is, not counted".
7. Cut a `.clrz` short (`head -c 50000 a.clrz > bad.clrz`) and drop it. It says Failed with a reason.
8. Clear with results on the page asks first.
9. One light theme only: no theme button, and a system set to dark mode still gets the light page.
10. **Greyscale pass.** DevTools, Rendering, Emulate vision deficiencies, Achromatopsia. Every status
    still reads from its glyph and word; the highlighted chart bar still has its marker. Then Deuteranopia.
11. Phone width (375 px in DevTools). No sideways scroll, buttons not cut off.
12. DevTools Network tab while packing: no requests after the page has loaded.
