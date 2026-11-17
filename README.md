# EVA Studio

From a 3D boat scan to cut-ready EVA foam decking panels.

A web app that runs entirely in the browser (Chrome or Edge on Windows/macOS). Scans and projects are read from
and saved to the user's own disk; nothing is uploaded.

## Status

| Version | Scope | State |
|---|---|---|
| v0.1 | Project folder, open OBJ scan, 3D view | done |
| v0.2 | Surfaces: pick flat areas, straight-sided outline with editable corners, DXF export | done, incl. curved sides and tape-measurement checks |
| v0.3 | Panels: per-side offset, per-corner radius, reshape, DXF with true arcs | done, incl. openings and splitting into several panels with a gap |
| v0.4 | Design: border, pattern library (teak lines, diamond, hexagon, fish scale), realistic preview, milling lines in DXF | done, incl. logos (SVG) and text across panels, filled areas, own pattern tiles |
| v0.5 | Sheets: arrange all panels on EVA sheets (gap, edge margin, turning rules), sheet DXF with one layer per CNC operation | done |
| v0.6 | Client PDF | |
| v0.7 | G-code (waits for the controller specification) | |

## Develop

```
npm install
npm run dev        # local app at http://localhost:5173
npm test           # unit tests
npm run build      # type-check + production build into dist/
```

Optional check against a real scanner file: `EVA_TEST_SCAN=/path/to/scan.obj npm test`.

## Project folder format

```
Boat-name/
  project.json    all decisions and geometry (see src/core/project.ts)
  scans/          original scanner files, never modified
  graphics/       client logos and custom patterns (SVG, DXF)
  export/         DXF, PDF, later G-code
```

All lengths are millimetres.
