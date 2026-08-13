---
commit: 9d00244d61f3401cfee32dc5e6a404b92d3c1d24
date: 2026-08-12
checksums:
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
  - path: .claude/skills/assess/SKILL.md
    sha256: bdd5995c6489e670a4252db9978c9b081877907cbc8f4329c8e9a769575d5216
  - path: .claude/skills/devise/SKILL.md
    sha256: e231924548b4c0d14bad0d8a511711f33c47cc5b1dcb03f2f6719cbb0c9cf14f
  - path: .claude/skills/implement/SKILL.md
    sha256: a9dd0afb532db733c6cb2200424eb516be1e4d325977d7e35158ece2c2a229e5
  - path: .claude/skills/verify/SKILL.md
    sha256: 09795454a6bf4abac884d31427b73c54c179ae11f7ca46745363e1aec1ea781e
  - path: .claude/skills/deliver/SKILL.md
    sha256: b81c0c8e320075841305c761b7fdf6a9e6ed6d8bc45cf4e4f47eabfd96afa49c
  - path: .claude/skills/distill/SKILL.md
    sha256: 4895ad18990e426e15e7addc58df2d1334119e39c21eb6151a6c6fd86e992ef3
  - path: .claude/skills/brief/SKILL.md
    sha256: cae221b2b6bb28ae1021c136b1acc9937deb6dcd324b2743a84908cd70caa74f
  - path: .claude/skills/brief/formats.md
    sha256: 131abf664a212a30955a7489bf97db6c09c5373843b495a84ab88cf3c4854371
---

# Vendoring receipt

The deuce commit this repository vendored, the date, and a checksum per contract file —
written by the sync, never by hand, and re-written by every sync that merges
([Chapter 5](https://github.com/wrburgess/deuce/blob/main/sds/05-distribution.md) →
*The vendoring receipt*). A checksum mismatch against a contract file is drift: visible,
never forbidden, reported on every sync pull request.
