---
commit: 90ee01aed9a634930249d9bfae2c2a9187d9cb38
date: 2026-08-12
checksums:
  - path: skills/assess/SKILL.md
    sha256: b66d4a1e135ec141abc114407c1839e1920d273e2ebfe64bbc4ab27f509b9ba7
  - path: skills/devise/SKILL.md
    sha256: bb033d44195aedebaa69f1929ffeef545a3a369938598e756a9fd82e3094edbf
  - path: skills/implement/SKILL.md
    sha256: 2ebec42b8c5e053c3937b97ba4b950b568a969a78e1fa9915e1749004b36d053
  - path: skills/verify/SKILL.md
    sha256: cd4844ef670cb4ba6030de43e0cd5c264ae9936f9677f10855b6056e65243250
  - path: skills/deliver/SKILL.md
    sha256: e08157e016cadf4f4b4247496c992c250e0d5f9552e3e98698fd4c1c2b537cd7
  - path: skills/distill/SKILL.md
    sha256: 70658dc71d1cca2aed6915b5ba405875227f92633572de67d488d1f4f49e1977
  - path: skills/brief/SKILL.md
    sha256: 9ebf22e912407aae28e821ff26632fbc81534d8e8b95d86460282ecf827ecd4c
  - path: skills/brief/formats.md
    sha256: 131abf664a212a30955a7489bf97db6c09c5373843b495a84ab88cf3c4854371
  - path: .githooks/guard-protected-branch
    sha256: 4bf66f4e2b58888e5a5f6a6cbc0d3dcdad0350d82d4f5aa150c55a9084e3daf9
  - path: .githooks/pre-commit
    sha256: de2d71a841cf8baa5ea6cd21652164d81c36eda2e1f720475e22149a9692463b
  - path: .githooks/pre-push
    sha256: de2d71a841cf8baa5ea6cd21652164d81c36eda2e1f720475e22149a9692463b
  - path: .github/ISSUE_TEMPLATE/bug.yml
    sha256: 00d59d888d2c595142674896ceec56723a05aa770e5b23e56bbc40d43cdbbdf2
  - path: .github/ISSUE_TEMPLATE/chore.yml
    sha256: ee59aa8d6f4ce0f9bd24c624ab80344f2b77f6f80a0418375e32afa888baba1f
  - path: .github/ISSUE_TEMPLATE/config.yml
    sha256: 1f103c6a9dd07cd13a9a6f17ace6b813f47747eb9cb7e00488cb2073caaf91bb
  - path: .github/ISSUE_TEMPLATE/epic.yml
    sha256: 4b174eb88bb811a619464208635297a6449241582a488fd97e7894a2523192b5
  - path: .github/ISSUE_TEMPLATE/spike.yml
    sha256: 794b1b0effea57d97eebb60439733d508a551dfdaa3e76946dace23034323dc9
  - path: .github/ISSUE_TEMPLATE/task.yml
    sha256: b976f82296b95243e6d5945332ff3ebed5b510127d9d42de21018912e5051ef8
  - path: AGENTS.md
    sha256: a71e04d090f5ce02763ef47ce92e1059d223b4e3d44f28ddf9fdcf1dfc0e452b
---

# Vendoring receipt

The deuce commit this repository vendored, the date, and a checksum per contract file —
written by the sync, never by hand, and re-written by every sync that merges
([Chapter 5](https://github.com/wrburgess/deuce/blob/main/sds/05-distribution.md) →
*The vendoring receipt*). A checksum mismatch against a contract file is drift: visible,
never forbidden, reported on every sync pull request.
