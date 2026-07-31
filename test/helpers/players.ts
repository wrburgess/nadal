// Issue #32, Testing Strategy suite C/D: a programmatic builder for a corpus of players with
// controlled name shapes, per rules/testing.md ("never build tests on schema-coupled static test
// data"). Used to construct enough distinct canonical names that a length-banded fuzzy search has
// something real to narrow against, without hand-maintaining a static fixture list.

const FIRST_NAMES = [
  "Nova", "Rowan", "Kai", "Blake", "Lane", "Casey", "Orin", "Marek", "Avery", "Zephyr",
  "Harper", "Juniper", "Delaney", "Ellis", "Emory", "Ira", "Yuma", "Hollis", "Élodie", "Ünwin",
];

const LAST_NAMES = [
  "Norbury", "Rushworth", "Kestrel", "Bramwell", "Linfield", "Calder", "Oakhurst", "Melbourne",
  "Ashby", "Zellman", "Halloway", "Jarrow", "Duxbury", "Eastwick", "Ellerby", "Inglewood",
  "Yarrowby", "Hartwell", "Ünwin", "Örström",
];

/**
 * ~60 distinct canonical names: every first name paired with three different last names (rotated
 * offsets, so no two players share a full name), plus a handful of 2-3 character short names and a
 * couple of unusually long ones — the short/long extremes named explicitly because a length band
 * behaves differently at each end (proportionally widest for a short name, narrowest for a long
 * one). Deterministic (no `Math.random()`), so a failing case reproduces exactly on every run.
 */
export function buildNamePool(): string[] {
  const names = new Set<string>();
  for (let i = 0; i < FIRST_NAMES.length; i++) {
    for (const offset of [0, 1, 2]) {
      const last = LAST_NAMES[(i + offset) % LAST_NAMES.length];
      names.add(`${FIRST_NAMES[i]} ${last}`);
    }
  }

  const shortNames = ["Al", "Bo", "Cy", "Ann", "Ben", "Coe", "Élo"];
  const longNames = [
    "Alexandria Montgomery Fitzgerald",
    "Bartholomew Winterbourne Ashcombe",
    "Persimmon Featherstonehaugh Aldergrove",
  ];
  for (const name of [...shortNames, ...longNames]) names.add(name);

  return Array.from(names);
}
