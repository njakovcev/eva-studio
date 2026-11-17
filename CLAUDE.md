# EVA Studio – working rules

Owner is not a programmer; Claude writes and maintains all code. Favour simple, readable, well-tested code over cleverness.

## Scope
- Boat scan (OBJ, mm) → flat surfaces → EVA panels → milled design → DXF/PDF → later G-code. Nothing beyond G-code generation.
- A surface can also be drawn by hand (Surfaces → Draw a surface): a parametric sketch over a photo, set by tape measurements (`src/core/sketch/`). Its surface follows the sketch.
- v1 handles flat surfaces only. No unrolling of curved surfaces, no design carried between surfaces at different angles.
- EVA sheet: 6 mm, two 3 mm layers of different colour, 2400 × 1200 mm. Every design is made by milling the top layer.
- Scanner alignment markers appear as small holes in the scan; they are never cut.

## Architecture
- Static web app (Vite + React + TypeScript + three.js), deployed on Vercel. No backend, no login.
- Data stays on the user's disk via the File System Access API (Chrome/Edge). Never upload scans.
- `src/core/` is pure geometry and data: no DOM, no React, no three.js. It must run in Node and in a worker, and it is where tests go.
- `src/io/` disk access, `src/view/` three.js, `src/ui/` React.
- Heavy work (parsing, geometry) runs in a Web Worker; the UI must never freeze.
- `project.json` is the contract between steps. Never remove or rename a field without bumping `FORMAT_VERSION` and adding a migration.

## DXF layers = CNC operations (see src/core/operations.ts)
`1_T<n>_GROOVE_<depth>MM` groove centre lines · `2_T<n>_POCKET_<depth>MM` closed shapes to clear out ·
`3_T<n>_EDGE_<depth>MM` rounded edge: tool centre just outside every knife cut ·
`4_KNIFE_INNER` openings · `5_KNIFE_OUTER` panel outlines (last) · `0_REFERENCE` not machined.
The number is the running order: mill first, cut out last. Tool numbers come from
`settings.tools` / `settings.machining` (src/core/tools.ts); defaults: T21 grooves and pockets,
T20 ball Ø25 edge, lowest point 5 mm, 2 mm left at the knife line.

## Conventions
- UI language: English. All units: millimetres.
- Errors shown to the user are plain sentences that say what to do next.
- Never modify or delete a user's original scan file.
- Before every commit: `npm test` and `npm run build` must pass.
