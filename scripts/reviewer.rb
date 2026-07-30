# frozen_string_literal: true

# reviewer.rb — the ONE place that derives the Reviewer declaration from PROJECT.md (issue #114 /
# ADR 0026). PROJECT.md is the single authored source; `scripts/parity_check.rb` validates what this
# returns. Parsing lives here so it is unit-tested once and reused, mirroring `scripts/human_gates.rb`
# (the human-gate policy, ADR 0025) and `scripts/protected_branches.rb` (ADR 0009).
#
# Dependency-free: Ruby standard library only, mirroring scripts/parity_check.rb (ADR 0008).
#
# Contract with PROJECT.md -> "## Reviewer" — DELIBERATELY IDENTICAL to human_gates.rb's, so the two
# readers cannot drift into disagreeing about what a PROJECT.md table row means:
#   - the fields are authored as a markdown table between that H2 and the next line starting `## `
#   - a row is identified by its FIRST cell starting with the field's label ("Primary", "Fallback
#     order", "Bounded window", "Degradation floor"), ignoring markdown emphasis
#   - the FIRST row matching a field is that field's authored setting; later matching rows are ignored,
#     which is what makes the parse fail-SAFE: a second field-shaped row later in the section (an
#     illustrative example, a copy/paste leftover) can never override the authored one
#   - the value is the first `backticked` token in that row's SETTING cell, located by the header cell
#     named "Setting" and falling back to the SECOND cell when no header names it. Only that one cell
#     is read, so the "Allowed values" cell can never be mistaken for the setting, and reordering the
#     table's columns does not silently change the parse. A cell carrying MORE THAN ONE backticked
#     span is still read as its FIRST — and separately REPORTED by `ambiguous`, because "read the
#     first span" quietly discards the rest of what the host wrote.
#
# NOTE on the sub-table: the "### Invocation paths" table lives inside this section and its rows are
# NOT field rows (their first cells are harness names). They are ignored by construction — ROW_LABELS
# matches no harness name — and its `| Harness | Summons | ... |` header does not name a "Setting"
# column, so it cannot rebind the column either. The `break` on a complete field set makes that
# doubly true in the shipped file.
#
# Fail-SAFE, not fail-closed: when the section (or a row) is absent, the SHIPPED DEFAULT is returned
# rather than [] or nil. The section is additive — an already-vendored Host App whose PROJECT.md
# predates it must keep parsing to the shipped defaults and stay green, which is exactly why the
# heading is deliberately NOT in the parity check's REQUIRED_PROJECT_SECTIONS.
#
# Values are returned VERBATIM: an unknown value is never coerced to a default, so a typo surfaces as
# an invalid value (see `invalid`) instead of silently reading as the shipped policy.

module Reviewer
  SECTION = "## Reviewer"

  # The sub-section declaring HOW each harness is summoned. Parsed by `invocation_paths` on its own
  # independent scan — located WITHIN `## Reviewer` and then anchored on this H3 — never by
  # `extract`/`unreadable`.
  INVOCATION_SECTION = "### Invocation paths"

  # Any markdown ATX heading. `invocation_paths` ends its sub-table scan at the next heading of ANY
  # level: terminating on `## `/`### ` alone let a deeper subheading (`#### Host notes`) carrying a
  # harness-shaped table inject phantom rows into the membership list, so a chain entry named only
  # there read as reachable while parity stayed green.
  #
  # `\#` escapes Ruby's `#{` interpolation — the pattern is a `#` repeated 1-6 times, then whitespace.
  #
  # UP TO THREE LEADING SPACES, per CommonMark: an ATX heading indented 0-3 spaces is still a heading,
  # and four or more is an indented code block. Anchored at column 0 the rule was FAIL-OPEN — a legal
  # `  #### Notes` did not terminate the scan, so a harness-shaped table beneath it was admitted to
  # the membership list and a chain entry named only there read as reachable (Reviewer finding,
  # PR #119). `INDENT` is the shared 0-3 allowance; every heading and boundary rule below uses it.
  INDENT = " {0,3}"
  HEADING = /\A#{INDENT}\#{1,6}\s/.freeze

  # The next H2, which ends the `## Reviewer` section. Same 0-3 space allowance, and DELIBERATELY
  # tighter than the bare `l.start_with?("## ")` that `extract`/`unreadable` use inline: those two are
  # kept byte-identical with scripts/human_gates.rb and may not change here. The divergence is
  # fail-CLOSED — `section_lines` ends the section EARLIER than `extract` does, so the sub-table scan
  # can only see FEWER lines, never more.
  H2_BOUNDARY = /\A#{INDENT}## /.freeze

  # A fenced code block's delimiter: 0-3 spaces, then a run of 3+ backticks or 3+ tildes, then the
  # rest of the line (an info string on an opener, whitespace only on a closer).
  #
  # FENCED CONTENT IS NEVER DATA. Without this, a ```` ```markdown ```` block illustrating how a host
  # should author its rows was parsed as the live declaration: the fenced `### Invocation paths`
  # bound as the anchor, its `Phantom` row entered the membership list, and — when the fence sat
  # ABOVE the settings table — the scan ran straight on through the real table and returned
  # `["Phantom", "Field", "Primary", "Fallback order"]`. A documentation example must not be able to
  # declare a reviewer (Reviewer finding, PR #119).
  FENCE = /\A#{INDENT}(`{3,}|~{3,})(.*)\z/.freeze

  # The Generic Baseline's shipped declaration, and the answer for any absent section/row. The floor
  # is the load-bearing one: absent everything, a run still stops rather than self-certifying.
  #
  # `primary` names a HARNESS ONLY, per ADR 0024's harness/model naming convention: the field's own
  # allowed-values cell says "any harness with a row in *Invocation paths*", and a harness+model
  # compound in a harness field is exactly the conflation that ADR forbids. This literal is mirrored
  # in PROJECT.md and the two must change together — `test_shipped_defaults_match_what_the_real_
  # project_md_declares` reddens on a half-edit.
  DEFAULTS = {
    primary: "Codex",
    fallback_order: "Copilot",
    bounded_window: "30m",
    degradation_floor: "stop-and-ask"
  }.freeze

  # `degradation_floor` allows exactly one value: a run that cannot obtain an independent review may
  # not certify itself, so no Host App can express "deliver unreviewed" (ADR 0026 decision 3). This is
  # the same class of hard-fail as `merge` in HumanGates::ALLOWED.
  #
  # `primary` and `fallback_order` are host-named identities, so they are unconstrained here — the
  # baseline cannot know a host's harness roster. `bounded_window` is shape-constrained instead of
  # value-constrained (see WINDOW).
  ALLOWED = { degradation_floor: %w[stop-and-ask].freeze }.freeze

  # The non-configurable floor, named so parity_check.rb can report a floor downgrade with its own
  # policy-boundary message rather than the generic allowed-values one.
  FLOOR_VALUE = "stop-and-ask"

  # A bounded window: a positive integer plus a unit. Zero is rejected — a zero window would make the
  # fallback fire before any reviewer could answer, silently disabling the primary.
  WINDOW = /\A[1-9]\d*[smh]\z/.freeze

  # First-cell labels that identify each field's row. Ordered longest-first within a shared prefix so
  # a `start_with?` match cannot mis-assign one label to another's row.
  ROW_LABELS = {
    primary: "Primary",
    fallback_order: "Fallback order",
    bounded_window: "Bounded window",
    degradation_floor: "Degradation floor"
  }.freeze

  # The header cell that names the value column, and the position assumed when no header names it.
  SETTING_HEADER = "setting"
  DEFAULT_SETTING_COLUMN = 1

  # The *Invocation paths* sub-table's own header contract, deliberately the same SHAPE as the
  # settings table's: bind the mechanism column BY HEADER, fall back to a position, never bind
  # column 0.
  #
  # COLUMN 0 IS THE HARNESS LABEL COLUMN BY CONTRACT, not by convention. `invocation_paths` reads the
  # harness name positionally (`cells[0]`), so what a host may reorder freely is every column AFTER
  # the first — the harness name must stay leftmost. Degradation is fail-CLOSED if it does not (the
  # row's real harness name is never seen, so a declared entry reads as unreachable and the chain
  # reddens), but it is a contract either way, and PROJECT.md -> *Invocation paths* states it where a
  # host authors its rows.
  SUMMONS_HEADER = "summons"
  DEFAULT_SUMMONS_COLUMN = 1

  # The cells that identify a row as this sub-table's HEADER, checked in ANY position. Position-blind
  # on purpose: `summons_column` refuses to bind column 0 (it is the harness LABEL column), so a host
  # table headed `| Summons | Harness |` gets no binding — and would then be read as a data row
  # declaring a harness called "Summons". Recognizing the header by its cells closes that.
  HEADER_CELLS = %w[harness summons].freeze

  # A cell declaring NO summons mechanism: empty, or dashes only. The shipped placeholder row uses
  # U+2014 (EM DASH), so an ASCII-hyphen-only rule would read `—` as a real mechanism and report the
  # placeholder harness as summonable. En dash is covered for the same reason.
  NO_SUMMONS = /\A[—–\-]+\z/.freeze

  # A markdown table separator row (`|---|:--:|`). Skipped structurally rather than relying on its
  # dashes tripping NO_SUMMONS, which would only hold while the separator is dashes in EVERY column.
  SEPARATOR_CELL = /\A:?-{2,}:?\z/.freeze

  # `none` is a SHAPE token in `fallback_order`, never a harness name: it is how a host declares "no
  # fallback at all". It is therefore never a chain entry — a `none` mixed in with real entries is a
  # malformed declaration reported by `invalid`, not a harness to look up.
  NONE = "none"

  BACKTICKED = /`([^`]+)`/.freeze

  module_function

  # Parse the Reviewer declaration out of PROJECT.md text. Deterministic; always returns a hash with
  # every key, defaulting any field the file does not author.
  def extract(text)
    fields = DEFAULTS.dup
    lines = text.to_s.lines.map(&:chomp)
    start = lines.index { |l| l.strip == SECTION }
    return fields unless start

    column = DEFAULT_SETTING_COLUMN
    authored = {}

    lines[(start + 1)..].each do |l|
      break if l.start_with?("## ") # the next H2 ends the section

      cells = table_cells(l)
      next if cells.nil?

      header = setting_column(cells)
      if header
        column = header # this table names its value column; rows below are read from it
        next
      end

      key = ROW_LABELS.keys.find { |k| labelled?(cells[0], ROW_LABELS[k]) }
      next unless key
      next if authored[key] # FIRST match wins - a later row never overrides the authored one

      authored[key] = true
      value = cells[column] && cells[column][BACKTICKED, 1]
      fields[key] = value.strip if value # a malformed cell leaves the shipped default in place

      break if authored.length == ROW_LABELS.length
    end
    fields
  end

  # The fields whose row was AUTHORED but whose setting cell carries no backticked token, as
  # { key => the raw cell text }. Empty when every authored cell is readable.
  #
  # This exists because `extract` alone cannot express the difference between "the host did not author
  # this field" (fail-SAFE: keep the shipped default, say nothing) and "the host authored it in a form
  # the parser cannot read" (a MISTAKE: keep the shipped default so nothing unsafe is adopted, but say
  # so loudly). Both leave the same value behind, so the distinction has to be reported separately.
  #
  # Without it the checker is blind in exactly the direction that matters: a PROJECT.md declaring
  # `| **Degradation floor** | deliver-unreviewed with a footnote |` - no backticks, which is precisely
  # the prose-where-a-value-belongs form that closed PR #109 - reads back as `stop-and-ask`, reports
  # nothing, and passes green, while the human-readable table the AC actually follows says the
  # opposite.
  #
  # WHAT COUNTS AS UNAUTHORED IS ROW ABSENCE, NOT AN EMPTY CELL. A labelled row that is PRESENT is a
  # host stating "this field is mine to set"; leaving its Setting cell blank is an unfinished edit,
  # not a decision to inherit the default. Treating blank as unauthored reproduced the same
  # machine-vs-agent disagreement this method exists to close - parity green while the table an agent
  # reads has no primary at all (Reviewer finding, PR #117). Absent rows never reach this loop, so
  # they remain silently defaulted, which is the behavior the vendored-host contract needs.
  def unreadable(text)
    bad = {}
    lines = text.to_s.lines.map(&:chomp)
    start = lines.index { |l| l.strip == SECTION }
    return bad unless start

    column = DEFAULT_SETTING_COLUMN
    seen = {}

    lines[(start + 1)..].each do |l|
      break if l.start_with?("## ")

      cells = table_cells(l)
      next if cells.nil?

      header = setting_column(cells)
      if header
        column = header
        next
      end

      key = ROW_LABELS.keys.find { |k| labelled?(cells[0], ROW_LABELS[k]) }
      next unless key
      next if seen[key] # FIRST match wins, mirroring extract

      seen[key] = true
      cell = cells[column].to_s.strip
      bad[key] = cell unless cell.match?(BACKTICKED)

      break if seen.length == ROW_LABELS.length
    end
    bad
  end

  # The fields whose SETTING cell offers MORE THAN ONE backticked span, as { key => the raw cell }.
  # Empty when every authored cell offers the parser exactly one candidate value.
  #
  # A DISTINCT fault from `unreadable`, and one no other seam can see. `extract` reads the FIRST
  # backticked span and stops, so a host authoring a list ONE CODE SPAN PER ELEMENT —
  # `` `Copilot`, `Gemini` ``, which is exactly the convention PROJECT.md -> Branch & PR Policy
  # already uses for its protected-branch list — silently loses every span after the first, and all
  # four existing seams stay quiet about it:
  #   - `unreadable` is satisfied by ANY backtick in the cell, so the cell reads as well-formed
  #   - `invalid` validates only the TRUNCATED value, so `` `Copilot`, `Codex` `` under a `Codex`
  #     primary passes the self-reference invariant that the table visibly violates
  #   - `chain` never contains the dropped entry, so `unsummonable` never looks it up
  #
  # REPORTED RATHER THAN RE-PARSED, deliberately. Reading past the first span would mean changing
  # `extract`, whose table contract is kept byte-identical with scripts/human_gates.rb; and guessing
  # which reading the host meant is the coercion this file refuses everywhere else. The parser keeps
  # its rule and the host is told LOUDLY that the checker read something narrower than the table
  # shows. The fix is authoring the whole value inside ONE pair of backticks (`` `Copilot, Gemini` ``),
  # which every seam above then reads correctly.
  def ambiguous(text)
    authored_setting_cells(text).select { |_key, cell| cell.scan(BACKTICKED).length > 1 }
  end

  # Every AUTHORED field row's SETTING cell, as { key => the raw cell text }, resolved by the SAME
  # rules `extract` and `unreadable` use: the section ends at the next `## `, a header naming
  # "Setting" binds the value column (falling back to DEFAULT_SETTING_COLUMN), and the FIRST row
  # matching a label wins.
  #
  # NEW and additive: it DUPLICATES that scan rather than being refactored out of `extract` /
  # `unreadable`, because those two bodies are kept identical in contract with scripts/human_gates.rb,
  # which ships no such seam. The duplication is the price of that guarantee, and the three are held
  # in step by test_ambiguous_resolves_the_same_row_extract_does.
  #
  # It deliberately does NOT carry its siblings' `break` on a complete field set. There that break is
  # defence in depth beside the first-match-wins guard; here it would be a branch no test can kill —
  # `next if cells_by_key.key?(key)` already makes a later row unable to change the answer, and the
  # `## ` break already ends the section — while doing the one thing rules/testing.md:23 names, which
  # is letting a realistic fixture exit the loop before the case under test is reached.
  def authored_setting_cells(text)
    cells_by_key = {}
    lines = text.to_s.lines.map(&:chomp)
    start = lines.index { |l| l.strip == SECTION }
    return cells_by_key unless start

    column = DEFAULT_SETTING_COLUMN

    lines[(start + 1)..].each do |l|
      break if l.start_with?("## ")

      cells = table_cells(l)
      next if cells.nil?

      header = setting_column(cells)
      if header
        column = header
        next
      end

      key = ROW_LABELS.keys.find { |k| labelled?(cells[0], ROW_LABELS[k]) }
      next unless key
      next if cells_by_key.key?(key) # FIRST match wins, mirroring extract and unreadable

      cells_by_key[key] = cells[column].to_s.strip
    end
    cells_by_key
  end

  # True when the host AUTHORED a `## Reviewer` section at all, as opposed to inheriting the shipped
  # defaults from its absence. `extract` cannot express this difference — it answers with DEFAULTS
  # either way — and the difference is the whole vendored-host compatibility contract: an absent
  # section is a PROJECT.md that predates the feature (silently defaulted, never an error), while an
  # authored one is a host stating "this chain is mine", where an incomplete declaration IS a mistake
  # worth reporting. Every incompleteness check is gated on this.
  def section?(text)
    text.to_s.lines.any? { |l| l.chomp.strip == SECTION }
  end

  # The BODY of the `## Reviewer` section: every line between its H2 and the next `## `, in order.
  # Empty when the section is absent. The section boundary is the same one `extract` and `unreadable`
  # walk inline; this returns it so `invocation_paths` can look for its H3 INSIDE the section rather
  # than anywhere in the file.
  # FENCE-AWARE at its boundary: a `## `-looking line INSIDE a fenced code block is illustration, not
  # the next section, so it does not end the body. The section START anchor is deliberately left as
  # the shared `l.strip == SECTION` idiom `extract` and `section?` use — a fence opened ABOVE
  # `## Reviewer` is a pre-existing, SHARED weakness of those two readers, not one this seam may
  # silently diverge on (recorded for follow-up, PR #119).
  def section_lines(text)
    lines = text.to_s.lines.map(&:chomp)
    start = lines.index { |l| l.strip == SECTION }
    return [] unless start

    body = lines[(start + 1)..]
    fenced = fenced_mask(body)
    body.each_with_index.take_while { |l, i| fenced[i] || !l.match?(H2_BOUNDARY) }.map(&:first)
  end

  # Which of `lines` are fenced-code-block lines — the delimiters themselves included — as a parallel
  # array of booleans. Fence state starts fresh at index 0, so the mask of a PREFIX of `lines` is the
  # matching prefix of this mask; `invocation_paths` relies on that to re-derive the mask over the
  # section body `section_lines` already truncated.
  #
  # Follows CommonMark closely enough for the hazard: a closer must use the SAME character as its
  # opener, be at least as LONG, and carry nothing but whitespace after it — so ```` ``` ```` inside a
  # ```` ~~~~ ```` block does not close it, and a ```` ```ruby ```` line is an opener rather than a
  # closer. A backtick opener may not carry a backtick in its info string (CommonMark forbids it), or
  # an inline-code span on a prose line would open a phantom block and swallow the rest of the
  # section. An UNCLOSED fence masks to the end, which is the fail-CLOSED direction: unparsed, never
  # mis-parsed.
  def fenced_mask(lines)
    open_char = nil
    open_len = 0

    lines.map do |line|
      m = line.match(FENCE)
      if open_char
        # Inside a block: only a matching, long-enough, bare closer ends it.
        open_char = nil if m && m[1][0] == open_char && m[1].length >= open_len && m[2].strip.empty?
        true
      elsif m && !(m[1][0] == "`" && m[2].include?("`"))
        open_char = m[1][0]
        open_len = m[1].length
        true
      else
        false
      end
    end
  end

  # The harness names that declare a summons mechanism in `### Invocation paths`, in table order.
  # Empty when the sub-section is absent — which, for an AUTHORED section, means no chain entry is
  # reachable at all, not that every entry is fine.
  #
  # SCOPED TO `## Reviewer` FIRST, then anchored on the H3 WITHIN it. Both halves are load-bearing,
  # in opposite directions:
  #   - Scoping is what makes the sub-table BELONG to this section. A file-global search for the H3
  #     binds the FIRST heading of that name ANYWHERE in PROJECT.md, under any H2 or none — so a host
  #     whose `## Reviewer` carries no sub-table at all ships GREEN off a decoy H3 elsewhere in the
  #     file (the exact #118 state this check exists to close), and the converse decoy reports a
  #     genuine, fully-declared chain unreachable.
  #   - Anchoring on the H3, rather than walking the whole H2 body, is what keeps the SETTINGS table
  #     out. It sits above this one in the shipped file, so a scan of the section wholesale would
  #     return `Primary`/`Fallback order` as if they were harnesses.
  # The scan then ends at the next heading of ANY level (see HEADING).
  #
  # Splits its rows with the reviewer-only `invocation_cells` and touches none of `extract`/
  # `unreadable`/`table_cells`/`labelled?`/`setting_column`, whose table contract is kept
  # byte-identical with scripts/human_gates.rb.
  #
  # FENCE-AWARE end to end. The anchor is only bound OUTSIDE a fenced block, and fenced lines are
  # neither headings nor data rows, so a ```` ```markdown ```` example showing a host how to author
  # this very table cannot declare a harness.
  def invocation_paths(text)
    found = []
    body = section_lines(text)
    fenced = fenced_mask(body)
    start = body.each_index.find { |i| !fenced[i] && invocation_heading?(body[i]) }
    return found unless start

    column = DEFAULT_SUMMONS_COLUMN

    body[(start + 1)..].each_with_index do |l, offset|
      next if fenced[start + 1 + offset] # illustration inside a code fence, never a heading or a row

      break if l.match?(HEADING) # the next heading of ANY level ends the sub-section

      cells = invocation_cells(l)
      next if cells.nil?
      next if cells.all? { |c| c.match?(SEPARATOR_CELL) } # the `|---|---|` separator row

      header = summons_column(cells)
      if header
        column = header # this table names its Summons column; rows below are read from it
        next
      end
      next if header_row?(cells) # a header row no `Summons` cell could bind (see HEADER_CELLS)

      # Returned AS AUTHORED (emphasis stripped, trimmed) rather than folded, so a caller reporting
      # one names it the way the host wrote it. Case folding happens at comparison time.
      harness = cells[0].to_s.gsub(/[*`]/, "").strip
      # A BLANK harness cell is skipped. Under the prefix matching this seam originally shipped this
      # was load-bearing rather than tidiness - `"anything".start_with?("")` is TRUE, so one
      # half-finished row made every chain entry look summonable and silenced the entire check while
      # the parity gate stayed green. Exact matching (see `unsummonable`) defangs that, but the skip
      # stays: the membership list is a public answer, and a `""` in it is wrong whoever reads it.
      next if harness.empty?
      next if no_summons?(cells[column])

      found << harness
    end
    found
  end

  # The reviewer chain in the order it is tried: the primary, then each `fallback_order` element.
  # Blank elements and the `none` shape token are dropped — both are malformed-or-empty DECLARATIONS
  # reported by `invalid`, not harnesses anyone could summon, and re-reporting them as unreachable
  # would name the same defect twice under a message that misdescribes it.
  def chain(fields)
    entries = []
    primary = fields[:primary].to_s.strip
    entries << primary unless primary.empty?
    entries.concat(fallback_entries(fields[:fallback_order]))
  end

  # The reviewer chain with the ACTING harness removed — the independent-review chain an AC may
  # actually summon (issue #139 / ADR 0032). An AC is never its own independent backstop: a same-model
  # review that *appears* to run is worse than none, so the harness a run is executing AS is filtered
  # out of `chain` before any summons. `acting` is the caller's runtime-actual harness identity.
  #
  # FAIL CLOSED on an UNKNOWN actor. A nil/blank identity — a run that cannot name the harness it is
  # executing AS — returns an EMPTY chain, not the full one: if the actor is unknown, independence from
  # it cannot be proven, so no entry may be summoned as an independent backstop. `verify` reads the empty
  # result as an exhausted chain and applies the non-configurable `stop-and-ask` floor, exactly as the
  # floor treats "cannot obtain an independent review". Returning the full chain here would fail OPEN — a
  # run whose identity detection broke could summon its own primary and self-review (Codex review,
  # PR #140). This empty-actor branch is load-bearing and test-pinned, NOT the redundant guard an earlier
  # revision removed: there a blank actor matched no entry and changed nothing; here it changes the
  # result from the full chain to none.
  #
  # MATCHING IS EXACT on the normalized name — emphasis/backticks stripped, trimmed, casefolded, then
  # `==` (via `plain`) — the SAME rule `unsummonable` uses, and for the same reason: a `start_with?`
  # rule would let a lone `Codex` actor drop a distinct `Codex Cloud` entry, or miss it entirely.
  #
  # This is the RUNTIME sibling of `invalid`'s `fallback_order_self_reference` invariant (a file that
  # names its primary as a fallback) and shares that invariant's honest limitation: it is
  # HARNESS-level, so a model-qualified restatement of the same harness (`Codex (GPT-5)` acting against
  # a bare `Codex` entry) escapes it — ADR 0027 decision 7 records why the model-level requirement is
  # unverifiable from a static declaration. An EMPTY result means the whole chain was the acting
  # harness; `verify` then reads that as an exhausted chain and applies the non-configurable
  # `stop-and-ask` floor, so an empty return must never be mistaken for "reachable".
  def independent_chain(fields, acting:)
    return [] if acting.to_s.strip.empty?

    chain(fields).reject { |entry| plain(entry) == plain(acting) }
  end

  # The fields whose value is outside their allowed set (or malformed), as { key => value }. Empty
  # when all are valid. Separated from `extract` so an unknown value is REPORTED rather than coerced.
  #
  # Each chain-SHAPE fault gets its OWN key rather than a shared `:fallback_order` one. That is not
  # cosmetic: the issue's own repro `none, , Nope` satisfies two predicates at once, so a single key
  # would let either branch be deleted with the other still setting it - two mutants, both unkillable
  # (the rules/testing.md:23 trap). Distinct keys are what make each branch separately provable.
  def invalid(fields)
    bad = {}
    fields.each do |key, value|
      allowed = ALLOWED[key]
      bad[key] = value if allowed && !allowed.include?(value)
    end
    window = fields[:bounded_window]
    bad[:bounded_window] = window unless window.to_s.match?(WINDOW)

    primary = fields[:primary].to_s.strip
    bad[:primary_blank] = fields[:primary].to_s if primary.empty?

    raw = fields[:fallback_order].to_s
    # `split(",", -1)` KEEPS a trailing empty element: Ruby's default drops it, so `Copilot,` - an
    # edit abandoned mid-word - would otherwise read as a clean single-entry fallback.
    parts = raw.split(",", -1).map(&:strip)
    # THE BLANK-ELEMENT CHECK IS UNGATED, and `raw.strip.empty?` is a separate disjunct rather than
    # redundant with it. Ruby's `"".split(",", -1)` returns `[]` - no element at all - so a WHOLLY
    # blank `fallback_order` (reachable through the real parse as a whitespace-only backtick pair)
    # has nothing for `any?(&:empty?)` to see. Under the old `parts.length > 1` gate it was reported
    # by NOTHING: `unreadable` is satisfied by the backticks, `extract` yields "", and the fallback
    # simply vanished from the chain - while `Copilot,` , which still yields a WORKING one-entry
    # chain, was flagged. That is backwards, and the ungated check is what makes the two agree.
    #
    # `parts.length > 1` survives on the none-mixed branch only, where it is load-bearing: `none`
    # ALONE is the legal way to declare no fallback, so the predicate must not fire on it.
    bad[:fallback_order_blank_element] = raw if raw.strip.empty? || parts.any?(&:empty?)
    bad[:fallback_order_none_mixed] = raw if parts.length > 1 && parts.any? { |p| p.downcase == NONE }

    # A chain that falls back to its own primary is not a fallback. This is the machine-checkable
    # SHADOW of the independence requirement, not the requirement itself: it catches the same-harness
    # case only, and a model-qualified restatement of the same harness escapes it (see `unsummonable`
    # for the matching-rule limitation this shares). ADR 0027 records why the rest is unverifiable.
    #
    # Compared through `plain`, not `downcase`: `unsummonable` already compares that way, and a raw
    # `downcase` left the two seams disagreeing about the same string. A fallback authored as
    # `` `**Copilot**` `` under a `Copilot` primary is a chain that falls back to itself, yet emphasis
    # alone made BOTH seams silent - `invalid` saw "**copilot**" != "copilot", and `unsummonable`
    # (which strips the emphasis) found a matching row and reported nothing.
    unless primary.empty?
      repeat = fallback_entries(raw).any? { |e| plain(e) == plain(primary) }
      bad[:fallback_order_self_reference] = primary if repeat
    end

    bad
  end

  # The chain entries with NO row in `### Invocation paths` — the entries an AC has no mechanism to
  # summon, in chain order. Empty when every entry is reachable.
  #
  # A separate seam from `invalid` because it needs the raw `text`, not the extracted `fields`,
  # exactly as `unreadable` is separate for the same reason.
  #
  # SILENT when the section is absent: a vendored PROJECT.md that predates the feature must keep
  # parsing to the shipped defaults and stay green (the same contract that keeps `## Reviewer` out of
  # REQUIRED_PROJECT_SECTIONS). An AUTHORED section with no sub-table is the opposite case - a host
  # claiming the chain and leaving it unreachable - and reports every entry.
  #
  # MATCHING IS EXACT on the normalized name — emphasis and backticks stripped, trimmed, casefolded,
  # then `==`. It was `entry.start_with?(harness)`, borrowed from `labelled?`, and that prefix rule
  # broke the authored contract in both directions at once. A lone `Codex` row satisfied a
  # `Codex Cloud` fallback: read as DISTINCT harnesses the fallback has no mechanism, read as the SAME
  # harness the chain falls back to itself — and neither `unsummonable` nor `invalid`'s self-reference
  # check said a word, so a chain nobody could run shipped green (Reviewer finding, PR #119).
  #
  # `labelled?` IS LEFT ALONE, deliberately, and this is not the shared-contract exception it looks
  # like: descriptive setting-row LABELS and harness IDENTITIES are different grammars. `labelled?`
  # matches a row whose first cell is prose around a field name (`**Primary** — summoned first`), where
  # a prefix rule is the point; a harness name is an identity, where a prefix rule is a collision. The
  # reviewer.rb <-> human_gates.rb table contract covers the former and has nothing to say about the
  # latter, so tightening here needs no change there.
  #
  # The cost is that a model-qualified entry (`Codex (GPT-5)`) no longer resolves to its bare `Codex`
  # row. That is the correct reading, not a regression: *Primary*'s own allowed-values cell says "any
  # harness with a row in *Invocation paths*", and ADR 0027 decision 7 already amended the field to
  # name a HARNESS ONLY for exactly this reason. Such an entry is now reported, and the report names
  # the fix (write the bare harness, or add a row).
  def unsummonable(text)
    return [] unless section?(text)

    declared = invocation_paths(text).map { |harness| plain(harness) }
    chain(extract(text)).reject { |entry| declared.include?(plain(entry)) }
  end

  def from_file(path)
    extract(File.read(path, encoding: "UTF-8"))
  end

  # Split a markdown table row into its trimmed cells, or nil when the line is not a data row (the
  # `|---|---|` separator has no letters in its first cell, so `labelled?` rejects it anyway).
  def table_cells(line)
    stripped = line.strip
    return nil unless stripped.start_with?("|")

    cells = stripped.sub(/\A\|/, "").sub(/\|\z/, "").split("|").map(&:strip)
    cells.length >= 2 ? cells : nil
  end

  # The index of this row's `Setting` header cell, or nil when the row is not a header naming it. A
  # header row is what binds the value column, so a host may reorder the table's columns freely.
  #
  # Column 0 is NEVER bindable: it is the LABEL column that `labelled?` matches rows on, so a value
  # can never live there. Without this guard a host table headed `| Setting | Value |` binds column 0
  # and every field then reads its own label instead of its setting - which silently discards all four
  # host values and hands the checker the shipped defaults, so the non-configurable floor's hard-fail
  # cannot fire on a downgrade that is plainly visible in the file (Reviewer finding, PR #117).
  def setting_column(cells)
    idx = cells.index { |c| c.gsub(/[*`]/, "").strip.downcase == SETTING_HEADER }
    idx&.positive? ? idx : nil
  end

  # True when a row's first cell names this field — emphasis/backticks stripped, case-insensitive.
  def labelled?(cell, label)
    cell.gsub(/[*`]/, "").strip.downcase.start_with?(label.downcase)
  end

  # --- Invocation-paths helpers. NEW and independent: none of the five helpers above is touched, so
  # --- the reviewer.rb <-> human_gates.rb table contract stays byte-identical.

  # True when this line is the `### Invocation paths` anchor. 0-3 leading spaces, per CommonMark and
  # per HEADING/H2_BOUNDARY: a line indented FOUR or more is an indented code block, and binding the
  # anchor to one would reopen the same illustration-as-declaration hole the fence rule closes — with
  # the fence gone, an indented example is the remaining way to write a fake sub-table. Not bound at
  # all ⇒ no membership list ⇒ every entry of an authored chain reports unreachable, which is the
  # fail-CLOSED direction.
  def invocation_heading?(line)
    line.match?(/\A#{INDENT}\S/) && line.strip == INVOCATION_SECTION
  end

  # `table_cells` for the invocation sub-table ONLY, differing in exactly two ways — and NEW rather
  # than a change to `table_cells`, because that helper's contract is byte-identical with
  # scripts/human_gates.rb and may not move (see this file's header).
  #
  #   1. AN ESCAPED PIPE IS CONTENT, NOT A DELIMITER. `\|` is how GFM writes a literal `|` inside a
  #      cell, and splitting on it shifted every later cell one position left: a legal Check cell such
  #      as ``run `printf ok \| grep ok` `` pushed a fragment into the bound Summons index, so the row's
  #      real em-dash Summons cell was never read and a placeholder harness reported as REACHABLE
  #      (Reviewer finding, PR #119). The escape is restored as the literal `|` GFM renders.
  #   2. A ROW INDENTED FOUR OR MORE SPACES IS NOT A ROW. Same CommonMark rule as `invocation_heading?`
  #      above; keeping the two consistent is what stops a `  #### Notes` heading being skipped as
  #      code while the table under it is still read as data.
  #
  # Returns nil when the line is not a data row, matching `table_cells`.
  #
  # The split is a NEGATIVE LOOKBEHIND for the escaping backslash rather than a placeholder
  # substitution, so no sentinel character is ever introduced into cell text.
  #
  # `table_cells` strips the TRAILING `|` before splitting; this does not, and needs no equivalent.
  # Ruby's `split` already drops trailing EMPTY fields, so `| A | B |` yields the same two cells
  # either way — while a row whose last cell ENDS in an escaped pipe (`| A | B \|`, the trailing
  # delimiter omitted as GFM allows) keeps that pipe instead of losing it to the strip. Dropping the
  # step is what keeps this branch-for-branch testable rather than adding a guard no fixture can kill.
  UNESCAPED_PIPE = /(?<!\\)\|/.freeze

  def invocation_cells(line)
    return nil unless line.match?(/\A#{INDENT}\S/)

    stripped = line.strip
    return nil unless stripped.start_with?("|")

    cells = stripped.sub(/\A\|/, "")
                    .split(UNESCAPED_PIPE)
                    .map { |c| c.gsub("\\|", "|").strip }
    cells.length >= 2 ? cells : nil
  end

  # The index of this row's `Summons` header cell, or nil when the row is not a header naming it.
  # Mirrors `setting_column` deliberately, including its column-0 guard: column 0 is the HARNESS label
  # column, so binding it would make every row read its own name as its mechanism and report the whole
  # chain summonable. PROJECT.md openly invites hosts to rewrite these rows, so a positional read
  # would misparse a host table headed `| Harness | Precondition | Summons | Check |` and report an
  # entire working chain unreachable.
  def summons_column(cells)
    idx = cells.index { |c| plain(c) == SUMMONS_HEADER }
    idx&.positive? ? idx : nil
  end

  # True when this row is the sub-table's header rather than a harness row.
  def header_row?(cells)
    cells.any? { |c| HEADER_CELLS.include?(plain(c)) }
  end

  # True when a Summons cell declares no mechanism: absent, or a dash placeholder.
  def no_summons?(cell)
    text = cell.to_s.gsub(/[*`]/, "").strip
    text.empty? || text.match?(NO_SUMMONS)
  end

  # A cell reduced to its comparable text: emphasis and backticks stripped, trimmed, downcased.
  def plain(cell)
    cell.to_s.gsub(/[*`]/, "").strip.downcase
  end

  # `fallback_order` split into the harnesses it actually names — see `chain` for why `none` and
  # blank elements are not among them.
  def fallback_entries(value)
    value.to_s.split(",", -1).map(&:strip).reject { |e| e.empty? || e.downcase == NONE }
  end
end
