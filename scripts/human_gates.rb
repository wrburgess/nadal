# frozen_string_literal: true

# human_gates.rb — the ONE place that derives the human-gate policy from PROJECT.md (issue #94 /
# ADR 0025). PROJECT.md is the single authored source; `scripts/parity_check.rb` validates what this
# returns. Parsing lives here so it is unit-tested once and reused, mirroring
# `scripts/protected_branches.rb` (the protected-branch value, ADR 0009).
#
# Dependency-free: Ruby standard library only, mirroring scripts/parity_check.rb (ADR 0008).
#
# Contract with PROJECT.md -> "## Human Gates":
#   - the settings are authored as a markdown table between that H2 and the next line starting `## `
#   - a row is identified by its FIRST cell starting with the gate's label ("Plan approval", "Merge"),
#     ignoring markdown emphasis
#   - the FIRST row matching a gate is that gate's authored setting; later matching rows are ignored.
#     This mirrors `protected_branches.rb`, which breaks on the first matching line, and it is what
#     makes the parse fail-SAFE: a second gate-shaped row later in the section (an illustrative
#     example, a copy/paste leftover) can never override the authored one.
#   - the value is the first `backticked` token in that row's SETTING cell, located by the header cell
#     named "Setting" and falling back to the SECOND cell when no header names it. Only that one cell
#     is read, so the "Allowed values" cell and any backticked prose elsewhere in the section can never
#     be mistaken for the setting, and reordering the table's columns does not silently change the
#     parse.
#
# Fail-SAFE, not fail-closed: when the section (or a row) is absent, the SHIPPED DEFAULT is returned
# rather than [] or nil. The section is additive — an already-vendored Host App whose PROJECT.md
# predates it must keep parsing to the strict baseline policy and stay green, which is exactly why the
# heading is deliberately NOT in the parity check's REQUIRED_PROJECT_SECTIONS.
#
# Values are returned VERBATIM: an unknown value is never coerced to a default, so a typo surfaces as
# an invalid value (see `invalid`) instead of silently reading as the strict policy.

module HumanGates
  SECTION = "## Human Gates"

  # The Generic Baseline's strict policy, and the answer for any absent section/row.
  DEFAULTS = { plan_approval: "required", merge: "required" }.freeze

  # `merge` allows exactly one value: no Host App may express self-merge (ADR 0025).
  ALLOWED = { plan_approval: %w[required auto].freeze, merge: %w[required].freeze }.freeze

  # First-cell labels that identify each gate's row.
  ROW_LABELS = { plan_approval: "Plan approval", merge: "Merge" }.freeze

  # The header cell that names the value column, and the position assumed when no header names it.
  SETTING_HEADER = "setting"
  DEFAULT_SETTING_COLUMN = 1

  BACKTICKED = /`([^`]+)`/.freeze

  module_function

  # Parse the human-gate settings out of PROJECT.md text. Deterministic; always returns a hash with
  # both keys, defaulting any gate the file does not author.
  def extract(text)
    gates = DEFAULTS.dup
    lines = text.to_s.lines.map(&:chomp)
    start = lines.index { |l| l.strip == SECTION }
    return gates unless start

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
      gates[key] = value.strip if value # a malformed cell leaves the shipped default in place

      break if authored.length == ROW_LABELS.length
    end
    gates
  end

  # The gates whose value is outside their allowed set, as { key => value }. Empty when all are valid.
  # Separated from `extract` so an unknown value is REPORTED rather than coerced.
  def invalid(gates)
    gates.each_with_object({}) do |(key, value), bad|
      allowed = ALLOWED[key]
      bad[key] = value unless allowed.nil? || allowed.include?(value)
    end
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
  def setting_column(cells)
    cells.index { |c| c.gsub(/[*`]/, "").strip.downcase == SETTING_HEADER }
  end

  # True when a row's first cell names this gate — emphasis/backticks stripped, case-insensitive.
  def labelled?(cell, label)
    cell.gsub(/[*`]/, "").strip.downcase.start_with?(label.downcase)
  end
end
