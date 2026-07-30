#!/usr/bin/env ruby
# frozen_string_literal: true

# parity_check.rb — structural parity check for the Config Bundle (ADR 0008).
#
# Verifies, WITHOUT any model-in-the-loop testing, that every per-tool Adapter still resolves to the
# Canonical Source and that the Project Config is structurally intact. Dependency-free: standard
# library only (no gems, no bundler), so it runs on a bare Ruby in CI.
#
# Usage:
#   ruby scripts/parity_check.rb [--root DIR]
#     --root DIR   Directory to check (default: current directory). Used by the self-test to point
#                  the checker at fixture bundles.
#
# Exit status: 0 when every invariant holds; 1 when any fails (all failures are printed).
#
# Adapter marker conventions (kept in lockstep with AGENTS.md / PROJECT.md):
#   Native-discovery adapter:  <!-- parity:native source=AGENTS.md -->
#   Rendered adapter:          <!-- parity:render source=AGENTS.md --> … <!-- parity:endrender -->
#                              (the region between the markers must equal AGENTS.md byte-for-byte)

require "optparse"
require "yaml"
require "json"
require_relative "protected_branches"
require_relative "human_gates"
require_relative "reviewer"

class ParityCheck
  CANONICAL = "AGENTS.md"

  # Import Adapters: files that resolve to the Canonical Source. The existence + count invariants apply
  # to every entry; how each is allowed to resolve is governed by NATIVE_CAPABLE_ADAPTERS below.
  IMPORT_ADAPTERS = ["CLAUDE.md", "GEMINI.md"].freeze

  # Adapters that may resolve via NATIVE discovery instead of an `@AGENTS.md` import. `GEMINI.md`
  # qualifies: Google's Antigravity CLI (which superseded Gemini CLI, announced 2026-05-19) reads
  # `AGENTS.md` natively since v1.20.3, and a host may point the tool straight at `AGENTS.md` via the
  # `context.fileName` setting — both are first-class resolutions per ADR 0002, so a Gemini adapter
  # that declares native discovery (a `parity:native source=AGENTS.md` marker, the same mechanism the
  # Copilot adapter uses) must not false-fail parity. `CLAUDE.md` is NOT native-capable — Claude Code
  # has no native `AGENTS.md` discovery, so the import is its only resolution.
  #
  # ADR 0008 boundary: this stays a purely STRUCTURAL check — it verifies the Adapter *file* resolves
  # to `AGENTS.md`, not that the external tool actually reads that filename. No structural check can
  # detect a future tool renaming its default context file (a false-green); that liveness is re-verified
  # out-of-band in docs/research/tool-config-discovery.md (last re-verified for Antigravity CLI, #56).
  NATIVE_CAPABLE_ADAPTERS = ["GEMINI.md"].freeze

  COPILOT_ADAPTER = ".github/copilot-instructions.md"
  PROJECT_CONFIG = "PROJECT.md"

  # Files whose relative markdown links must resolve: the Canonical Source, its Adapters, the Project
  # Config, and EVERY bundle-owned markdown file the bundle ships. Each is link-checked only if present
  # (check_links skips missing files), so a minimal fixture bundle — and a host that vendored only part
  # of the tree — is unaffected.
  #
  # WHY AN EXPLICIT ENUMERATION AND NOT A GLOB (issue #96). A glob (`docs/**/*.md`) evaluated at check
  # time would, after vendoring, sweep a HOST APP's own docs and redden its parity on day one for dead
  # links the bundle never shipped — the exact failure pattern this list exists to stop. An enumeration
  # names only bundle-owned paths, so the host blast radius is zero. The cost is that the list can rot;
  # that is bought back by `test_link_checked_enumerates_every_bundle_owned_markdown_file` in
  # test/parity_check_test.rb, which globs the subtrees below and fails naming any unlisted file. That
  # guard lives in test/, which ace-sync deliberately never vendors, so it runs in the bundle and
  # never in a host — which is precisely what lets the SHIPPED constant stay a safe, explicit list.
  #
  # THE RULE: every markdown file this bundle VENDORS is enumerated here. The drift guard derives its
  # expected set by walking ace-sync's own ALLOW manifest — not by re-globbing the subtrees named
  # below — so an entire omitted *subtree* is caught, not just an omitted file. (A guard that globbed
  # the same subtrees this list enumerates could only ever agree with itself.) Add a new ADR, guide,
  # Learnings entry, Skill body, or shim? Add it here too; the drift test names anything you miss.
  #
  # NOTE: this constant also drives check_rendered_regions, which scans the same files for a
  # `parity:render` block. Both scans are code-span aware (see strip_code), so a doc may safely SHOW a
  # marker or a link inside a fenced example without tripping either check.
  LINK_CHECKED = [
    # Canonical Source, its Adapters, and the Project Config
    "AGENTS.md",
    "CLAUDE.md",
    "GEMINI.md",
    "PROJECT.md",
    ".github/copilot-instructions.md",
    "README.md",
    # Context Map
    "CONTEXT.md",
    # Claude Invocation Shims (ADR 0003 / ADR 0010). check_skills asserts each shim CONTAINS the
    # literal `skills/<name>/SKILL.md`, which a wrong relative prefix (`../skills/...`) still
    # satisfies — link-checking them is what actually proves the pointer resolves.
    ".claude/commands/assess.md",
    ".claude/commands/clip.md",
    ".claude/commands/create-skill.md",
    ".claude/commands/devise.md",
    ".claude/commands/distill.md",
    ".claude/commands/final.md",
    ".claude/commands/follow.md",
    ".claude/commands/invoke.md",
    ".claude/commands/listen.md",
    ".claude/commands/restock.md",
    ".claude/commands/scout.md",
    ".claude/commands/ship.md",
    ".claude/commands/verify.md",
    # Architecture Decision Records
    "docs/adr/0001-distribute-as-copy-in-sync-script.md",
    "docs/adr/0002-agents-md-canonical-pointer-projection.md",
    "docs/adr/0003-skills-canonical-body-thin-shims-graceful-degradation.md",
    "docs/adr/0004-two-tier-rules-layer-progressive-context.md",
    "docs/adr/0005-ship-hybrid-delegation-offload-retrieval-protect-judgment.md",
    "docs/adr/0006-baseline-skill-set-and-github-default-lifecycle-host.md",
    "docs/adr/0007-attribution-includes-model-version-for-audits.md",
    "docs/adr/0008-structural-parity-check-not-model-in-the-loop.md",
    "docs/adr/0009-defense-in-depth-branch-protection-all-agents.md",
    "docs/adr/0010-repo-layout-canonical-skills-at-root.md",
    "docs/adr/0011-ascii-safe-stdout-stays-doc-only.md",
    "docs/adr/0012-intake-pipeline-placement.md",
    "docs/adr/0013-scheduled-intake-sweep-and-empty-sweep-policy.md",
    "docs/adr/0014-manual-drop-inbox-for-unfetchable-sources.md",
    "docs/adr/0015-intake-front-door-drop-skill.md",
    "docs/adr/0016-interactive-sequential-disposition-scout.md",
    "docs/adr/0017-stack-neutral-baseline-with-stack-overlays.md",
    "docs/adr/0018-neutrality-pass-scope-tooling-and-enforcement.md",
    "docs/adr/0019-create-skill-authoring-front-door.md",
    "docs/adr/0020-right-size-plan-revisable-direction.md",
    "docs/adr/0021-voice-watchlist-front-door.md",
    "docs/adr/0022-instruction-file-line-allowance.md",
    "docs/adr/0023-tool-roster-facts-tracker-sibling-to-intake.md",
    "docs/adr/0024-harness-model-naming-convention.md",
    "docs/adr/0025-human-gate-policy-is-a-project-config-value.md",
    "docs/adr/0026-reviewer-is-a-project-config-value-ac-summons-floor-preserved.md",
    "docs/adr/0027-reviewer-chain-validated-against-invocation-paths.md",
    "docs/adr/0028-context-reset-boundary-resumable-stops-autonomous-listen.md",
    "docs/adr/0029-baseline-ships-ungated-to-merge.md",
    "docs/adr/0030-adr-numbering-preflight-enforcement.md",
    "docs/adr/0031-clean-tree-destructive-op-guard.md",
    "docs/adr/0032-enforcement-gap-second-loop-distributed-enforcement.md",
    "docs/adr/0033-verification-stays-in-main-agent-loop.md",
    "docs/adr/0034-rename-bundle-ai-config-to-ace.md",
    "docs/adr/0035-codex-summons-is-the-local-cli-runtime.md",
    "docs/adr/0036-async-reviewer-sha-binding-requires-artifact-attestation.md",
    "docs/adr/0037-merge-gate-accepts-attested.md",
    # Standards
    "docs/standards/development-lifecycle.md",
    # Out-of-band research (the per-tool discovery re-verification AGENTS.md cites) and Stack Overlays
    "docs/research/tool-config-discovery.md",
    "docs/overlays/ace-rails.md",
    # Guides
    "docs/guides/authoring-the-bundle.md",
    "docs/guides/branch-protection.md",
    "docs/guides/detaching-the-intake-pipeline.md",
    "docs/guides/intake-sweep-scheduling.md",
    "docs/guides/tool-roster-refresh-scheduling.md",
    "docs/guides/usage.md",
    # Tier-2 Deferred Deep Docs (ADR 0004)
    "docs/rules/README.md",
    "docs/rules/scripting-postmortems.md",
    "docs/rules/skills-postmortems.md",
    "docs/rules/testing-postmortems.md",
    # Tier-1 Lean Core (ADR 0004)
    "rules/backend.md",
    "rules/communication.md",
    "rules/frontend.md",
    "rules/scripting.md",
    "rules/security.md",
    "rules/self-review.md",
    "rules/skills.md",
    "rules/testing.md",
    # Skill canonical bodies + their bundled files (ADR 0003 / ADR 0010)
    "skills/assess/SKILL.md",
    "skills/clip/SKILL.md",
    "skills/create-skill/SKILL.md",
    "skills/devise/SKILL.md",
    "skills/distill/ADR-FORMAT.md",
    "skills/distill/CONTEXT-FORMAT.md",
    "skills/distill/SKILL.md",
    "skills/final/SKILL.md",
    "skills/follow/SKILL.md",
    "skills/invoke/SKILL.md",
    "skills/listen/SKILL.md",
    "skills/restock/SKILL.md",
    "skills/scout/SKILL.md",
    "skills/ship/SKILL.md",
    "skills/verify/SKILL.md",
    # Reference seed: the Voices Watchlist prose doc, the intake inbox, and the Learnings Log
    "docs/reference/README.md",
    "docs/reference/ai-engineering-voices.md",
    "docs/reference/intake-inbox/README.md",
    "docs/reference/intake-inbox/TEMPLATE.md",
    "docs/reference/learnings/README.md",
    "docs/reference/learnings/index.md",
    "docs/reference/learnings/entries/2026-07-06-building-effective-agents-simplicity.md",
    "docs/reference/learnings/entries/2026-07-06-hamel-evals-first-class-tests.md",
    "docs/reference/learnings/entries/2026-07-07-andrew-ng-coding-agent-domain-acceleration.md",
    "docs/reference/learnings/entries/2026-07-07-andrew-ng-loop-engineering.md",
    "docs/reference/learnings/entries/2026-07-07-anthropic-steering-claude-code.md",
    "docs/reference/learnings/entries/2026-07-07-eugene-yan-compound-with-ai.md",
    "docs/reference/learnings/entries/2026-07-07-eugene-yan-eval-design-pattern.md",
    "docs/reference/learnings/entries/2026-07-07-eugene-yan-llm-secure-source-code.md",
    "docs/reference/learnings/entries/2026-07-07-google-io-antigravity-cli-gemini-adapter.md",
    "docs/reference/learnings/entries/2026-07-07-hamel-hard-to-eval-product-smell.md",
    "docs/reference/learnings/entries/2026-07-07-jason-liu-scheduled-work-kinds.md",
    "docs/reference/learnings/entries/2026-07-07-karpathy-software-3-agent-native.md",
    "docs/reference/learnings/entries/2026-07-07-latent-space-against-one-shot-design.md",
    "docs/reference/learnings/entries/2026-07-07-lilian-weng-harness-engineering.md",
    "docs/reference/learnings/entries/2026-07-07-openai-cookbook-agent-improvement-loop.md",
    "docs/reference/learnings/entries/2026-07-07-openai-cookbook-iterative-repair-loops.md",
    "docs/reference/learnings/entries/2026-07-07-pocock-agent-read-authoring.md",
    "docs/reference/learnings/entries/2026-07-07-pocock-grill-with-docs-anti-patterns.md",
    "docs/reference/learnings/entries/2026-07-07-pocock-grill-with-docs.md",
    "docs/reference/learnings/entries/2026-07-07-pocock-kill-context-bloat.md",
    "docs/reference/learnings/entries/2026-07-07-pocock-progressive-disclosure-skills.md",
    "docs/reference/learnings/entries/2026-07-07-pocock-skills-as-markdown-catalog.md",
    "docs/reference/learnings/entries/2026-07-07-thorsten-ball-agents-in-orbs.md",
    "docs/reference/learnings/entries/2026-07-07-thorsten-ball-building-software-is-learning.md",
    "docs/reference/learnings/entries/2026-07-07-willison-ai-review-caught-bugs.md",
    "docs/reference/learnings/entries/2026-07-07-willison-better-models-worse-tools.md",
    "docs/reference/learnings/entries/2026-07-07-willison-dspy-agent-prompt-evals.md",
    "docs/reference/learnings/entries/2026-07-07-willison-fable-judgement-delegation.md",
    "docs/reference/learnings/entries/2026-07-07-willison-vibe-coding-agentic-converging.md",
    "docs/reference/learnings/entries/2026-07-08-pocock-code-review-fowler-smells.md",
    "docs/reference/learnings/entries/2026-07-08-pocock-grilling-fixes-backport.md",
    "docs/reference/learnings/entries/2026-07-08-pocock-wayfinder-blocking-tickets.md",
    "docs/reference/learnings/entries/2026-07-28-thariq-context-engineering-claude-5.md",
  ].freeze

  # Usage guides (ADR 0008 surface finalization, issue #11). Checked only for a bundle that ships a
  # docs/guides/ tree (the GUIDES_DIR gate) so a minimal fixture bundle is unaffected — the same "only
  # for a bundle that ships them" stance as check_rules / check_skills / check_guardrails. The floor is
  # existence: each required guide must be shipped, so a future manifest change can't silently drop the
  # vendor/customize/run walkthrough. Reachability is deliberately NOT anchored to README.md — README
  # is not vendored (ace-sync skips it) and a Host App owns its own, so a "referenced by README"
  # rule would fail in-host, breaking the vendored-copy parity invariant the guide itself documents.
  # In-host the guide is discoverable under docs/guides/; in this repo README links it (guarded by
  # check_links, since README is in LINK_CHECKED).
  GUIDES_DIR = "docs/guides"
  REQUIRED_GUIDES = ["docs/guides/usage.md"].freeze

  # ADR numbering discipline (#133 / #131). Checked only for a bundle that ships a docs/adr/ tree (the
  # ADR_DIR gate) so a minimal fixture bundle is unaffected — the same "only for a bundle that ships
  # them" stance as check_rules / check_skills / check_guides. The leading number of each ADR filename
  # is parsed here; a gap or a duplicate is the signature of a number picked or reserved from stale
  # local state instead of computed from origin/main.
  ADR_DIR = "docs/adr"

  # Tier-1 Lean Core rule files (ADR 0004). Each must exist, be referenced by AGENTS.md so every tool
  # can reach the Lean Core, and declare its Patterns + Anti-Patterns sections. Checked only for a
  # bundle that ships a rules/ tree (the RULES_DIR gate) so a minimal fixture bundle is unaffected —
  # the same "only for a bundle that ships them" stance as check_guardrails.
  RULES_DIR = "rules"
  REQUIRED_RULES = [
    "rules/backend.md", "rules/communication.md", "rules/frontend.md", "rules/testing.md",
    "rules/security.md", "rules/self-review.md", "rules/scripting.md", "rules/skills.md"
  ].freeze
  # Section presence is asserted (the heading line), not content — so a host freely extends the body.
  RULE_REQUIRED_SECTIONS = ["## Patterns", "## Anti-Patterns"].freeze

  # Skills (ADR 0003 / ADR 0010). Each Skill is a canonical body at skills/<name>/SKILL.md reached
  # through a thin Invocation Shim. Checked only for a bundle that ships a skills/ tree (the
  # SKILLS_DIR gate) so a minimal fixture bundle is unaffected — the same "only for a bundle that
  # ships them" stance as check_rules / check_guardrails. REQUIRED_SKILLS is a floor (the baseline
  # ships all 13 today); it grows as later issues add skills. The per-present-skill invariants apply
  # to EVERY skills/<name>/ dir, so those later skills are covered by construction — no rewrite.
  SKILLS_DIR = "skills"
  CLAUDE_COMMANDS_DIR = ".claude/commands"
  # A frontmatter delimiter, matched at ROOT LEVEL ONLY: `---` in column 0, trailing whitespace (and a
  # CRLF `\r`) tolerated, leading indentation NOT. The indentation rule is load-bearing, not cosmetic —
  # an indented `---` is legal content inside a YAML block scalar, and treating it as the closing fence
  # truncates the block before parsing, hiding any malformed YAML that follows it. That is the very
  # false green this check exists to close (Reviewer finding on PR #111).
  FRONTMATTER_FENCE = /\A---[ \t]*\r?\n?\z/
  # The six lifecycle Skills (ADR 0006). Each MUST route host values through PROJECT.md, so each body
  # is asserted to reference the Project Config (the content-neutrality positive check in check_skills).
  LIFECYCLE_SKILLS = %w[assess devise invoke verify listen final].freeze
  # Floor: the skills the baseline is expected to ship. Grows as later issues add skills; the shape
  # check applies to every *present* skill regardless, so additions are covered by construction.
  # `ship` is the orchestrator (ADR 0005/0006), `scout` is the intake-pipeline sweep (ADR 0012),
  # `clip` is the intake pipeline's push front door (ADR 0015), and `create-skill` is the authoring
  # front door (ADR 0019): all belong in the floor but NOT in LIFECYCLE_SKILLS — none is a lifecycle
  # stage, so none is forced through the PROJECT.md-reference check (each body references PROJECT.md by
  # choice, not by that mandate).
  REQUIRED_SKILLS = (["distill"] + LIFECYCLE_SKILLS + ["ship", "scout", "clip", "create-skill", "follow", "restock"]).freeze

  # Content-neutrality (ADR 0003): a generic Skill body reads host values from PROJECT.md, so a
  # stack/domain proper noun in a body is leftover coupling the purely-structural checks cannot see.
  # This denylist is deliberately tight and unambiguous to avoid false positives on generic prose, and
  # is scoped to skills/<name>/SKILL.md only (docs/ may legitimately illustrate). Pure-alphabetic
  # tokens match on ASCII-letter word boundaries (so `rspec` matches the standalone word but not
  # "underspecified"); tokens with punctuation match as plain substrings (no benign word contains them).
  HOST_SPECIFIC_TOKENS = [
    "Searchkick", "Elasticsearch", "Pundit", "Devise", "Kamal", "SimpleCov",
    "strong_migrations", "Ransack", "Markaz", "admin_root_path", "SKIP_TITLE_REINDEX",
    "rubocop", "rspec", "brakeman", "bundler-audit", ".claude/rules/", "docs/rules/"
  ].freeze

  # Required PROJECT.md H2 sections (verbatim). This is the parity contract with PROJECT.md.
  # Deliberately a FLOOR, not an inventory: PROJECT.md ships more sections than these (Human Gates,
  # Intake Pipeline, Tool Roster). Those stay out so an already-vendored Host App whose PROJECT.md
  # predates one of them is not reddened by an additive change — each has a shipped default instead.
  REQUIRED_PROJECT_SECTIONS = [
    "## Quality Checks",
    "## Attribution & Model Declaration",
    "## Branch & PR Policy",
    "## Review Severity Framework",
    "## Lifecycle Host",
  ].freeze

  # Human-gate policy (ADR 0025). The settings are a Project Config value read through HumanGates,
  # which returns the shipped strict defaults when `## Human Gates` is absent (see the note above).
  # These Skill bodies act on a gate, so each must NAME the host value — the resident-default rule:
  # a body states the shipped default inline AND points at the override, so it can never hardcode a
  # policy a host overrode, and Copilot (which does not follow links) still receives the instruction.
  GATE_AWARE_SKILLS = %w[assess devise invoke ship final].freeze
  GATE_REFERENCE = "Human Gates"
  # The one merge value that literally expresses UNCONDITIONAL self-merge, and so the only one that
  # earns the policy-boundary message. `attested` is a legal value and never lands here: it is merge
  # on EVIDENCE (an external-model adversarial review bound to the merged SHA), which is the opposite
  # of self-certification (ADR 0037). Every other out-of-set value - `Required`, `optional`, a typo -
  # is a mistake, not a claim, and gets the generic allowed-values message instead of an accusation.
  SELF_MERGE_VALUE = "auto"

  # A Project Config that ANNOUNCES a rule it cannot enforce is worse than one that omits it: agents
  # read the prose as authoritative while the checker reads only the value, so the two drift silently
  # and the build stays green the whole time. This is exactly how the nadal merge-autonomy delta went
  # unnoticed across ten PRs. Any heading that markets itself as recorded-but-inert is therefore an
  # ERROR, not a permitted escape hatch: express the rule as a value this checker parses, or track it
  # as an issue - never as a section of PROJECT.md that looks binding and is not (ADR 0037).
  UNENFORCED_HEADING = /not machine-enforced|recorded, not enforced|non-binding/i.freeze

  # Reviewer declaration (ADR 0026). Same pattern as the gate policy above: the value is a Project
  # Config value read through Reviewer, which returns the shipped defaults when `## Reviewer` is
  # absent, and these Skill bodies act on it so each must NAME it.
  #
  # `verify` owns the summons; `listen` consumes what the Reviewer produced; `final` reports the
  # backstop's status in the SOW; `ship` sequences all three and states the faithfulness backstop.
  REVIEWER_AWARE_SKILLS = %w[verify listen final ship].freeze
  # The EMPHASIZED POINTER FORM, deliberately - not the bare word. "Reviewer" appears throughout this
  # repo's prose (the lifecycle role is named constantly), so asserting the bare word would pass on
  # any body that merely MENTIONS the role: green on arrival, and blind to the reference actually
  # being dropped. The emphasized form is what a PROJECT.md pointer looks like here
  # (`PROJECT.md` -> *Reviewer*), so it only appears when a body really routes at the host value.
  REVIEWER_REFERENCE = "*Reviewer*"
  # ...matched as a REGEX, not a substring. `**Reviewer**` CONTAINS `*Reviewer*`, so a plain
  # `include?` is satisfied by ordinary bold prose - which the lifecycle standard already writes - and
  # the check then passes on a body that hardcodes a reviewer harness and a literal window instead of
  # reading the host value. That is the exact defect this assertion exists to prevent, so the guard
  # has to reject an adjacent `*` on either side (Reviewer finding, PR #117).
  REVIEWER_REFERENCE_RE = /(?<!\*)\*Reviewer\*(?!\*)/.freeze

  # Branch-protection guardrails (ADR 0009). Checked only for a bundle that ships them — signalled by
  # the derived sidecar's presence — so minimal fixture bundles are unaffected.
  SIDECAR = ".githooks/protected-branches"
  GUARDRAIL_FILES = [
    ".githooks/pre-commit", ".githooks/pre-push", ".githooks/pre-merge-commit", ".githooks/pre-rebase",
    "bin/guard-protected-branch", "bin/install-git-hooks", "bin/protected-branches",
    ".claude/hooks/enforce-branch-creation.sh", ".claude/hooks/enforce-clean-tree.sh",
    ".claude/settings.json"
  ].freeze

  # Claude Code's hook configuration. A guardrail hook that ships under .claude/hooks/ but is not WIRED
  # into this file as a PreToolUse hook is dead — it never runs, and the gate stays green while the
  # protection is silently absent (ADR 0009 / ADR 0031). check_hooks_wired asserts every shipped
  # guardrail .sh hook is referenced by a PreToolUse command here.
  SETTINGS_JSON = ".claude/settings.json"

  IMPORT_TOKEN = /(?:^|\s)@AGENTS\.md(?:\s|$)/.freeze
  # Markers are only recognized when alone on their own line — so prose that *describes* a marker
  # (e.g. inside a backtick span in documentation) is never mistaken for a real one.
  NATIVE_MARKER = /\A<!--\s*parity:native\s+source=AGENTS\.md\s*-->\z/.freeze
  RENDER_OPEN = /\A<!--\s*parity:render\s+source=AGENTS\.md\s*-->\z/.freeze
  RENDER_CLOSE = /\A<!--\s*parity:endrender\s*-->\z/.freeze
  # A markdown code fence: three or more backticks or tildes, plus an optional info string (```md).
  # Matched against the STRIPPED line, so a fence indented inside a list item is still recognized.
  FENCE_LINE = /\A(`{3,}|~{3,})(.*)\z/.freeze

  def initialize(root)
    @root = root
    @errors = []
  end

  def run
    check_canonical_exists
    check_import_adapters
    check_copilot_adapter
    check_rendered_regions
    check_project_sections
    check_human_gates
    check_unenforced_headings
    check_reviewer
    check_rules
    check_skills
    check_guardrails
    check_hooks_wired
    check_guides
    check_adr_numbering
    check_links
    report
    @errors.empty? ? 0 : 1
  end

  private

  def path(rel) = File.join(@root, rel)
  def exist?(rel) = File.file?(path(rel))
  def read(rel) = File.read(path(rel), encoding: "UTF-8")
  def err(msg) = @errors << msg

  def check_canonical_exists
    if !exist?(CANONICAL)
      err("Canonical Source missing: #{CANONICAL} not found")
    elsif read(CANONICAL).strip.empty?
      err("Canonical Source empty: #{CANONICAL} has no content")
    end
  end

  def check_import_adapters
    IMPORT_ADAPTERS.each do |adapter|
      unless exist?(adapter)
        err("Import Adapter missing: #{adapter} not found")
        next
      end
      body = read(adapter)
      next if body.match?(IMPORT_TOKEN)

      # No `@AGENTS.md` import: allowed only for a native-capable adapter that declares native discovery
      # (a `parity:native source=AGENTS.md` marker) — the context.fileName / Antigravity-native path.
      if NATIVE_CAPABLE_ADAPTERS.include?(adapter)
        next if body.lines.any? { |l| l.strip.match?(NATIVE_MARKER) }

        err("Adapter #{adapter} neither imports the Canonical Source (`@#{CANONICAL}`) nor declares " \
            "native discovery (expected an `@#{CANONICAL}` line or a `parity:native source=#{CANONICAL}` marker)")
      else
        err("Import Adapter #{adapter} does not import the Canonical Source (expected an `@#{CANONICAL}` line)")
      end
    end
    # The import target itself must exist (a dangling `@AGENTS.md` is drift).
    err("Import target missing: adapters reference @#{CANONICAL} but #{CANONICAL} not found") unless exist?(CANONICAL)
  end

  def check_copilot_adapter
    unless exist?(COPILOT_ADAPTER)
      err("Copilot Adapter missing: #{COPILOT_ADAPTER} not found")
      return
    end
    marker_lines = read(COPILOT_ADAPTER).lines.map(&:strip)
    native = marker_lines.any? { |l| l.match?(NATIVE_MARKER) }
    render = marker_lines.any? { |l| l.match?(RENDER_OPEN) }
    unless native || render
      err("Copilot Adapter #{COPILOT_ADAPTER} has neither a `parity:native` marker nor a `parity:render` block")
    end
    # If it declares a render block, check_rendered_regions verifies the byte-match.
  end

  # Any file carrying a parity:render block must reproduce AGENTS.md byte-for-byte in that region.
  def check_rendered_regions
    return unless exist?(CANONICAL)

    canonical = read(CANONICAL)
    LINK_CHECKED.each do |rel|
      next unless exist?(rel)

      body = read(rel)
      lines = body.lines
      # DETECT markers on code-stripped lines, but CAPTURE from the original ones. Widening
      # LINK_CHECKED widened this scan too, so a doc that legitimately SHOWS a `parity:render` block
      # inside a fenced example would otherwise fail with a confusing "no endrender close". The
      # existing "alone on its own line" rule only defeats an inline backtick mention, not a fence.
      # strip_code preserves line count (a stripped fence line becomes a bare newline), so the indices
      # below address the same lines in both arrays.
      scan = strip_code(body).lines
      open_i = scan.index { |l| l.strip.match?(RENDER_OPEN) }
      next unless open_i

      close_i = scan[(open_i + 1)..].index { |l| l.strip.match?(RENDER_CLOSE) }
      if close_i.nil?
        err("Rendered region in #{rel} opens with `parity:render` but has no `parity:endrender` close")
        next
      end
      close_i += open_i + 1
      captured = lines[(open_i + 1)...close_i].join
      if captured != canonical
        err("Rendered region in #{rel} does not match #{CANONICAL} byte-for-byte (drift)")
      end
    end
  end

  def check_project_sections
    unless exist?(PROJECT_CONFIG)
      err("Project Config missing: #{PROJECT_CONFIG} not found")
      return
    end
    headings = read(PROJECT_CONFIG).lines.map(&:rstrip)
    REQUIRED_PROJECT_SECTIONS.each do |section|
      err("Project Config #{PROJECT_CONFIG} missing required section: `#{section}`") unless headings.include?(section)
    end
  end

  # Human-gate policy (ADR 0025). PROJECT.md declares which lifecycle pauses require a human; the
  # generic Skill bodies read it instead of hardcoding a policy. Two invariants, both value-level (the
  # per-body "does it NAME the value" invariant lives in check_skills, behind the skills/ gate):
  #   (1) UNCONDITIONAL SELF-MERGE IS STILL FORBIDDEN - `auto` gets its own message because it is a
  #       policy boundary, not a typo. `required` (a human merges) and `attested` (the AC merges on a
  #       SHA-bound external review) are both legal. Any OTHER bad merge value - including a case slip
  #       like `Required` - is a typo, so it takes the generic message below: a capitalization mistake
  #       must never be reported as if the host had claimed the right to self-merge.
  #   (2) Any other out-of-set value is reported with the allowed set, never coerced to a default.
  # A PROJECT.md with no `## Human Gates` section parses to the shipped strict defaults and passes.
  def check_human_gates
    return unless exist?(PROJECT_CONFIG)

    gates = HumanGates.extract(read(PROJECT_CONFIG))
    self_merge = gates[:merge] == SELF_MERGE_VALUE

    if self_merge
      allowed = HumanGates::ALLOWED[:merge].map { |v| "`#{v}`" }.join(", ")
      err("Human-gate policy: #{PROJECT_CONFIG} declares `merge: #{gates[:merge]}` - allowed values " \
          "are #{allowed} (no Host App may express UNCONDITIONAL self-merge; use `attested` to let " \
          "the AC merge on a SHA-bound external-model adversarial review, or `required` for a human)")
    end

    HumanGates.invalid(gates).each do |key, value|
      next if key == :merge && self_merge # already reported above, with the specific message

      allowed = HumanGates::ALLOWED[key].map { |v| "`#{v}`" }.join(", ")
      err("Human-gate policy: #{PROJECT_CONFIG} declares an unknown value `#{value}` for " \
          "`#{key.to_s.tr('_', '-')}` - allowed values are #{allowed}")
    end
  end

  # A rule announced in PROJECT.md prose but not expressed as a value this checker parses is not a
  # rule - it is drift with a green build. Agents read the section as authoritative; the checker reads
  # only the table; nothing reconciles them. Ban the escape hatch outright rather than trusting each
  # author to notice, because the whole point of the failure is that it LOOKS handled (ADR 0037).
  def check_unenforced_headings
    return unless exist?(PROJECT_CONFIG)

    read(PROJECT_CONFIG).lines.each_with_index do |line, i|
      next unless line.start_with?("#")
      next unless line.match?(UNENFORCED_HEADING)

      err("Project Config #{PROJECT_CONFIG}:#{i + 1} declares a rule it cannot enforce: " \
          "`#{line.strip}`. A rule that only exists as prose is read as binding by every agent and " \
          "by nothing else - express it as a value this checker parses, or track it as an issue")
    end
  end

  # Reviewer declaration (ADR 0026). PROJECT.md declares the independent second-model reviewer the
  # lifecycle summons; the generic Skill bodies read it instead of naming a harness. Two invariants,
  # both value-level (the per-body "does it NAME the value" invariant lives in check_skills):
  #   (1) THE DEGRADATION FLOOR IS NOT CONFIGURABLE - `stop-and-ask` is its only legal value, so no
  #       Host App can express "deliver unreviewed". It gets its own message because it is a policy
  #       boundary, not a typo: a run that cannot obtain an independent review must not be able to
  #       certify itself (ADR 0026 decision 3, affirming ADR 0005's faithfulness backstop).
  #   (2) The bounded window must be a positive integer + unit, so "wait for the window" is executable.
  #       A window that cannot be parsed is the defect that closed PR #109: prose where a value belongs.
  # A PROJECT.md with no `## Reviewer` section parses to the shipped defaults and passes.
  def check_reviewer
    return unless exist?(PROJECT_CONFIG)

    text = read(PROJECT_CONFIG)
    fields = Reviewer.extract(text)
    bad = Reviewer.invalid(fields)

    if bad.key?(:degradation_floor)
      err("Reviewer declaration: the degradation floor is NOT configurable - #{PROJECT_CONFIG} " \
          "declares `degradation-floor: #{safe(fields[:degradation_floor])}` but " \
          "`#{Reviewer::FLOOR_VALUE}` is its only allowed value (a run that cannot obtain an " \
          "independent review may not certify itself; the AC stops and asks the HC)")
    end

    if bad.key?(:bounded_window)
      err("Reviewer declaration: #{PROJECT_CONFIG} declares an unparseable bounded window " \
          "`#{safe(fields[:bounded_window])}` - expected a positive integer plus a unit of `s`, `m` " \
          "or `h` (e.g. `30m`); a window the AC cannot parse is not a bounded wait")
    end

    # (3) An AUTHORED but unreadable cell. Without this the two checks above are enforced only against
    # BACKTICKED downgrades: a host writing the value as bare prose gets the shipped default handed
    # back to the checker while the table the AC actually reads says something else - green, and
    # wrong in the unsafe direction. Reported per field, and deliberately NOT coerced.
    Reviewer.unreadable(text).each do |key, cell|
      # A blank cell and a prose cell are the same fault - a present row the parser cannot read - but
      # they read very differently to a human, so the message names which one it found.
      wrote = cell.empty? ? "leaves its setting cell blank" : "sets it to `#{safe(cell)}`"
      err("Reviewer declaration: #{PROJECT_CONFIG} authors a `#{key.to_s.tr('_', '-')}` row but " \
          "#{wrote}, which carries no backticked value - the checker therefore read the shipped " \
          "default `#{safe(Reviewer::DEFAULTS[key])}` while the table an agent reads says otherwise " \
          "(write the value in backticks, e.g. `#{safe(Reviewer::DEFAULTS[key])}`)")
    end

    # (3b) An AUTHORED cell offering MORE THAN ONE backticked value - a DIFFERENT fault from (3), and
    # invisible to every other check here. `Reviewer.extract` reads the FIRST span and stops, so a
    # list authored one code span per element (`` `Copilot`, `Gemini` `` - the very convention this
    # file uses for its protected-branch list) silently loses everything after the first: the cell is
    # backticked, so (3) is satisfied; and (1), (2) and (4) all run against the truncated read, so a
    # `fallback-order` of `` `Copilot`, `Codex` `` under a `Codex` primary passes the self-reference
    # invariant that the table plainly violates. Reported so the host learns the checker read
    # something narrower than what their table shows.
    Reviewer.ambiguous(text).each do |key, cell|
      first = cell[Reviewer::BACKTICKED, 1].to_s.strip
      err("Reviewer declaration: #{PROJECT_CONFIG} authors a `#{key.to_s.tr('_', '-')}` row whose " \
          "setting cell #{safe(cell)} carries MORE THAN ONE backticked value - the checker reads " \
          "only the FIRST (`#{safe(first)}`) and every value after it is invisible to every check " \
          "above, so this row is validated as something narrower than the table shows (author the " \
          "whole value inside a SINGLE pair of backticks, e.g. `Copilot, Gemini`)")
    end

    check_reviewer_chain(text, fields, bad)
  end

  # (4) THE CHAIN ITSELF (ADR 0027). The checks above validate each field in isolation; these validate
  # the chain the fields describe - that it names harnesses at all, and that each one can actually be
  # summoned. Before this, `primary: Not A Configured Harness, fallback_order: none, , Nope` returned
  # `{}` from Reviewer.invalid and shipped green while naming a reviewer nobody could reach.
  #
  # NO `section?` GUARD IS NEEDED HERE, and adding one would be unkillable dead code. A PROJECT.md
  # with no `## Reviewer` section parses to the shipped DEFAULTS, which are a well-formed chain
  # (`test_defaults_are_themselves_valid` pins that), so none of the four shape faults can fire; and
  # `Reviewer.unsummonable` carries the guard itself, because it is the one check an absent section
  # would otherwise trip on every vendored host. The vendored-host contract is asserted directly, at
  # both levels, by test_baseline_without_reviewer_section_passes and its sibling.
  def check_reviewer_chain(text, fields, bad)
    if bad.key?(:primary_blank)
      err("Reviewer declaration: #{PROJECT_CONFIG} declares an empty `primary` - the chain has no " \
          "first entry, so there is nobody to summon at the PR gate (name a harness with a row in " \
          "Reviewer -> Invocation paths)")
    end

    if bad.key?(:fallback_order_blank_element)
      # One key, two shapes a human reads very differently - a list with a hole in it, and a value
      # that is nothing at all. The message names which one it found, mirroring the unreadable-cell
      # message above; the shared key is correct because the FAULT is the same (a fallback entry that
      # names no harness) and splitting it would report one defect under two headings.
      raw = bad[:fallback_order_blank_element]
      found = if raw.to_s.strip.empty?
                "declares a `fallback-order` that is entirely BLANK - the fallback is silently " \
                  "dropped from the chain, so the primary is the only reviewer that will ever be tried"
              else
                "declares `fallback-order: #{safe(raw)}`, which has an EMPTY element - a stray or " \
                  "trailing comma reads as a fallback entry that names no harness"
              end
      err("Reviewer declaration: #{PROJECT_CONFIG} #{found} (name a harness with a row in " \
          "Reviewer -> Invocation paths, or write `none` alone for no fallback)")
    end

    if bad.key?(:fallback_order_none_mixed)
      err("Reviewer declaration: #{PROJECT_CONFIG} declares `fallback-order: " \
          "#{safe(bad[:fallback_order_none_mixed])}`, which mixes `none` with real entries - `none` " \
          "means NO fallback and is only legal alone, so this declaration is ambiguous about " \
          "whether the chain continues")
    end

    if bad.key?(:fallback_order_self_reference)
      err("Reviewer declaration: #{PROJECT_CONFIG} repeats the primary " \
          "`#{safe(bad[:fallback_order_self_reference])}` in its own `fallback-order` - a chain that " \
          "falls back to itself is not a fallback, and a reviewer cannot be its own independent " \
          "backstop")
    end

    Reviewer.unsummonable(text).each do |entry|
      err("Reviewer declaration: #{PROJECT_CONFIG} names `#{safe(entry)}` in the reviewer chain but " \
          "Reviewer -> Invocation paths declares no summons mechanism for it - the AC has no way to " \
          "reach it, so the chain falls straight past it to the degradation floor " \
          "`#{Reviewer::FLOOR_VALUE}` (add a row for it, or remove it from the chain)")
    end
  end

  # Render an author-controlled value ASCII-safe for stdout (ADR 0011). Any byte outside printable
  # ASCII becomes an escape, so a stray control character, ANSI sequence or non-ASCII glyph in
  # PROJECT.md cannot reach the terminal verbatim through an error message. Applied to the values
  # check_reviewer interpolates; issue #113 tracks doing the same for the older checks.
  def safe(value)
    value.to_s.gsub(/[^\x20-\x7E]/) { |c| format("\\x%02X", c.ord) }
  end

  # Tier-1 Rules Layer (ADR 0004). Runs only when the bundle ships a rules/ tree, so a minimal bundle
  # without the Rules Layer is unaffected (the same gate stance as check_guardrails). Three invariants
  # per rule file: (1) it exists, (2) AGENTS.md references it (the Lean Core must be reachable from the
  # Canonical Source so every tool receives it), and (3) it declares each required section — presence
  # of the heading, not its content, so a host freely extends the body.
  def check_rules
    return unless Dir.exist?(path(RULES_DIR))

    agents = exist?(CANONICAL) ? read(CANONICAL) : ""
    REQUIRED_RULES.each do |rel|
      unless exist?(rel)
        err("Tier-1 rule missing: #{rel} not found")
        next
      end
      unless agents.include?(rel)
        err("Tier-1 rule #{rel} is not referenced by #{CANONICAL} (the Lean Core must be reachable from the Canonical Source)")
      end
      headings = read(rel).lines.map(&:rstrip)
      RULE_REQUIRED_SECTIONS.each do |section|
        err("Tier-1 rule #{rel} missing required section: `#{section}`") unless headings.include?(section)
      end
    end
  end

  # Skills Layer (ADR 0003 / ADR 0010). Runs only when the bundle ships a skills/ tree, so a minimal
  # bundle is unaffected (the same gate stance as check_rules). Two tiers:
  #   (1) Floor  — every REQUIRED_SKILLS entry has skills/<name>/SKILL.md (the expected skill ships).
  #   (2) Shape  — EVERY present skills/<name>/ dir must have: a SKILL.md, that SKILL.md carrying
  #                PARSEABLE YAML frontmatter with a `name:` matching the directory and a
  #                `description:` (see check_body_frontmatter), a paired Claude shim
  #                .claude/commands/<name>.md, that shim referencing the canonical body (so a hollow
  #                stub can't pass) and — if and only if it opens one — carrying parseable frontmatter
  #                of its own (see check_shim_frontmatter), and a reference to skills/<name>/SKILL.md
  #                in AGENTS.md (the documented invocation the native-discovery tools reach). Applying
  #                the shape to every present dir is what makes the check cover skills a later issue
  #                adds without editing this list.
  #   (3) Neutrality — no HOST_SPECIFIC_TOKENS in any present body, and every LIFECYCLE_SKILLS body
  #                references PROJECT.md. This is the one content check (ADR 0003): the structural
  #                invariants can't see a leftover stack/domain token or a hardcoded quality check.
  def check_skills
    return unless Dir.exist?(path(SKILLS_DIR))

    agents = exist?(CANONICAL) ? read(CANONICAL) : ""

    REQUIRED_SKILLS.each do |name|
      err("Required skill missing: #{SKILLS_DIR}/#{name}/SKILL.md not found") unless exist?("#{SKILLS_DIR}/#{name}/SKILL.md")
    end

    present_skills.each do |name|
      body_rel = "#{SKILLS_DIR}/#{name}/SKILL.md"
      unless exist?(body_rel)
        err("Skill #{name} missing its canonical body: #{body_rel} not found")
        next
      end
      body = read(body_rel)
      check_body_frontmatter(name, body_rel, body)

      shim_rel = "#{CLAUDE_COMMANDS_DIR}/#{name}.md"
      if !exist?(shim_rel)
        err("Skill #{name} missing its Claude Invocation Shim: #{shim_rel} not found")
      else
        shim = read(shim_rel)
        unless shim.include?(body_rel)
          err("Claude Invocation Shim #{shim_rel} does not reference its canonical body (expected `#{body_rel}`)")
        end
        check_shim_frontmatter(shim_rel, shim)
      end

      unless agents.include?(body_rel)
        err("Skill #{name} is not referenced by #{CANONICAL} (the documented invocation must be reachable from the Canonical Source)")
      end

      # Content-neutrality: no host-specific token in ANY Skill body (structural checks can't see it) …
      HOST_SPECIFIC_TOKENS.each do |token|
        next unless host_token?(body, token)

        err("Skill #{name}: #{body_rel} contains host-specific token `#{token}` (a generic Skill body " \
            "must read host values from #{PROJECT_CONFIG}, not name a stack/domain)")
      end

      # … and every lifecycle Skill must route its host values through the Project Config.
      if LIFECYCLE_SKILLS.include?(name) && !body.include?(PROJECT_CONFIG)
        err("Lifecycle Skill #{name}: #{body_rel} does not reference #{PROJECT_CONFIG} (it must read " \
            "quality checks / attribution / severities / lifecycle host from Project Config, not hardcode them)")
      end

      # … and every gate-aware Skill must NAME the Human Gates host value (ADR 0025). This verifies
      # the REFERENCE, not the prose's semantic agreement with the setting - see the ADR's limits.
      if GATE_AWARE_SKILLS.include?(name) && !body.include?(GATE_REFERENCE)
        err("Gate-aware Skill #{name}: #{body_rel} does not name the `#{GATE_REFERENCE}` host value " \
            "(a body that acts on a human gate must state the shipped default inline AND read the " \
            "override from #{PROJECT_CONFIG} -> #{GATE_REFERENCE}, never hardcode a gate policy)")
      end

      # … and every reviewer-aware Skill must NAME the Reviewer host value (ADR 0026). Same shape and
      # same limit as the gate assertion above: this verifies the REFERENCE, not that the body's prose
      # agrees with the declaration.
      if REVIEWER_AWARE_SKILLS.include?(name) && !body.match?(REVIEWER_REFERENCE_RE)
        err("Reviewer-aware Skill #{name}: #{body_rel} does not name the `#{REVIEWER_REFERENCE}` host " \
            "value (a body that summons, consumes or reports the second-model review must state the " \
            "shipped default inline AND read the override from #{PROJECT_CONFIG} -> Reviewer, never " \
            "name a reviewer harness)")
      end
    end
  end

  # A Skill body's frontmatter: it must EXIST, parse to a mapping, carry a non-empty `name:` that
  # agrees with the directory, and carry a non-empty `description:`. The name/directory assertion is
  # the identity invariant — a body whose `name:` disagrees with its own directory no longer describes
  # the same Skill as its shim, and the rename work (#73) leaned on that agreement with no gate behind it.
  def check_body_frontmatter(name, body_rel, body)
    subject = "Skill #{name}: #{body_rel}"
    state, payload = frontmatter(body, body_rel)

    if (msg = malformed_frontmatter_error(subject, state, payload))
      return err(msg)
    end
    # The missing-fence message is preserved VERBATIM: that mode was already correct and already
    # tested, so tightening the rest of the check must cost it zero churn.
    return err("#{subject} lacks YAML frontmatter with a `name:` key") if state == :none

    declared = payload["name"]
    if !declared.is_a?(String) || declared.strip.empty?
      err("#{subject} lacks YAML frontmatter with a `name:` key")
    elsif declared.strip != name
      err("#{subject} declares `name: #{ascii_safe(declared.strip)}` but lives in #{SKILLS_DIR}/#{name}/ (a body " \
          "whose frontmatter name disagrees with its directory no longer describes the same Skill as " \
          "its shim, and tools select by that name)")
    end

    description = payload["description"]
    return if description.is_a?(String) && !description.strip.empty?

    err("#{subject} lacks a non-empty `description:` in its frontmatter (tools SELECT a Skill by its " \
        "description; without one the Skill is discoverable but never chosen)")
  end

  # A Claude Invocation Shim's frontmatter, held to a DELIBERATELY SOFTER rule than the body's:
  # parse-if-present. Only :none passes — genuinely absent frontmatter stays allowed, because the
  # bundle has never required it and reddening a Host App for a style it was never asked to adopt is a
  # false red. But any block that IS opened must be well-formed on every host: for Claude Code the shim
  # is the invocation path, so a broken one is a dead slash command.
  def check_shim_frontmatter(shim_rel, shim)
    subject = "Claude Invocation Shim #{shim_rel}"
    state, payload = frontmatter(shim, shim_rel)

    if (msg = malformed_frontmatter_error(subject, state, payload))
      return err(msg)
    end
    return unless state == :ok

    description = payload["description"]
    return if description.is_a?(String) && !description.strip.empty?

    err("#{subject} carries frontmatter but no non-empty `description:` (a shim that declares " \
        "frontmatter at all must describe what it invokes; omit the block entirely if it has nothing to say)")
  end

  # True when `token` appears in `body` as a host-specific mention. Pure-alphabetic tokens require
  # ASCII-letter word boundaries (so `rspec` matches the standalone word but not "underspecified");
  # tokens carrying punctuation (paths, `bundler-audit`, `admin_root_path`) match as plain substrings.
  def host_token?(body, token)
    if token.match?(/\A[A-Za-z]+\z/)
      body.match?(/(?<![A-Za-z])#{Regexp.escape(token)}(?![A-Za-z])/)
    else
      body.include?(token)
    end
  end

  # Names of every skills/<name>/ subdirectory that actually ships a body dir (ignores stray files).
  def present_skills
    Dir.children(path(SKILLS_DIR))
       .select { |c| Dir.exist?(File.join(path(SKILLS_DIR), c)) }
       .sort
  end

  # Parses `content`'s YAML frontmatter (--- … ---), returning a discriminated `[state, payload]` so
  # each frontmattered surface can phrase its own message. The frontmatter is PARSED, never regexed:
  # a regex proves the text *looks* parseable while every consuming tool needs it to *be* parseable,
  # and that gap ships green (issue #103 — an unquoted `": "` in a prose `description:`).
  #
  #   [:none, nil]                — genuinely absent: no opening `---` fence at all.
  #   [:unterminated, nil]        — an opening `---` with no closing fence.
  #   [:invalid, message]         — fenced and closed, but Psych raised.
  #   [:non_mapping, class_name]  — parsed, but the root is not a Hash (an empty block yields nil).
  #   [:ok, hash]                 — parsed to a Hash.
  #
  # :none and :unterminated are kept APART deliberately. Collapsing them is how the shim's "absent
  # frontmatter is allowed" rule silently becomes "broken frontmatter is allowed" — the false green a
  # Reviewer caught in this check's own plan.
  #
  # Both fences are matched with FRONTMATTER_FENCE, which requires column 0. Stripping indentation
  # before comparing would let a `---` inside a YAML block scalar close the block early: the remainder
  # is then never handed to the parser, so malformed YAML *after* the indented line passes the gate —
  # the same false green in a new disguise. The truncation also cut the other way, emptying a
  # legitimate block-scalar value and reddening a valid file. Match at root level and both go away.
  #
  # Two message-quality details, both verified against Psych rather than assumed: Psych numbers lines
  # within the string it is handed, so parsing the fence-stripped block alone would report a line the
  # author cannot find in the file — padding with one blank line per stripped line (blank lines are
  # valid YAML) shifts its counter into agreement with the file. And `filename:` replaces Psych's
  # useless `(<unknown>)` prefix with the real path. Both keep the output ASCII (ADR 0011): Psych
  # reports line/column and never echoes the offending source, whose prose carries em dashes.
  #
  # `safe_load`'s default `permitted_classes` and `aliases: false` are passed explicitly — a
  # deliberate choice, not an inherited default. Skill frontmatter is plain scalars; a future key that
  # genuinely needs a Date should be a reviewed widening. A date-shaped scalar therefore raises
  # Psych::DisallowedClass, which shares Psych::Exception with SyntaxError and so needs no second
  # branch, and the :invalid message says what to do about it.
  def frontmatter(content, rel)
    lines = content.lines
    first = lines.index { |l| !l.strip.empty? }
    return [:none, nil] if first.nil? || !lines[first].match?(FRONTMATTER_FENCE)

    close = lines[(first + 1)..].index { |l| l.match?(FRONTMATTER_FENCE) }
    return [:unterminated, nil] if close.nil?

    block = lines[(first + 1)...(first + 1 + close)].join
    data = YAML.safe_load(("\n" * (first + 1)) + block, filename: rel, aliases: false)
    data.is_a?(Hash) ? [:ok, data] : [:non_mapping, data.class.name]
  rescue Psych::Exception => e
    [:invalid, e.message]
  end

  # Renders an AUTHOR-CONTROLLED value safe for stdout (ADR 0011 / `rules/scripting.md`). A
  # frontmatter `name:` is authored text and may legitimately carry non-ASCII, but a Host App or CI
  # runner on a non-UTF-8 locale raises `invalid byte sequence` the moment it reads or matches the
  # output. `String#dump` escapes every non-ASCII character to a `\u{...}` form, so the value stays
  # diagnostic (the author can still see which name was declared) while the stream stays ASCII.
  #
  # Scoped deliberately to values this check newly puts on stdout. Interpolated PATHS are not routed
  # through it: every `err` in this file already interpolates a rel path, so a non-ASCII path is a
  # pre-existing, repo-wide exposure rather than one introduced here, and widening this fix to ~30
  # call sites belongs to its own change.
  def ascii_safe(value)
    value.ascii_only? ? value : value.dump
  end

  # The malformed-frontmatter message shared by both frontmattered surfaces (a Skill body and its
  # Claude Invocation Shim), prefixed with the caller's `subject`. Returns nil for :none and :ok — the
  # two states whose handling legitimately DIFFERS per surface (a body must carry frontmatter; a shim
  # need not), so they stay with the caller. Every malformed state is an error on every surface.
  def malformed_frontmatter_error(subject, state, payload)
    case state
    when :unterminated
      "#{subject} opens a frontmatter block with `---` but never closes it (an unterminated block is " \
        "not readable frontmatter, so no tool can discover this Skill)"
    when :invalid
      "#{subject} has unparseable YAML frontmatter: #{payload} (the frontmatter is how every tool " \
        "discovers the Skill, so a broken one ships green here and silently undiscoverable there -- " \
        'quote any value containing a colon-space, e.g. `description: "Stage 3: implement"`)'
    when :non_mapping
      found = payload == "NilClass" ? "an empty block" : "a YAML #{payload}"
      "#{subject} frontmatter is not a key/value mapping (parsed as #{found}); frontmatter must be " \
        "`key: value` pairs"
    end
  end

  # Branch-protection guardrails (ADR 0009). Runs only when the derived sidecar is present, so a
  # minimal bundle without guardrails is unaffected. Two invariants: (1) the guardrail files exist,
  # and (2) the committed sidecar equals the list derived from PROJECT.md — closing the staleness
  # hole that a generated-then-committed artifact would otherwise open.
  def check_guardrails
    return unless exist?(SIDECAR)

    GUARDRAIL_FILES.each do |f|
      err("Guardrail file missing: #{f} not found") unless exist?(f)
    end

    unless exist?(PROJECT_CONFIG)
      err("Guardrails present but #{PROJECT_CONFIG} is missing (cannot verify the protected-branch list)")
      return
    end

    derived = ProtectedBranches.from_file(path(PROJECT_CONFIG))
    # Read the sidecar the same way the guards do (skip blank + `#` comment lines) so a hand-added
    # comment never reads as drift — the machine-generated sidecar has none, but the three readers
    # must stay consistent.
    committed = read(SIDECAR).lines.map(&:strip).reject { |l| l.empty? || l.start_with?("#") }
    if derived != committed
      err("Protected-branch sidecar drift: #{SIDECAR} has #{committed.inspect} but PROJECT.md derives " \
          "#{derived.inspect} - run bin/install-git-hooks to regenerate it")
    end
  end

  # Hook wiring (ADR 0009 / ADR 0031, issues #136). A guardrail hook that ships under .claude/hooks/ but
  # is not WIRED into .claude/settings.json as a PreToolUse hook never runs — a present-but-unwired hook
  # is a false green: the gate passes while the protection is silently absent. For every GUARDRAIL_FILES
  # entry under .claude/hooks/ ending in .sh that is actually SHIPPED, assert settings.json declares a
  # PreToolUse hook whose command references that hook's basename AND whose `matcher` covers `Bash`.
  # The matcher check is load-bearing: both guardrail hooks gate git commands, which arrive as the Bash
  # tool, so a hook wired only under a non-Bash matcher (e.g. `"Read"`) references the right basename yet
  # NEVER fires on `git reset --hard` — a bare "is it referenced anywhere" check would pass it while the
  # guard is silently dead. `matcher.include?("Bash")` accepts the shipped forms (`"Bash"` and
  # `"Write|Edit|MultiEdit|NotebookEdit|Bash"`). Gated on the hooks actually being present (not on the
  # sidecar), so a bundle that ships no such hooks — or a Host App that vendored settings.json but not
  # the guardrail hooks — is unaffected.
  def check_hooks_wired
    hook_files = GUARDRAIL_FILES.select { |f| f.start_with?(".claude/hooks/") && f.end_with?(".sh") && exist?(f) }
    return if hook_files.empty?

    unless exist?(SETTINGS_JSON)
      err("Hook wiring: guardrail hooks ship under .claude/hooks/ but #{SETTINGS_JSON} is missing - the " \
          "PreToolUse hooks are not wired, so none of them run")
      return
    end

    settings = begin
      JSON.parse(read(SETTINGS_JSON))
    rescue JSON::ParserError => e
      err("Hook wiring: #{SETTINGS_JSON} is not valid JSON (#{e.message}) - cannot verify the PreToolUse " \
          "hooks are wired")
      return
    end

    pretooluse = settings.dig("hooks", "PreToolUse")
    blocks = pretooluse.is_a?(Array) ? pretooluse : []

    hook_files.each do |rel|
      base = File.basename(rel)
      # Wired == referenced by a command IN A BLOCK whose matcher covers Bash. A block whose matcher
      # does not include "Bash" cannot fire on a git command, so a reference there does not count.
      wired = blocks.any? do |b|
        b["matcher"].to_s.include?("Bash") &&
          Array(b["hooks"]).any? { |h| h["command"].to_s.include?(base) }
      end
      next if wired

      err("Hook wiring: #{rel} ships but #{SETTINGS_JSON} has no PreToolUse hook under a Bash-covering " \
          "matcher whose command references `#{base}` - a present-but-unwired (or non-Bash-matched) hook " \
          "never runs (wire it under hooks.PreToolUse with a matcher that includes Bash)")
    end
  end

  # Usage guides (issue #11). Runs only when the bundle ships a docs/guides/ tree, so a minimal bundle
  # is unaffected (the same gate stance as check_rules / check_skills). One host-safe invariant per
  # required guide: it exists (is shipped). Its internal links are resolved by check_links (each guide
  # is in LINK_CHECKED). Reachability is intentionally not asserted against README (see REQUIRED_GUIDES).
  def check_guides
    return unless Dir.exist?(path(GUIDES_DIR))

    REQUIRED_GUIDES.each do |rel|
      err("Required guide missing: #{rel} not found") unless exist?(rel)
    end
  end

  # ADR numbering discipline (#133 / #131). Runs only when the bundle ships a docs/adr/ tree, so a
  # minimal bundle without ADRs is unaffected (the same gate stance as check_rules / check_guides). The
  # leading number is parsed from each ADR basename with an explicit base 10: a bare `Integer("0008")`
  # reads the leading zero as octal and raises on an 8 or 9, so the radix is required (`"0008".to_i`
  # would not raise, but the check needs the strict parse, not a silent coercion). Two invariants over
  # those numbers:
  #   (1) UNIQUENESS — no two ADR files may share a leading number (a reserved number authored twice).
  #   (2) CONTIGUITY — the sorted unique numbers must form an unbroken run min..max (no gap).
  # A gap or a duplicate is the tell of a number taken from stale local state; the message points the
  # author at computing the next number from the remote's default branch instead of reserving one ahead
  # of authoring.
  def check_adr_numbering
    return unless Dir.exist?(path(ADR_DIR))

    numbers = Dir.glob("*.md", base: path(ADR_DIR)).filter_map do |name|
      m = name.match(/\A(\d+)/)
      Integer(m[1], 10) if m
    end
    return if numbers.empty?

    # (1) UNIQUENESS — report each number that more than one ADR file carries.
    numbers.tally.select { |_number, count| count > 1 }.each_key do |dup|
      err("ADR numbering: #{ADR_DIR}/ has a duplicate ADR number #{format('%04d', dup)} - two ADRs " \
          "share it (compute the next ADR number from the remote's default branch, never reserve one " \
          "ahead of authoring)")
    end

    # (2) CONTIGUITY — the sorted unique numbers must form an unbroken run; report the first missing
    # number of each gap. Scanning consecutive pairs (rather than materializing min..max) keeps this
    # bounded — a stray large number like 99999999 yields a deterministic "gap at ..." instead of
    # allocating the whole range and hanging the gate.
    unique = numbers.uniq.sort
    unique.each_cons(2) do |lower, higher|
      next if higher == lower + 1

      err("ADR numbering: #{ADR_DIR}/ has a gap at #{format('%04d', lower + 1)} - the numbers must be " \
          "contiguous with no gap (compute the next ADR number from the remote's default branch, never " \
          "reserve one ahead of authoring)")
    end
  end

  # Every repo-relative markdown link in the checked files must resolve to an existing path.
  # Skips external (http/https/mailto) and bare-anchor (#...) links, and — via strip_code — any link
  # that is an ILLUSTRATION rather than a reference (inside a fenced block or an inline-code span).
  def check_links
    link_re = /\[[^\]]*\]\(([^)]+)\)/
    LINK_CHECKED.each do |rel|
      next unless exist?(rel)

      dir = File.dirname(path(rel))
      strip_code(read(rel)).scan(link_re).each do |(target)|
        target = target.strip
        next if target.empty?
        next if target.start_with?("http://", "https://", "mailto:", "#")

        target = target.split("#", 2).first # drop any #anchor fragment
        next if target.nil? || target.empty?

        resolved = File.expand_path(target, dir)
        unless File.exist?(resolved)
          err("Dead link in #{rel}: `#{target}` does not resolve")
        end
      end
    end
  end

  # Returns `content` with every fenced code block and inline-code span blanked out, so a markdown
  # link that exists only as an ILLUSTRATION is never reported dead. A fenced Context Map naming
  # `./src/ordering/CONTEXT.md`, or prose documenting the `[text](path)` convention itself, points at
  # a hypothetical host repo — not this one. Without this, widening LINK_CHECKED (issue #96) would
  # redden real files and teach every author that examples are forbidden.
  #
  # Line-based, no regex lookbehind (stdlib-only, rules/scripting.md). Two passes:
  #   (1) Fences — ``` or ~~~, three or more, with an optional info string (```md). A fence is
  #       stripped ONLY when a matching closer is found. An UNTERMINATED fence is deliberately NOT
  #       treated as a fence: swallowing the rest of the file (the renderer's semantics) would
  #       silently switch link checking off from that point on — a false green, the worst outcome for
  #       a checker. The stray delimiter line is dropped and every later link is still resolved.
  #   (2) Inline spans — a backtick run of length N opens a span closed by the next run of EXACTLY N
  #       (so a double-backtick span may hold a literal backtick). Only the span is blanked, never the
  #       whole line, so `[t](p)` and [real](./x.md) sharing a line still resolves the real link.
  def strip_code(content)
    lines = content.lines
    out = Array.new(lines.length)
    i = 0
    while i < lines.length
      opener = fence_delimiter(lines[i])
      if opener.nil?
        out[i] = strip_inline_code(lines[i])
        i += 1
      elsif (close = closing_fence_index(lines, i + 1, opener))
        (i..close).each { |n| out[n] = "\n" }
        i = close + 1
      else
        out[i] = "\n" # unterminated: a stray delimiter, not a block — keep checking what follows
        i += 1
      end
    end
    out.join
  end

  # The delimiter run of a fence line (``` / ~~~~ / ```md), or nil when the line is not a fence.
  #
  # KNOWN TRADE-OFF: matching `line.strip` means indentation is ignored, which is what lets a fence
  # nested inside a list item be recognized — the common case in these docs. The cost is that a
  # 4-space-indented ``` line, which CommonMark reads as *indented code* rather than a fence, is
  # treated as a fence here; prose carrying a real dead link between two such lines would be blanked
  # and pass. That direction is a FALSE GREEN, so it is the one to know about — it is also contrived,
  # and no file in the bundle is written that way. The sibling limitations all fail the SAFE way, in
  # the red direction: an indented (non-fenced) code block and an HTML-comment block are not
  # recognized as code at all, so an illustrative link inside either is still resolved and reported.
  # Reported noise is recoverable; a silent miss is not. Do not "fix" the indentation handling without
  # re-checking which direction each case then fails in.
  def fence_delimiter(line)
    m = FENCE_LINE.match(line.strip)
    m && m[1]
  end

  # Index of the line that closes the fence opened by `opener`, or nil. A closer uses the SAME fence
  # character, is at least as long, and carries no info string (CommonMark) — so a ~~~ inside a ```
  # block, or a nested longer fence, does not close it early.
  def closing_fence_index(lines, from, opener)
    (from...lines.length).find do |n|
      m = FENCE_LINE.match(lines[n].strip)
      m && m[1][0] == opener[0] && m[1].length >= opener.length && m[2].strip.empty?
    end
  end

  # Blanks each inline-code span in `line`, preserving everything outside it (see strip_code note 2).
  def strip_inline_code(line)
    out = +""
    i = 0
    while i < line.length
      if line[i] != "`"
        out << line[i]
        i += 1
        next
      end

      run = backtick_run(line, i)
      close = closing_backtick_index(line, i + run, run)
      if close.nil?
        out << line[i, run] # an unpaired run is literal text, not a span opener
        i += run
      else
        out << " " * (close + run - i) # blank the span, delimiters included; keep the line's shape
        i = close + run
      end
    end
    out
  end

  # Length of the unbroken backtick run starting at `from`.
  def backtick_run(line, from)
    n = 0
    n += 1 while line[from + n] == "`"
    n
  end

  # Index where the next backtick run of EXACTLY `run` backticks begins at or after `from`, or nil.
  def closing_backtick_index(line, from, run)
    i = from
    while i < line.length
      if line[i] == "`"
        len = backtick_run(line, i)
        return i if len == run

        i += len
      else
        i += 1
      end
    end
    nil
  end

  def report
    if @errors.empty?
      skills = Dir.exist?(path(SKILLS_DIR)) ? present_skills.length : 0
      puts "parity_check: OK - Canonical Source, #{IMPORT_ADAPTERS.length + 1} Adapters, Project Config, " \
           "#{skills} Skill#{'s' if skills != 1}, and links all resolve."
    else
      puts "parity_check: FAILED (#{@errors.length} problem#{'s' if @errors.length != 1})"
      @errors.each { |e| puts "  - #{e}" }
    end
  end
end

if $PROGRAM_NAME == __FILE__
  root = "."
  OptionParser.new do |opts|
    opts.banner = "Usage: ruby scripts/parity_check.rb [--root DIR]"
    opts.on("--root DIR", "Directory to check (default: .)") { |v| root = v }
  end.parse!(ARGV)

  exit ParityCheck.new(root).run
end
