# Reconstructed workflows

**These are NOT the real workflows.** `createArticle`, `cleanup` and
`resetSharePoint` live in a private Azure Functions project this repository has
no access to. They were reconstructed here from their names and their shape as
described, at the maintainer's explicit direction, so that Phase 7 could run at
all.

**What that costs, stated plainly.** A fixture written by the same person who
designed the API confirms the design by construction. These were therefore
written to be *adversarial* rather than convenient: each one reaches for a
pattern the unit tests do not cover, and the findings they produced are recorded
in `FINDINGS.md` — including the ones that were left unfixed.

Read a green run here as "the API composes over these shapes", never as "the API
survived contact with production code". Only the real workflows can say that.
