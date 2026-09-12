# Vendored Vale style pack: write-good

- Source repository: https://github.com/errata-ai/write-good
- Vendored commit SHA: `c9ceca7f574248a201d5524b001099c5626c7519`
- Vendor date: 2026-09-12
- License: MIT (see `LICENSE` in this directory)

## What is vendored

All rule files from the pack's `write-good/` directory, copied flat:

`Cliches.yml`, `E-Prime.yml`, `Illusions.yml`, `Passive.yml`, `So.yml`,
`ThereIs.yml`, `TooWordy.yml`, `Weasel.yml`, plus `meta.json`.

## Why vendored

The Factory QA pipeline (`editorial.vale_style`, Run 4.1 W4) uses Vale with
this pack as an advisory style lint. Vendoring keeps CI network-free and makes
the exact rule text part of review: CI never downloads styles at run time, and
rule changes are ordinary reviewed commits.

## Update procedure

Replace the `.yml` files with the new upstream revision, update the commit SHA
and date above, and review the diff of rule semantics. The pack is DATA — do
not hand-edit rule logic.
