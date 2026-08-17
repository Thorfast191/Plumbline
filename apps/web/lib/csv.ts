// Minimal CSV serialization — RFC 4180 quoting (quote fields containing a
// comma, quote, or newline; double up embedded quotes). No dependency: the
// escaping rules are a handful of lines and don't warrant one.
function escapeCell(value: string): string {
  if (/[",\n]/.test(value)) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

export function toCsv(headers: string[], rows: string[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(escapeCell).join(","));
  return lines.join("\r\n") + "\r\n";
}

/** Splits one already-unquoted-or-simple CSV line back into cells — used only by tests, not a general CSV parser. */
export function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let j = i + 1;
      let value = "";
      while (j < line.length) {
        if (line[j] === '"' && line[j + 1] === '"') {
          value += '"';
          j += 2;
        } else if (line[j] === '"') {
          break;
        } else {
          value += line[j];
          j += 1;
        }
      }
      cells.push(value);
      i = j + 2; // skip closing quote + comma
    } else {
      const next = line.indexOf(",", i);
      if (next === -1) {
        cells.push(line.slice(i));
        i = line.length + 1;
      } else {
        cells.push(line.slice(i, next));
        i = next + 1;
      }
    }
  }
  return cells;
}
