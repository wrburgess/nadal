# frozen_string_literal: true

# protected_branches.rb — the ONE place that derives the protected-branch list from PROJECT.md
# (Option A, issue #6 / ADR 0009). PROJECT.md is the single authored source; the git hooks read a
# generated sidecar (.githooks/protected-branches). Parsing lives here so it is unit-tested once.
#
# THE LAST RUBY READER STANDING, and it is here because it is called (#146). Its two siblings,
# `human_gates.rb` and `reviewer.rb`, were deleted on that issue: their only caller was
# `scripts/parity_check.rb`, which retired at the deuce cutover (deuce #86), leaving 819 lines with
# no caller anywhere in the tree. This file's caller is live and load-bearing —
# `bin/setup` -> `bin/install-git-hooks` -> `bin/protected-branches` -> here — so deleting it would
# silently stop regenerating the sidecar the branch guard reads on a fresh clone.
#
# The "verify no drift" half of this file's job went with parity_check.rb. Nothing now checks that
# the committed sidecar still matches PROJECT.md between runs of bin/install-git-hooks; the
# regeneration on setup is what keeps them together.
#
# Dependency-free: Ruby standard library only (ADR 0008).
#
# Contract with PROJECT.md → "## Branch & PR Policy":
#   - the list is authored on the bullet line beginning `- **Protected branches:**`
#   - every `backticked` token on that line UP TO the first ` — ` (em dash) separator is a protected
#     branch; text after the separator is human prose and is ignored.
#
# Returns [] when the section or the line is absent — callers apply their own fail-closed default.

module ProtectedBranches
  SECTION = "## Branch & PR Policy"
  LINE_PREFIX = "- **Protected branches:**"
  EM_DASH = "—"
  BACKTICKED = /`([^`]+)`/.freeze

  module_function

  # Parse the protected-branch names out of PROJECT.md text. Deterministic and order-preserving.
  def extract(text)
    lines = text.to_s.lines.map(&:chomp)
    start = lines.index { |l| l.strip == SECTION }
    return [] unless start

    line = nil
    lines[(start + 1)..].each do |l|
      break if l.start_with?("## ") # the next H2 ends the section
      if l.strip.start_with?(LINE_PREFIX)
        line = l
        break
      end
    end
    return [] unless line

    head = line.split(" #{EM_DASH} ", 2).first # drop prose after the ` — ` separator
    head.scan(BACKTICKED).flatten.map(&:strip).reject(&:empty?).uniq
  end

  def from_file(path)
    extract(File.read(path, encoding: "UTF-8"))
  end
end
