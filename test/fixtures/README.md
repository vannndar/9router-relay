# Screenshot regression fixture

`classic-example.rgba.gz` contains a 647 × 1400 RGBA screenshot, compressed with
gzip for dependency-free Node tests. It is resized from the public example at
https://blockblastsolver.ai/images/example.webp (retrieved 9 November 2026).
Block Blast game artwork belongs to its respective owners. This fixture is for
local recognition regression testing only and is excluded from the Vercel upload
by the existing `test/` ignore rule. It is not displayed in the public app.

Expected board row masks: `[135,31,31,15,1,121,113,252]`.
Expected pieces: a 2×2 square, `[[0,1],[0,1],[1,1]]`, and
`[[1,1,1],[0,0,1],[0,0,1]]`.
