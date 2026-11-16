# EVA Studio

From a 3D boat scan to cut-ready EVA foam decking panels.

A web app that runs entirely in the browser (Chrome or Edge on Windows/macOS). Scans and projects are read from
and saved to the user's own disk; nothing is uploaded.

## Status

| Version | Scope | State |
|---|---|---|
| v0.1 | Project folder, open OBJ scan, 3D view | done |
| v0.2 | Surfaces: pick flat areas, straight-sided outline with editable corners, DXF export | done (curved sides and control measurements still to come) |
| v0.3 | Panels: per-side offset, per-corner radius, reshape, cut-outs, splitting | next |
| v0.4 | Design: border, pattern library, logo across panels, feasibility checks | |
| v0.5 | Client PDF | |
| v0.6 | Nesting and G-code | |

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
