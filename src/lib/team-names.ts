// Team-name matching, shared by the server and the phone (no database here).

/** "Null Pointers" → "nullpointers" (letters and digits only, any script). */
export function teamKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Two team names that are probably the same team ("Null Pointer" / "null pointers" / "NullPointers"). */
export function similarTeam(a: string, b: string): boolean {
  const x = teamKey(a);
  const y = teamKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const short = Math.min(x.length, y.length);
  if (short >= 4 && (x.includes(y) || y.includes(x))) return true;
  return levenshtein(x, y) <= (short >= 8 ? 2 : short >= 4 ? 1 : 0);
}

/** A person's name vs a name typed on the team sheet: same words, or nearly ("Mohamed Ben Ali" / "mohamed benali"). */
export function similarPerson(a: string, b: string): boolean {
  const x = teamKey(a);
  const y = teamKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const short = Math.min(x.length, y.length);
  return short >= 6 && levenshtein(x, y) <= 2;
}
